/**
 * Promise-based, worker-backed counterpart to `Evaluator`.
 *
 * Replaces the empty `AsyncEvaluator` stub shipped in three-bvh-csg and closes
 * upstream roadmap item "Worker Support" (issue #14): the untouched upstream
 * `Evaluator` now runs inside a module worker, so a 200 ms boolean operation no
 * longer blocks the render loop or input handling.
 *
 * The public surface mirrors `Evaluator` so existing code can migrate by adding
 * `await`:
 *
 *   const evaluator = new Evaluator();
 *   const result = evaluator.evaluate( a, b, SUBTRACTION );
 *
 *   const asyncEvaluator = new AsyncEvaluator( { workers: 2 } );
 *   const result = await asyncEvaluator.evaluate( a, b, SUBTRACTION );
 *
 * `evaluateChain()` is an additional API for the workbench: it evaluates a
 * linear modifier chain in a single round-trip and returns per-stage stats.
 *
 * When `Worker` is unavailable (Node, locked-down iframes) it degrades to a
 * synchronous in-thread evaluator that resolves on a microtask, so callers never
 * need two code paths.
 */
import { Evaluator } from '../core/Evaluator.js';
import { Brush } from '../core/Brush.js';
import { BufferGeometry } from 'three';
import { Pool } from './Pool.js';
import {
	MESSAGE_TYPE,
	brushFingerprint,
	serializeBrush,
	deserializeBrush,
	collectTransferables,
} from './protocol.js';

function hasWorkerSupport() {

	return typeof Worker !== 'undefined';

}

export class AsyncEvaluator {

	/**
	 * @param {{
	 *   workers?: number,
	 *   workerUrl?: string|URL,
	 *   createWorker?: () => Worker,
	 *   forceSync?: boolean,
	 * }} [options]
	 */
	constructor( options = {} ) {

		this.workers = Math.max( 1, options.workers ?? 1 );
		this.useCDTClipping = false;
		this.attributes = [ 'position', 'uv', 'normal' ];
		this.useGroups = true;

		this._ids = new WeakMap();
		this._idSeq = 0;
		this._sent = new Map(); // workerIndex -> Map<nodeId, fingerprint>
		this._pool = null;
		this._sync = null;
		this._disposed = false;

		// `forceSync` exists so benchmarks can measure the same workload on the
		// main thread and prove the worker path actually removes the block.
		this.mode = hasWorkerSupport() && ! options.forceSync ? 'worker' : 'sync';

		if ( this.mode === 'worker' ) {

			const factory = options.createWorker
				?? ( () => new Worker(
					options.workerUrl ?? new URL( './csg.worker.js', import.meta.url ),
					{ type: 'module', name: 'csg-async' },
				) );

			this._pool = new Pool( factory, { size: this.workers, name: 'csg-async' } );

		} else {

			this._sync = new Evaluator();

		}

	}

	_brushId( brush ) {

		let id = this._ids.get( brush );
		if ( ! id ) {

			id = `brush-${ ++ this._idSeq }`;
			this._ids.set( brush, id );

		}

		return id;

	}

	_applyOptions() {

		if ( ! this._sync ) return;
		this._sync.useCDTClipping = this.useCDTClipping;
		this._sync.attributes = this.attributes;
		this._sync.useGroups = this.useGroups;

	}

	/**
	 * Evaluates a single boolean operation.
	 *
	 * @param {Brush} a
	 * @param {Brush} b
	 * @param {number|number[]} operations CSG operation constant(s)
	 * @param {{ signal?: AbortSignal }} [options]
	 * @returns {Promise<Brush|Brush[]>}
	 */
	async evaluate( a, b, operations, options = {} ) {

		if ( Array.isArray( operations ) ) {

			// Sequential multi-op mirrors Evaluator's array form while staying
			// inside a single worker round-trip per step.
			let current = a;
			let last = null;
			for ( const op of operations ) {

				last = await this.evaluate( current, b, op, options );
				current = last;

			}

			return last;

		}

		const { brush } = await this.evaluateChain( [ { brush: a }, { brush: b, op: operations } ], options );
		return brush;

	}

