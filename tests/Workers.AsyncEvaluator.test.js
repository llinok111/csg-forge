/**
 * AsyncEvaluator must be a drop-in upgrade over Evaluator: same inputs, same
 * numbers, plus stats. In Node there is no `Worker`, so these tests exercise the
 * synchronous fallback — which is exactly the path a locked-down iframe takes.
 */
import { BoxGeometry, SphereGeometry, CylinderGeometry } from 'three';
import {
	Brush,
	Evaluator,
	SUBTRACTION,
	ADDITION,
	INTERSECTION,
	DIFFERENCE,
	computeMeshVolume,
} from '../src/index.js';
import { AsyncEvaluator } from '../src/workers/AsyncEvaluator.js';

function box( size = 2, position = [ 0, 0, 0 ] ) {

	const brush = new Brush( new BoxGeometry( size, size, size ) );
	brush.position.set( ...position );
	brush.updateMatrixWorld( true );
	return brush;

}

function sphere( radius = 1.2, position = [ 0, 0, 0 ] ) {

	const brush = new Brush( new SphereGeometry( radius, 32, 20 ) );
	brush.position.set( ...position );
	brush.updateMatrixWorld( true );
	return brush;

}

describe( 'workers/AsyncEvaluator (fallback)', () => {

	it( 'falls back to synchronous evaluation when Worker is unavailable.', () => {

		const evaluator = new AsyncEvaluator();
		expect( typeof Worker ).toBe( 'undefined' );
		expect( evaluator.mode ).toBe( 'sync' );
		evaluator.dispose();

	} );

	it( 'honours forceSync even where Worker exists.', () => {

		const evaluator = new AsyncEvaluator( { forceSync: true } );
		expect( evaluator.mode ).toBe( 'sync' );
		evaluator.dispose();

	} );

	it( 'matches Evaluator numerically for every operation.', async () => {

		for ( const op of [ ADDITION, SUBTRACTION, INTERSECTION, DIFFERENCE ] ) {

			const expected = computeMeshVolume( new Evaluator().evaluate( box( 2 ), sphere( 1.2 ), op ) );

			const evaluator = new AsyncEvaluator();
			const { brush } = await evaluator.evaluateChain( [ { brush: box( 2 ) }, { brush: sphere( 1.2 ), op } ] );
			evaluator.dispose();

			expect( computeMeshVolume( brush ) ).toBeCloseTo( expected, 5 );

		}

	} );

	it( 'returns a Brush with the same shape as Evaluator.', async () => {

		const evaluator = new AsyncEvaluator();
		const { brush, stats } = await evaluator.evaluateChain( [ { brush: box( 2 ) }, { brush: sphere( 1.2 ), op: SUBTRACTION } ] );

		expect( brush.isBrush ).toBe( true );
		expect( brush.geometry.attributes.position.count ).toBeGreaterThan( 0 );
		expect( Array.isArray( brush.material ) ).toBe( true );
		expect( stats.evaluations ).toBe( 1 );
		expect( typeof stats.totalMs ).toBe( 'number' );
		expect( stats.totalMs ).toBeGreaterThanOrEqual( 0 );

		evaluator.dispose();

	} );

	it( 'evaluate() mirrors the upstream single-operation signature.', async () => {

		const evaluator = new AsyncEvaluator();
		const result = await evaluator.evaluate( box( 2 ), sphere( 1.2 ), SUBTRACTION );

		expect( result.isBrush ).toBe( true );
		expect( computeMeshVolume( result ) ).toBeGreaterThan( 0 );
		expect( computeMeshVolume( result ) ).toBeLessThan( 8 );

		evaluator.dispose();

	} );

	it( 'accepts an array of operations like the upstream Evaluator.', async () => {

		const evaluator = new AsyncEvaluator();
		const result = await evaluator.evaluate( box( 2 ), sphere( 1.2 ), [ SUBTRACTION, INTERSECTION ] );

		expect( result.isBrush ).toBe( true );
		expect( computeMeshVolume( result ) ).toBeGreaterThanOrEqual( 0 );

		evaluator.dispose();

	} );

	it( 'evaluates a multi-node chain in order.', async () => {

		const base = new Brush( new CylinderGeometry( 1.5, 1.5, 0.5, 32 ) );
		base.updateMatrixWorld( true );

		const hole = new Brush( new CylinderGeometry( 0.5, 0.5, 2, 24 ) );
		hole.updateMatrixWorld( true );

		const notch = box( 0.6, [ 1.2, 0, 0 ] );

		const evaluator = new AsyncEvaluator();
		const { brush, stats } = await evaluator.evaluateChain( [
			{ brush: base },
			{ brush: hole, op: SUBTRACTION },
			{ brush: notch, op: SUBTRACTION },
		] );

		expect( stats.evaluations ).toBe( 2 );
		// Base cylinder volume minus the bore minus the notch.
		const baseVolume = Math.PI * 1.5 * 1.5 * 0.5;
		expect( computeMeshVolume( brush ) ).toBeLessThan( baseVolume );
		expect( computeMeshVolume( brush ) ).toBeGreaterThan( baseVolume * 0.5 );

		evaluator.dispose();

	} );

	it( 'rejects an empty chain.', async () => {

		const evaluator = new AsyncEvaluator();
		await expect( evaluator.evaluateChain( [] ) ).rejects.toThrow( /at least one node/i );
		evaluator.dispose();

	} );

	it( 'rejects work after dispose.', async () => {

		const evaluator = new AsyncEvaluator();
		evaluator.dispose();
		await expect( evaluator.evaluateChain( [ { brush: box() } ] ) ).rejects.toThrow( /disposed/i );

	} );

	it( 'reports CDTClipping and attribute options through to the evaluator.', async () => {

		const evaluator = new AsyncEvaluator();
		evaluator.useCDTClipping = true;
		evaluator.attributes = [ 'position', 'normal' ];

		const { brush } = await evaluator.evaluateChain( [ { brush: box( 2 ) }, { brush: sphere( 1.2 ), op: SUBTRACTION } ] );

		expect( brush.geometry.attributes.position ).toBeTruthy();
		// uv is dropped when it is not requested.
		expect( brush.geometry.attributes.uv ).toBeUndefined();

		evaluator.dispose();

	} );

	it( 'calls onStats once per evaluation.', async () => {

		const evaluator = new AsyncEvaluator();
		const seen = [];
		await evaluator.evaluateChain( [ { brush: box( 2 ) }, { brush: sphere( 1.2 ), op: SUBTRACTION } ], {
			onStats: stats => seen.push( stats ),
		} );

		expect( seen ).toHaveLength( 1 );
		expect( seen[ 0 ].evaluations ).toBe( 1 );

		evaluator.dispose();

	} );

} );
