/**
 * A fixed-size pool of CSG workers with cancellation support.
 *
 * Replaces the empty `Pool` stub shipped in three-bvh-csg. The pool is
 * intentionally conservative: workers are never terminated to cancel a job,
 * because each worker owns the geometry/stage caches that make interactive
 * re-evaluation cheap. Cancellation is therefore logical — the job is dropped
 * when its result arrives.
 */
import { MESSAGE_TYPE } from './protocol.js';

class AbortError extends Error {

	constructor( message = 'CSG job aborted' ) {

		super( message );
		this.name = 'AbortError';

	}

}

function createAbortError() {

	if ( typeof DOMException !== 'undefined' ) {

		return new DOMException( 'CSG job aborted', 'AbortError' );

	}

	return new AbortError();

}

class WorkerHandle {

	constructor( worker, index, onIdle ) {

		this.worker = worker;
		this.index = index;
		this.busy = false;
		this.job = null;
		this.ready = false;
		this._onIdle = onIdle;
		this._readyResolve = null;
		this._readyReject = null;
		this.readyPromise = new Promise( ( resolve, reject ) => {

			this._readyResolve = resolve;
			this._readyReject = reject;

		} );

		worker.onmessage = event => this._onMessage( event );
		worker.onerror = event => this._onError( event );

	}

	_onMessage( event ) {

		const message = event.data;
		if ( ! message ) return;

		if ( message.type === MESSAGE_TYPE.READY ) {

			this.ready = true;
			this._readyResolve( this );
			this._onIdle?.();
			return;

		}

		const job = this.job;
		if ( ! job || message.id !== job.id ) {

			// Stale response for a cancelled or superseded job.
			return;

		}

		this.busy = false;
		this.job = null;

		// A job aborted while in flight still produces a response; the caller has
		// already been told it was cancelled, so the result is dropped here.
		if ( job.cancelled ) {

			job.cleanup();
			this._onIdle?.();
			return;

		}

		if ( message.type === MESSAGE_TYPE.ERROR ) {

			const error = new Error( message.message );
			if ( message.stack ) error.stack = message.stack;
			job.reject( error );

		} else {

			job.resolve( message );

		}

		job.cleanup();
		this._onIdle?.();

	}

	_onError( event ) {

		// A worker that fails to boot would otherwise leave `whenReady()` pending
		// forever, which reads as a hang rather than a startup error.
		if ( ! this.ready ) {

			this._readyReject?.( event.error || new Error( event.message || 'CSG worker failed to start' ) );

		}

		const job = this.job;
		this.busy = false;
		this.job = null;
		if ( job ) {

			job.reject( event.error || new Error( event.message || 'CSG worker crashed' ) );
			job.cleanup();

		}

		this._onIdle?.();

	}

	post( payload, transfer ) {

		this.worker.postMessage( payload, transfer || [] );

	}

	terminate() {

		this.worker.terminate();

	}

}

export class Pool {

	/**
	 * @param {string|URL|((index: number) => Worker)} source either the module URL
	 *   of `csg.worker.js`, or a factory returning a Worker (lets callers plug in
	 *   bundler-specific worker constructors such as Vite's `?worker` imports).
	 * @param {{ size?: number, name?: string }} [options]
	 */
	constructor( source, options = {} ) {

		const size = Math.max( 1, options.size ?? 1 );
		const name = options.name ?? 'csg';
		const createWorker = typeof source === 'function'
			? source
			: index => new Worker( source, { type: 'module', name: `${ name }-${ index }` } );

		this.size = size;
		this._queue = [];
		this._handles = [];
		this._destroyed = false;
		this._nextId = 1;
		this._idleWaiters = [];

		for ( let i = 0; i < size; i ++ ) {

			const worker = createWorker( i );
			this._handles.push( new WorkerHandle( worker, i, () => this._onSettled() ) );

		}

		this.ready = Promise.all( this._handles.map( handle => handle.readyPromise ) );


	}

