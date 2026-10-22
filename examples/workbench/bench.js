/**
 * In-page benchmark harness.
 *
 * Runs the *same* modifier chain twice — once through the worker-backed
 * evaluator, once through the main-thread fallback — and records three things
 * that actually matter:
 *
 *  1. `solveMs`     – CSG solve time reported from inside the evaluator
 *                     (transport excluded, so it is comparable across modes).
 *  2. `roundTripMs` – end-to-end wall time including serialisation/transfer.
 *  3. `frames`      – main-thread frame gaps sampled with rAF while the solve
 *                     was in flight. A 150 ms solve on the main thread shows up
 *                     as one 150 ms gap; the same solve in a worker shows up as
 *                     ordinary ~16 ms frames.
 *
 * Cold solves are repeated and reduced with a median: a single headless sample
 * on this class of machine swings by 3×, which is noise, not signal.
 *
 * Every measurement is driven one-frame-at-a-time so the browser gets a chance
 * to paint between iterations — that is what an interactive drag looks like.
 */
import { BoxGeometry, SphereGeometry, BufferGeometry } from 'three';
import { AsyncEvaluator } from '../../src/workers/AsyncEvaluator.js';
import { Pool } from '../../src/workers/Pool.js';
import { Brush, Evaluator, SUBTRACTION } from '../../src/index.js';
import { countTriangles } from '../../src/workers/protocol.js';
import { BrushStore } from './graph.js';

const FRAME_BUDGET_MS = 1000 / 60;
const COLD_RUNS = 3;
const CPU_PROBE_ITERATIONS = 20_000_000;

/**
 * Same integer loop on both sides of the boundary. If the worker runs it at a
 * comparable rate, any slowdown in the CSG numbers is the solve itself, not a
 * throttled worker thread. Without this control, "the worker is 2× slower"
 * would be an unfalsifiable claim.
 */
/**
 * Vite only rewrites `new Worker(new URL(...))` when the pattern appears
 * literally, so every worker in this file is built through this factory.
 */
function createCsgWorker() {

	return new Worker( new URL( '../../src/workers/csg.worker.js', import.meta.url ), { type: 'module' } );

}

export function cpuLoop( iterations ) {

	const start = performance.now();
	let hash = 0x811c9dc5;
	for ( let i = 0; i < iterations; i ++ ) {

		hash = Math.imul( hash ^ i, 0x01000193 ) >>> 0;

	}

	return { ms: Number( ( performance.now() - start ).toFixed( 2 ) ), hash };

}

export async function probeWorkerCpu( iterations = CPU_PROBE_ITERATIONS ) {

	const pool = new Pool( createCsgWorker, { size: 1, name: 'probe' } );
	await pool.whenReady();

	// Warm up, then measure.
	await pool.exec( () => ( { payload: { type: 'csg-cpu-probe', iterations: 5_000_000 } } ) );
	const message = await pool.exec( () => ( { payload: { type: 'csg-cpu-probe', iterations } } ) );
	pool.destroy();

	return message.stats;

}

/** Main-thread control for `csg-solve-probe`: same inputs, same op, same count. */
export function solveLoop( iterations ) {

	const evaluator = new Evaluator();
	const a = new Brush( new BoxGeometry( 2, 2, 2, 4, 4, 4 ) );
	a.updateMatrixWorld( true );
	const b = new Brush( new SphereGeometry( 1.2, 64, 40 ) );
	b.updateMatrixWorld( true );

	const start = performance.now();
	let result = a;
	for ( let i = 0; i < iterations; i ++ ) {

		result = evaluator.evaluate( result, b, SUBTRACTION, new Brush( new BufferGeometry() ) );

	}

	return { solveMs: Number( ( performance.now() - start ).toFixed( 2 ) ), triangles: countTriangles( result.geometry ) };

}

export async function probeWorkerSolve( iterations ) {

	const pool = new Pool( createCsgWorker, { size: 1, name: 'solve-probe' } );
	await pool.whenReady();
	await pool.exec( () => ( { payload: { type: 'csg-solve-probe', iterations: 1 } } ) );
	const message = await pool.exec( () => ( { payload: { type: 'csg-solve-probe', iterations } } ) );
	pool.destroy();
	return message.stats;

}

function nextFrame() {

	return new Promise( resolve => requestAnimationFrame( () => resolve() ) );

}

function median( values ) {

	const sorted = [ ...values ].sort( ( a, b ) => a - b );
	return sorted[ Math.floor( sorted.length / 2 ) ];

}