	/**
	 * Evaluates a linear chain in one round-trip.
	 *
	 * @param {{ brush: Brush, op?: number }[]} nodes first entry is the base brush
	 * @param {{ signal?: AbortSignal, onStats?: (stats: object) => void }} [options]
	 * @returns {Promise<{ brush: Brush, stats: object }>}
	 */
	async evaluateChain( nodes, options = {} ) {

		if ( this._disposed ) {

			throw new Error( 'AsyncEvaluator has been disposed.' );

		}

		if ( ! nodes || nodes.length === 0 ) {

			throw new Error( 'evaluateChain requires at least one node.' );

		}

		const { signal, onStats } = options;

		if ( this.mode === 'sync' ) {

			return this._evaluateChainSync( nodes, onStats );

		}

		const descriptors = nodes.map( ( node, index ) => ( {
			brush: node.brush,
			op: index === 0 ? 0 : node.op,
			id: this._brushId( node.brush ),
			fingerprint: brushFingerprint( node.brush ),
		} ) );

		const message = await this._pool.exec( workerIndex => {

			let sent = this._sent.get( workerIndex );
			if ( ! sent ) {

				sent = new Map();
				this._sent.set( workerIndex, sent );

			}

			const transfer = [];
			const wireNodes = descriptors.map( descriptor => {

				const wire = { id: descriptor.id, fingerprint: descriptor.fingerprint };
				if ( sent.get( descriptor.id ) !== descriptor.fingerprint ) {

					wire.data = serializeBrush( descriptor.brush );
					collectTransferables( wire.data.geometry, transfer );
					sent.set( descriptor.id, descriptor.fingerprint );

				}

				return wire;

			} );

			return {
				payload: {
					type: MESSAGE_TYPE.EVALUATE,
					nodes: wireNodes,
					ops: descriptors.map( descriptor => descriptor.op ),
					options: {
						useCDTClipping: this.useCDTClipping,
						attributes: this.attributes,
						useGroups: this.useGroups,
					},
				},
				transfer,
			};

		}, { signal } );

		const brush = deserializeBrush( message.brush );
		if ( onStats ) onStats( message.stats );
		return { brush, stats: message.stats };

	}

	_evaluateChainSync( nodes, onStats ) {

		this._applyOptions();

		const start = typeof performance !== 'undefined' ? performance.now() : Date.now();
		let result = nodes[ 0 ].brush;
		let evaluations = 0;

		for ( let i = 1; i < nodes.length; i ++ ) {

			const target = new Brush( new BufferGeometry() );
			result = this._sync.evaluate( result, nodes[ i ].brush, nodes[ i ].op, target );
			evaluations ++;

		}

		const stats = {
			totalMs: ( typeof performance !== 'undefined' ? performance.now() : Date.now() ) - start,
			evaluations,
			reusedStages: 0,
			mode: 'sync',
		};

		if ( onStats ) onStats( stats );
		return Promise.resolve( { brush: result, stats } );

	}

	/** Drops all worker-side caches and respawns the pool. */
	async reset() {

		if ( this.mode === 'sync' ) {

			this._sync.reset();
			return;

		}

		this._sent.clear();
		await this._pool.exec( () => ( { payload: { type: 'csg-reset' } } ) );

	}

	/** Number of jobs queued or running. */
	get pending() {

		return this._pool ? this._pool.pendingCount : 0;

	}

	/** Resolves when the pool has nothing left to do. */
	whenIdle() {

		return this._pool ? this._pool.whenIdle() : Promise.resolve();

	}

	/** Resolves once every worker has booted (module graph parsed, caches empty). */
	whenReady() {

		return this._pool ? this._pool.whenReady() : Promise.resolve();

	}

	dispose() {

		this._disposed = true;
		if ( this._pool ) {

			this._pool.destroy();
			this._pool = null;

		}

	}

}