	get idleCount() {

		return this._handles.filter( handle => ! handle.busy ).length;

	}

	get pendingCount() {

		return this._queue.length;

	}

	/**
	 * Queues a job. `buildPayload(workerIndex)` is invoked lazily at dispatch time
	 * so the caller can decide whether to attach a geometry payload based on what
	 * that specific worker already has cached.
	 *
	 * @param {(workerIndex: number) => { payload: object, transfer?: ArrayBuffer[] }} buildPayload
	 * @param {{ signal?: AbortSignal, priority?: number }} [options]
	 * @returns {Promise<object>}
	 */
	exec( buildPayload, options = {} ) {

		if ( this._destroyed ) {

			return Promise.reject( new Error( 'Pool has been destroyed.' ) );

		}

		const { signal, priority = 0 } = options;
		if ( signal?.aborted ) {

			return Promise.reject( createAbortError() );

		}

		return new Promise( ( resolve, reject ) => {

			const job = {
				id: this._nextId ++,
				buildPayload,
				priority,
				resolve,
				reject,
				signal,
				cancelled: false,
				dispatched: false,
				onAbort: null,
				cleanup: () => {

					if ( job.signal && job.onAbort ) {

						job.signal.removeEventListener( 'abort', job.onAbort );

					}

				},
			};

			if ( signal ) {

				job.onAbort = () => {

					job.cancelled = true;
					// Drop it from the queue if it never started…
					const queuedIndex = this._queue.indexOf( job );
					if ( queuedIndex !== - 1 ) {

						this._queue.splice( queuedIndex, 1 );

					}

					// …and reject immediately either way. If it was already running,
					// the late response is discarded in `_onMessage`.
					job.cleanup();
					reject( createAbortError() );

				};

				signal.addEventListener( 'abort', job.onAbort, { once: true } );

			}

			// Higher priority first, FIFO within the same priority.
			let insertAt = this._queue.length;
			for ( let i = 0; i < this._queue.length; i ++ ) {

				if ( this._queue[ i ].priority < priority ) {

					insertAt = i;
					break;

				}

			}

			this._queue.splice( insertAt, 0, job );
			this._onSettled();

		} );

	}

	_onSettled() {

		this._drain();

		if ( ! this._queue.length && this.idleCount === this.size && this._idleWaiters.length ) {

			const waiters = this._idleWaiters.splice( 0 );
			waiters.forEach( resolve => resolve() );

		}

	}

	_drain() {

		while ( this._queue.length ) {

			const handle = this._handles.find( h => ! h.busy && h.ready );
			if ( ! handle ) return;

			const job = this._queue.shift();
			if ( job.cancelled ) {

				job.cleanup();
				job.reject( createAbortError() );
				continue;

			}

			job.dispatched = true;
			handle.busy = true;
			handle.job = job;

			try {

				const { payload, transfer } = job.buildPayload( handle.index );
				payload.id = job.id;
				handle.post( payload, transfer );

			} catch ( error ) {

				handle.busy = false;
				handle.job = null;
				job.cleanup();
				job.reject( error );

			}

		}

	}

	/** Resolves once every worker has reported ready. */
	whenReady() {

		return this.ready;

	}

	/** Resolves when no job is running or queued. */
	whenIdle() {

		if ( ! this._queue.length && this.idleCount === this.size ) {

			return Promise.resolve();

		}

		return new Promise( resolve => this._idleWaiters.push( resolve ) );

	}

	destroy() {

		this._destroyed = true;

		this._handles.forEach( handle => {

			// In-flight jobs would otherwise hang forever: terminating the worker
			// guarantees no response will ever arrive.
			if ( handle.job ) {

				handle.job.cleanup();
				handle.job.reject( createAbortError() );
				handle.job = null;

			}

			handle.busy = false;
			handle.terminate();

		} );

		this._queue.splice( 0 ).forEach( job => {

			job.cleanup();
			job.reject( createAbortError() );

		} );

	}

}

export { AbortError };
