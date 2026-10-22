/**
 * Pool scheduling is tested against a fake Worker so the suite stays in Node.
 * The fake mirrors the real protocol: it emits `csg-ready` on construction and
 * answers each job with `csg-result` after a configurable delay.
 */
import { Pool } from '../src/workers/Pool.js';
import { MESSAGE_TYPE } from '../src/workers/protocol.js';

class FakeWorker {

	constructor( index, delay = 5 ) {

		this.index = index;
		this.delay = delay;
		this.onmessage = null;
		this.onerror = null;
		this.terminated = false;
		this.received = [];
		this._timer = setTimeout( () => {

			this.onmessage?.( { data: { type: MESSAGE_TYPE.READY } } );

		}, 1 );

	}

	postMessage( payload ) {

		this.received.push( payload );
		if ( payload.type !== MESSAGE_TYPE.EVALUATE ) {

			// ACK-style control messages.
			setTimeout( () => this.onmessage?.( { data: { type: MESSAGE_TYPE.ACK, id: payload.id } } ), 1 );
			return;

		}

		setTimeout( () => {

			if ( this.terminated ) return;
			this.onmessage?.( {
				data: {
					type: MESSAGE_TYPE.RESULT,
					id: payload.id,
					brush: null,
					stats: { totalMs: this.delay, workerIndex: this.index, payloadId: payload.id },
				},
			} );

		}, this.delay );

	}

	terminate() {

		this.terminated = true;
		clearTimeout( this._timer );

	}

}

function makePool( size = 1, delay = 5 ) {

	const created = [];
	const pool = new Pool( index => {

		const worker = new FakeWorker( index, delay );
		created.push( worker );
		return worker;

	}, { size, name: 'test' } );

	return { pool, created };

}