function createFrameMeter() {

	const gaps = [];
	let last = performance.now();
	let running = true;
	let raf = requestAnimationFrame( function tick() {

		const now = performance.now();
		gaps.push( now - last );
		last = now;
		if ( running ) raf = requestAnimationFrame( tick );

	} );

	return {
		stop() {

			running = false;
			cancelAnimationFrame( raf );
			if ( gaps.length === 0 ) {

				return { frames: 0, maxGap: 0, p95Gap: 0, meanGap: 0, blockedFrames: 0, note: 'no frames sampled' };

			}

			const sorted = [ ...gaps ].sort( ( a, b ) => a - b );
			const mean = gaps.reduce( ( sum, v ) => sum + v, 0 ) / gaps.length;
			return {
				frames: gaps.length,
				maxGap: Number( sorted[ sorted.length - 1 ].toFixed( 2 ) ),
				p95Gap: Number( sorted[ Math.floor( sorted.length * 0.95 ) ].toFixed( 2 ) ),
				meanGap: Number( mean.toFixed( 2 ) ),
				// Frames longer than 1.5× budget = a visible hitch at 60 Hz.
				blockedFrames: gaps.filter( gap => gap > FRAME_BUDGET_MS * 1.5 ).length,
			};

		},
	};

}

function cloneNodes( nodes ) {

	return JSON.parse( JSON.stringify( nodes ) );

}

function nudgeLastNode( node, index ) {

	const p = node.params;
	const wave = Math.sin( index * 1.1 ) * 0.03;
	if ( 'radiusTop' in p ) p.radiusTop = Math.max( 0.05, p.radiusTop + wave );
	else if ( 'radius' in p ) p.radius = Math.max( 0.05, p.radius + wave );
	else if ( 'width' in p ) p.width = Math.max( 0.05, p.width + wave );
	else if ( 'tube' in p ) p.tube = Math.max( 0.02, p.tube + wave );

}

async function measureMode( nodes, mode, rounds ) {

	const evaluator = new AsyncEvaluator( {
		forceSync: mode === 'sync',
		workers: 1,
		createWorker: mode === 'worker' ? createCsgWorker : undefined,
	} );

	const bootStart = performance.now();
	await evaluator.whenReady();
	const bootMs = performance.now() - bootStart;

	// Warm the module graph and the JIT so the first timed run is not a
	// compile benchmark.
	const warmStore = new BrushStore();
	await evaluator.evaluateChain( nodes.map( n => ( { brush: warmStore.get( n ), op: n.op } ) ) );

	// ── Cold: brand-new geometry on both sides, repeated for a median ─────
	// A fresh BrushStore forces new BufferGeometries with no MeshBVH yet, so the
	// worker (which rebuilds its caches after reset) and the in-thread path
	// (which would otherwise reuse prepared geometry from the warm-up) start
	// from the same place.
	const coldSamples = [];

	for ( let run = 0; run < COLD_RUNS; run ++ ) {

		await evaluator.reset();
		await nextFrame();

		const store = new BrushStore();
		const chain = () => nodes.map( n => ( { brush: store.get( n ), op: n.op } ) );

		const meter = createFrameMeter();
		const start = performance.now();
		const result = await evaluator.evaluateChain( chain() );
		const roundTrip = performance.now() - start;
		await nextFrame();
		const frames = meter.stop();

		coldSamples.push( {
			totalMs: result.stats.totalMs,
			resolveMs: result.stats.resolveMs ?? 0,
			solveMs: result.stats.solveMs ?? result.stats.totalMs,
			roundTripMs: roundTrip,
			frames,
			triangles: result.stats.triangles,
		} );

	}

	const cold = {
		totalMs: Number( median( coldSamples.map( s => s.totalMs ) ).toFixed( 2 ) ),
		resolveMs: Number( median( coldSamples.map( s => s.resolveMs ) ).toFixed( 2 ) ),
		solveMs: Number( median( coldSamples.map( s => s.solveMs ) ).toFixed( 2 ) ),
		roundTripMs: Number( median( coldSamples.map( s => s.roundTripMs ) ).toFixed( 2 ) ),
		// Frame gaps are reported per-run; the worst of the runs is what a user feels.
		frames: coldSamples.reduce( ( worst, s ) => ( s.frames.maxGap > worst.maxGap ? s.frames : worst ), coldSamples[ 0 ].frames ),
		runs: COLD_RUNS,
		samples: coldSamples.map( s => ( { totalMs: Number( s.totalMs.toFixed( 1 ) ), roundTripMs: Number( s.roundTripMs.toFixed( 1 ) ) } ) ),
	};

	// ── Hot: nudge only the last node, one solve per painted frame ────────
	const hotStore = new BrushStore();
	const hotChain = () => nodes.map( n => ( { brush: hotStore.get( n ), op: n.op } ) );
	const last = nodes[ nodes.length - 1 ];
	const hotTimes = [];
	const hotSolve = [];
	let reused = 0;
	const hotMeter = createFrameMeter();

	for ( let i = 0; i < rounds; i ++ ) {

		await nextFrame();
		nudgeLastNode( last, i );
		const start = performance.now();
		const result = await evaluator.evaluateChain( hotChain() );
		hotTimes.push( performance.now() - start );
		hotSolve.push( result.stats.solveMs ?? result.stats.totalMs );
		reused = result.stats.reusedStages;

	}

	const hotFrames = hotMeter.stop();

	const report = {
		mode,
		triangles: coldSamples[ 0 ].triangles,
		bootMs: Number( bootMs.toFixed( 2 ) ),
		cold,
		hot: {
			rounds,
			solveMsAvg: Number( ( hotSolve.reduce( ( s, v ) => s + v, 0 ) / hotSolve.length ).toFixed( 2 ) ),
			roundTripMsAvg: Number( ( hotTimes.reduce( ( s, v ) => s + v, 0 ) / hotTimes.length ).toFixed( 2 ) ),
			roundTripMsMin: Number( Math.min( ...hotTimes ).toFixed( 2 ) ),
			roundTripMsMax: Number( Math.max( ...hotTimes ).toFixed( 2 ) ),
			reusedStages: reused,
			prefixCacheAvailable: mode === 'worker',
			frames: hotFrames,
		},
	};

	evaluator.dispose();
	return report;

}

