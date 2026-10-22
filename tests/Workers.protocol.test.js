import { BoxGeometry, SphereGeometry, MeshStandardMaterial, Matrix4, Vector3 } from 'three';
import { Brush, SUBTRACTION, Evaluator } from '../src/index.js';
import {
	serializeBrush,
	deserializeBrush,
	serializeGeometry,
	deserializeGeometry,
	brushFingerprint,
	collectTransferables,
	countTriangles,
	fnv1a,
} from '../src/workers/protocol.js';

describe( 'workers/protocol', () => {

	it( 'round-trips a geometry without losing attributes or groups.', () => {

		const geometry = new BoxGeometry( 2, 3, 4, 2, 2, 2 );
		// BoxGeometry ships with six per-face groups; start from a clean slate so
		// the round-trip assertion is unambiguous.
		geometry.clearGroups();
		geometry.addGroup( 0, 6, 0 );
		geometry.addGroup( 6, 12, 1 );

		const wire = serializeGeometry( geometry );
		const restored = deserializeGeometry( wire );

		expect( restored.attributes.position.count ).toBe( geometry.attributes.position.count );
		expect( restored.attributes.normal.count ).toBe( geometry.attributes.normal.count );
		expect( restored.index.count ).toBe( geometry.index.count );
		expect( restored.groups.length ).toBe( 2 );
		expect( restored.groups[ 1 ] ).toEqual( { start: 6, count: 12, materialIndex: 1 } );

		// Values, not just shapes.
		const a = geometry.attributes.position.array;
		const b = restored.attributes.position.array;
		expect( b.length ).toBe( a.length );
		for ( let i = 0; i < a.length; i ++ ) {

			if ( a[ i ] !== b[ i ] ) throw new Error( `position mismatch at ${ i }` );

		}

	} );

	it( 'copies typed arrays so transferring cannot detach the source.', () => {

		const geometry = new SphereGeometry( 1, 12, 8 );
		const source = geometry.attributes.position.array;
		const wire = serializeGeometry( geometry );

		expect( wire.attributes.position.array ).not.toBe( source );
		expect( wire.attributes.position.array.buffer ).not.toBe( source.buffer );

	} );

	it( 'round-trips a brush including matrix and material.', () => {

		const material = new MeshStandardMaterial( { color: 0xff8800, opacity: 0.5, transparent: true, metalness: 0.3, roughness: 0.2 } );
		const brush = new Brush( new BoxGeometry( 1, 1, 1 ), material );
		brush.position.set( 1, 2, 3 );
		brush.rotation.set( 0.3, 0.4, 0.5 );
		brush.scale.set( 2, 2, 2 );
		brush.updateMatrixWorld( true );

		const wire = serializeBrush( brush );
		const restored = deserializeBrush( wire );

		expect( wire.matrixWorld ).toBeInstanceOf( Float64Array );
		expect( restored.matrixWorld.elements ).toHaveLength( 16 );

		const expected = new Vector3();
		const actual = new Vector3();
		brush.getWorldPosition( expected );
		restored.getWorldPosition( actual );
		expect( actual.x ).toBeCloseTo( expected.x, 6 );
		expect( actual.y ).toBeCloseTo( expected.y, 6 );
		expect( actual.z ).toBeCloseTo( expected.z, 6 );

		expect( restored.material.color.getHex() ).toBe( 0xff8800 );
		expect( restored.material.opacity ).toBeCloseTo( 0.5, 6 );
		expect( restored.material.metalness ).toBeCloseTo( 0.3, 6 );

	} );

	it( 'preserves an array of materials (multi-material CSG output).', () => {

		const brush = new Brush( new BoxGeometry(), [
			new MeshStandardMaterial( { color: 0x111111 } ),
			new MeshStandardMaterial( { color: 0x222222 } ),
		] );

		const restored = deserializeBrush( serializeBrush( brush ) );
		expect( Array.isArray( restored.material ) ).toBe( true );
		expect( restored.material ).toHaveLength( 2 );
		expect( restored.material[ 1 ].color.getHex() ).toBe( 0x222222 );

	} );

	it( 'rejects interleaved attributes instead of silently corrupting them.', () => {

		const geometry = new BoxGeometry();
		geometry.attributes.position = {
			isInterleavedBufferAttribute: true,
			array: new Float32Array( 3 ),
			itemSize: 3,
			normalized: false,
		};

		expect( () => serializeGeometry( geometry ) ).toThrow( /interleaved/i );

	} );

	it( 'produces a stable fingerprint for an unchanged brush.', () => {

		const brush = new Brush( new BoxGeometry( 1, 1, 1 ) );
		brush.updateMatrixWorld( true );

		const first = brushFingerprint( brush );
		const second = brushFingerprint( brush );
		expect( second ).toBe( first );

	} );

	it( 'changes the fingerprint when geometry or transform changes.', () => {

		const brush = new Brush( new BoxGeometry( 1, 1, 1 ) );
		brush.updateMatrixWorld( true );
		const base = brushFingerprint( brush );

		brush.position.x = 1;
		brush.updateMatrixWorld( true );
		const moved = brushFingerprint( brush );
		expect( moved ).not.toBe( base );

		const other = new Brush( new SphereGeometry( 1, 8, 6 ) );
		other.updateMatrixWorld( true );
		expect( brushFingerprint( other ) ).not.toBe( moved );

	} );

	it( 'fingerprints two distinct brushes with identical parameters differently.', () => {

		// Different Brush instances have different geometry uuids, so the worker
		// never mistakes one for the other.
		const a = new Brush( new BoxGeometry( 1, 1, 1 ) );
		const b = new Brush( new BoxGeometry( 1, 1, 1 ) );
		a.updateMatrixWorld( true );
		b.updateMatrixWorld( true );
		expect( brushFingerprint( a ) ).not.toBe( brushFingerprint( b ) );

	} );

	it( 'collects every transferable buffer exactly once per attribute.', () => {

		const brush = new Brush( new BoxGeometry( 2, 2, 2 ) );
		brush.updateMatrixWorld( true );
		const wire = serializeBrush( brush );
		const buffers = collectTransferables( wire.geometry );

		// position + normal + uv attributes, plus the index buffer.
		const expected = 4;
		expect( buffers.length ).toBe( expected );
		expect( buffers.every( buffer => buffer instanceof ArrayBuffer ) ).toBe( true );

	} );

	it( 'counts triangles from the index when one is present.', () => {

		const geometry = new BoxGeometry();
		expect( countTriangles( geometry ) ).toBe( geometry.index.count / 3 );

		// Draw range narrows the count.
		geometry.setDrawRange( 0, 9 );
		expect( countTriangles( geometry ) ).toBe( 3 );

	} );

	it( 'fnv1a is deterministic and spreads similar strings.', () => {

		expect( fnv1a( 'abc' ) ).toBe( fnv1a( 'abc' ) );
		expect( fnv1a( 'abc' ) ).not.toBe( fnv1a( 'abd' ) );
		expect( fnv1a( '' ) ).toBe( 0x811c9dc5 );

	} );

	it( 'keeps matrix precision when the transform is non-trivial.', () => {

		const brush = new Brush( new BoxGeometry() );
		const matrix = new Matrix4().makeRotationFromEuler( { x: 0.1, y: 0.2, z: 0.3, isEuler: true } );
		brush.matrixWorld.copy( matrix );
		brush.matrix.copy( matrix );

		const restored = deserializeBrush( serializeBrush( brush ) );
		for ( let i = 0; i < 16; i ++ ) {

			expect( restored.matrixWorld.elements[ i ] ).toBeCloseTo( matrix.elements[ i ], 10 );

		}

	} );

	it( 'deserialised brushes still work as CSG inputs.', () => {

		// The whole point of the protocol: a brush that crossed the boundary must
		// behave identically to one that never left.
		const a = new Brush( new BoxGeometry( 2, 2, 2 ) );
		a.updateMatrixWorld( true );
		const b = new Brush( new BoxGeometry( 1, 1, 4 ) );
		b.updateMatrixWorld( true );

		const evaluator = new Evaluator();
		const direct = evaluator.evaluate( a, b, SUBTRACTION );

		const restoredA = deserializeBrush( serializeBrush( a ) );
		const restoredB = deserializeBrush( serializeBrush( b ) );
		const roundTripped = new Evaluator().evaluate( restoredA, restoredB, SUBTRACTION );

		expect( countTriangles( roundTripped.geometry ) ).toBe( countTriangles( direct.geometry ) );

	} );

} );
