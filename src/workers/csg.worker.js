/**
 * CSG worker entry point.
 *
 * Runs the untouched upstream `Evaluator` off the main thread. This is the
 * implementation behind the empty `AsyncEvaluator` / `Pool` stubs that shipped
 * in three-bvh-csg (upstream roadmap item "Worker Support", issue #14).
 *
 * Two caches keep interactive editing responsive:
 *
 *  1. `brushCache`  – id -> Brush, keyed by fingerprint. A node whose parameters
 *     did not change never re-uploads its geometry.
 *  2. `stageCache`  – prefix results of the modifier chain. Editing the last
 *     modifier of an N-node chain costs one CSG evaluation instead of N.
 */
import { Evaluator } from '../core/Evaluator.js';
import { Brush } from '../core/Brush.js';
import { BufferGeometry, BoxGeometry, SphereGeometry } from 'three';
import { SUBTRACTION } from '../core/constants.js';
import {
	MESSAGE_TYPE,
	deserializeBrush,
	serializeBrush,
	collectTransferables,
	countTriangles,
} from './protocol.js';

/** @type {Map<string, { fingerprint: number, brush: Brush }>} */
const brushCache = new Map();

/** Prefix cache: the result brush after evaluating nodes[0..i]. */
let chainCache = {
	entries: [],
	stages: [],
};

const evaluator = new Evaluator();

function now() {

	return ( typeof performance !== 'undefined' ? performance : Date ).now();

}

function resolveBrush( node ) {

	const cached = brushCache.get( node.id );
	if ( cached && cached.fingerprint === node.fingerprint ) {

		return cached.brush;

	}

	// No payload means "you already have the newest version" — only trust the
	// cache when the fingerprint actually matches.
	if ( ! node.data ) {

		if ( cached ) {

			cached.fingerprint = node.fingerprint;
			return cached.brush;

		}

		throw new Error( `csg.worker: node "${ node.id }" has no payload and no cached brush.` );

	}

	const brush = deserializeBrush( node.data );
	brushCache.set( node.id, { fingerprint: node.fingerprint, brush } );
	return brush;

}

function makeTarget() {

	const geometry = new BufferGeometry();
	const brush = new Brush( geometry );
	return brush;

}

function findCommonPrefix( entries, nodes ) {

	let i = 0;
	const limit = Math.min( entries.length, nodes.length );
	while ( i < limit ) {

		if ( entries[ i ].id !== nodes[ i ].id || entries[ i ].fingerprint !== nodes[ i ].fingerprint ) {

			break;

		}

		i ++;

	}

	return i;

}

function evaluateChain( nodes, ops ) {

	const start = now();
	const common = findCommonPrefix( chainCache.entries, nodes );

	// Drop cached stages that are no longer valid.
	chainCache.entries.length = common;
	chainCache.stages.length = common;

	// Resolve every brush up front so deserialisation cost is separable from
	// solve cost in the stats — the workbench HUD reports both.
	const brushes = nodes.map( resolveBrush );
	const afterResolve = now();

	let result = common > 0 ? chainCache.stages[ common - 1 ] : null;
	let evaluated = 0;

	for ( let i = common; i < nodes.length; i ++ ) {

		const node = nodes[ i ];
		const brush = brushes[ i ];

		if ( i === 0 ) {

			result = brush;

		} else {

			const target = makeTarget();
			result = evaluator.evaluate( result, brush, ops[ i ], target );
			evaluated ++;

		}

		chainCache.entries[ i ] = { id: node.id, fingerprint: node.fingerprint };
		chainCache.stages[ i ] = result;

	}

	if ( ! result ) {

		throw new Error( 'csg.worker: empty node chain.' );

	}

	const end = now();

	return {
		brush: result,
		stats: {
			totalMs: end - start,
			resolveMs: afterResolve - start,
			solveMs: end - afterResolve,
			evaluations: evaluated,
			reusedStages: common,
			triangles: countTriangles( result.geometry ),
		},
	};

}

function handleEvaluate( message ) {

	if ( message.options ) {

		if ( typeof message.options.useCDTClipping === 'boolean' ) {

			evaluator.useCDTClipping = message.options.useCDTClipping;

		}

		if ( Array.isArray( message.options.attributes ) ) {

			evaluator.attributes = message.options.attributes;

		}

		if ( typeof message.options.useGroups === 'boolean' ) {

			evaluator.useGroups = message.options.useGroups;

		}

	}

	const { brush, stats } = evaluateChain( message.nodes, message.ops );
	const payload = serializeBrush( brush );
	const transfer = collectTransferables( payload.geometry );

	self.postMessage( {
		type: MESSAGE_TYPE.RESULT,
		id: message.id,
		brush: payload,
		stats,
	}, transfer );

}

self.onmessage = event => {

	const message = event.data;
	if ( ! message || ! message.type ) return;

	try {

		switch ( message.type ) {

			case MESSAGE_TYPE.EVALUATE:
				handleEvaluate( message );
				break;

			case 'csg-reset':
				brushCache.clear();
				chainCache = { entries: [], stages: [] };
				evaluator.reset();
				self.postMessage( { type: MESSAGE_TYPE.ACK, id: message.id } );
				break;

			case 'csg-cpu-probe': {

				// Pure integer throughput probe. Benchmarks compare this against the
				// same loop on the main thread to separate "the worker is slow" from
				// "the solve is slow".
				const started = now();
				let hash = 0x811c9dc5;
				for ( let i = 0; i < message.iterations; i ++ ) {

					hash = Math.imul( hash ^ i, 0x01000193 ) >>> 0;

				}

				self.postMessage( {
					type: MESSAGE_TYPE.RESULT,
					id: message.id,
					brush: null,
					stats: { cpuMs: now() - started, hash },
				} );
				break;

			}

			case 'csg-solve-probe': {

				// Fixed synthetic workload, identical to the main-thread control in
				// bench.js. Isolates raw CSG throughput from message latency.
				const probeEvaluator = new Evaluator();
				const a = new Brush( new BoxGeometry( 2, 2, 2, 4, 4, 4 ) );
				a.updateMatrixWorld( true );
				const b = new Brush( new SphereGeometry( 1.2, 64, 40 ) );
				b.updateMatrixWorld( true );

				const probeStart = now();
				let result = a;
				for ( let i = 0; i < message.iterations; i ++ ) {

					result = probeEvaluator.evaluate( result, b, SUBTRACTION, new Brush( new BufferGeometry() ) );

				}

				self.postMessage( {
					type: MESSAGE_TYPE.RESULT,
					id: message.id,
					brush: null,
					stats: { solveMs: now() - probeStart, triangles: countTriangles( result.geometry ) },
				} );
				break;

			}

			default:
				break;

		}

	} catch ( error ) {

		self.postMessage( {
			type: MESSAGE_TYPE.ERROR,
			id: message.id ?? null,
			message: error && error.message ? error.message : String( error ),
			stack: error && error.stack ? error.stack : null,
		} );

	}

};

self.postMessage( { type: MESSAGE_TYPE.READY } );