export async function runBench( { nodes, rounds = 12 } ) {

	const snapshot = cloneNodes( nodes );

	// Control measurement first: identical integer workload on both threads.
	const mainCpu = cpuLoop( CPU_PROBE_ITERATIONS );
	const workerCpu = await probeWorkerCpu();

	// Second control: identical *CSG* workload on both threads, no transport.
	const mainSolve = solveLoop( 4 );
	const workerSolve = await probeWorkerSolve( 4 );

	const worker = await measureMode( cloneNodes( snapshot ), 'worker', rounds );
	const sync = await measureMode( cloneNodes( snapshot ), 'sync', rounds );

	return {
		when: new Date().toISOString(),
		userAgent: navigator.userAgent,
		hardwareConcurrency: navigator.hardwareConcurrency,
		devicePixelRatio: window.devicePixelRatio,
		cpuProbe: {
			iterations: CPU_PROBE_ITERATIONS,
			mainMs: mainCpu.ms,
			workerMs: workerCpu.cpuMs,
			// ≈1 means the worker thread has the same throughput as the main thread.
			workerThroughputRatio: Number( ( mainCpu.ms / workerCpu.cpuMs ).toFixed( 2 ) ),
			hashMatch: mainCpu.hash === workerCpu.hash,
		},
		solveProbe: {
			iterations: 4,
			mainMs: mainSolve.solveMs,
			workerMs: workerSolve.solveMs,
			// ≈1 means raw CSG throughput is the same on both threads, so any
			// difference in the chain benchmark is transport or cache related.
			workerThroughputRatio: Number( ( mainSolve.solveMs / workerSolve.solveMs ).toFixed( 2 ) ),
			trianglesMatch: mainSolve.triangles === workerSolve.triangles,
			triangles: mainSolve.triangles,
		},
		chain: { nodes: snapshot.length, triangles: worker.triangles },
		worker,
		sync,
		derived: {
			// Ratio of in-thread time to worker time. <1 means the worker path is
			// slower, which is expected on a cold chain: every brush has to cross
			// the boundary first.
			coldTimeRatio: Number( ( sync.cold.roundTripMs / worker.cold.roundTripMs ).toFixed( 2 ) ),
			hotTimeRatio: Number( ( sync.hot.roundTripMsAvg / worker.hot.roundTripMsAvg ).toFixed( 2 ) ),
			// Worst main-thread stall removed — the metric users actually feel.
			coldStallSavedMs: Number( ( sync.cold.frames.maxGap - worker.cold.frames.maxGap ).toFixed( 2 ) ),
			hotStallSavedMs: Number( ( sync.hot.frames.maxGap - worker.hot.frames.maxGap ).toFixed( 2 ) ),
			hotPrefixReuse: `${ worker.hot.reusedStages }/${ snapshot.length }`,
			workerBootOverheadMs: worker.bootMs,
		},
	};

}