describe( 'workers/Pool', () => {

	it( 'resolves every queued job and reports per-worker routing.', async () => {

		const { pool } = makePool( 2, 6 );
		await pool.whenReady();

		const results = await Promise.all( [ 0, 1, 2, 3 ].map( i => pool.exec( () => ( { payload: { type: MESSAGE_TYPE.EVALUATE, tag: i } } ) ) ) );

		expect( results ).toHaveLength( 4 );
		expect( results.map( r => r.stats.payloadId ) ).toEqual( [ 1, 2, 3, 4 ] );
		// Both workers participated.
		expect( new Set( results.map( r => r.stats.workerIndex ) ).size ).toBe( 2 );

		pool.destroy();

	} );

	it( 'never dispatches two jobs to the same worker at once.', async () => {

		const { pool, created } = makePool( 1, 8 );
		await pool.whenReady();

		const results = await Promise.all( [ 0, 1, 2 ].map( i => pool.exec( () => ( { payload: { type: MESSAGE_TYPE.EVALUATE, tag: i } } ) ) ) );

		expect( created ).toHaveLength( 1 );
		expect( results.map( r => r.stats.payloadId ) ).toEqual( [ 1, 2, 3 ] );
		// The fake worker records every message; strictly increasing ids prove the
		// pool waited for each response before dispatching the next job.
		expect( created[ 0 ].received.map( p => p.id ) ).toEqual( [ 1, 2, 3 ] );

		pool.destroy();

	} );

	it( 'drops a queued job when its signal aborts.', async () => {

		const { pool } = makePool( 1, 30 );
		await pool.whenReady();

		// Occupy the only worker.
		const first = pool.exec( () => ( { payload: { type: MESSAGE_TYPE.EVALUATE } } ) );

		const controller = new AbortController();
		const queued = pool.exec( () => ( { payload: { type: MESSAGE_TYPE.EVALUATE } } ), { signal: controller.signal } );

		expect( pool.pendingCount ).toBe( 1 );
		controller.abort();

		await expect( queued ).rejects.toMatchObject( { name: 'AbortError' } );
		await first;

		pool.destroy();

	} );

	it( 'rejects immediately when the signal is already aborted.', async () => {

		const { pool } = makePool( 1, 5 );
		await pool.whenReady();

		const controller = new AbortController();
		controller.abort();

		await expect( pool.exec( () => ( { payload: {} } ), { signal: controller.signal } ) ).rejects.toMatchObject( { name: 'AbortError' } );

		pool.destroy();

	} );

	it( 'discards the result of a job aborted while in flight.', async () => {

		const { pool } = makePool( 1, 40 );
		await pool.whenReady();

		const controller = new AbortController();
		let settled = 'pending';

		const job = pool.exec( () => ( { payload: { type: MESSAGE_TYPE.EVALUATE } } ), { signal: controller.signal } )
			.then( () => ( settled = 'resolved' ) )
			.catch( error => ( settled = error.name ) );

		// Let it dispatch, then abort mid-flight.
		await new Promise( r => setTimeout( r, 10 ) );
		expect( pool.pendingCount ).toBe( 0 );
		controller.abort();

		await job;
		// The result still arrives, but the promise must not resolve with it.
		expect( settled ).toBe( 'AbortError' );

		pool.destroy();

	} );

	it( 'honours priority ordering within the queue.', async () => {

		const { pool } = makePool( 1, 12 );
		await pool.whenReady();

		const order = [];
		const blocker = pool.exec( () => ( { payload: { type: MESSAGE_TYPE.EVALUATE } } ) );

		const low = pool.exec( () => {

			order.push( 'low' );
			return { payload: { type: MESSAGE_TYPE.EVALUATE } };

		}, { priority: 0 } );

		const high = pool.exec( () => {

			order.push( 'high' );
			return { payload: { type: MESSAGE_TYPE.EVALUATE } };

		}, { priority: 10 } );

		await Promise.all( [ blocker, low, high ] );
		expect( order ).toEqual( [ 'high', 'low' ] );

		pool.destroy();

	} );

	it( 'propagates worker errors as rejections.', async () => {

		const { pool, created } = makePool( 1, 5 );
		await pool.whenReady();

		const job = pool.exec( () => ( { payload: { type: MESSAGE_TYPE.EVALUATE } } ) );
		await new Promise( r => setTimeout( r, 1 ) );
		created[ 0 ].onmessage( { data: { type: MESSAGE_TYPE.ERROR, id: 1, message: 'boom', stack: 'x' } } );

		await expect( job ).rejects.toThrow( 'boom' );

		pool.destroy();

	} );

	it( 'rejects queued work once destroyed and terminates workers.', async () => {

		const { pool, created } = makePool( 1, 50 );
		await pool.whenReady();

		const running = pool.exec( () => ( { payload: { type: MESSAGE_TYPE.EVALUATE } } ) );
		const queued = pool.exec( () => ( { payload: { type: MESSAGE_TYPE.EVALUATE } } ) );

		// allSettled attaches handlers immediately, so destroying the pool cannot
		// produce an unhandled rejection in the tick before we inspect the result.
		const settled = Promise.allSettled( [ running, queued ] );

		pool.destroy();

		const outcomes = await settled;
		expect( outcomes[ 0 ].status ).toBe( 'rejected' );
		expect( outcomes[ 0 ].reason.name ).toBe( 'AbortError' );
		expect( outcomes[ 1 ].status ).toBe( 'rejected' );
		expect( outcomes[ 1 ].reason.name ).toBe( 'AbortError' );
		expect( created.every( worker => worker.terminated ) ).toBe( true );

	} );

	it( 'whenIdle resolves only after the queue drains.', async () => {

		const { pool } = makePool( 2, 8 );
		await pool.whenReady();

		let done = false;
		pool.whenIdle().then( () => ( done = true ) );

		const jobs = [ 0, 1, 2 ].map( () => pool.exec( () => ( { payload: { type: MESSAGE_TYPE.EVALUATE } } ) ) );

		expect( done ).toBe( false );
		await Promise.all( jobs );
		await pool.whenIdle();
		expect( pool.pendingCount ).toBe( 0 );

		pool.destroy();

	} );

	it( 'rejects work submitted after destroy.', async () => {

		const { pool } = makePool( 1, 5 );
		await pool.whenReady();
		pool.destroy();

		await expect( pool.exec( () => ( { payload: {} } ) ) ).rejects.toThrow( /destroyed/i );

	} );

} );
