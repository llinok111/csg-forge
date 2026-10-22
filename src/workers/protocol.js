/**
 * Wire protocol shared between the main thread and `csg.worker.js`.
 *
 * three.js objects (`Brush`, `BufferGeometry`, `Material`) are not structured
 * cloneable, so every message carries a plain-object "brush descriptor":
 *
 *   { geometry, matrixWorld, material }
 *
 * Geometry payloads are transferred (zero-copy) as `ArrayBuffer`s, which is why
 * every typed array leaving the main thread is copied first: a transferred
 * buffer is detached on the sender side and would otherwise break the live
 * scene graph.
 */
import { BufferGeometry, BufferAttribute, MeshStandardMaterial } from 'three';
import { Brush } from '../core/Brush.js';

export const MESSAGE_TYPE = {
	READY: 'csg-ready',
	EVALUATE: 'csg-evaluate',
	RESULT: 'csg-result',
	ERROR: 'csg-error',
	ACK: 'csg-ack',
};

// 32-bit FNV-1a. Used to collapse a long version string into a cheap cache key.
export function fnv1a( str ) {

	let hash = 0x811c9dc5;
	for ( let i = 0, l = str.length; i < l; i ++ ) {

		hash ^= str.charCodeAt( i );
		hash = Math.imul( hash, 0x01000193 );

	}

	return hash >>> 0;

}

/**
 * Builds a stable fingerprint for a brush. Two brushes with the same fingerprint
 * produce identical CSG input, so the worker may reuse its cached copy.
 */
export function brushFingerprint( brush ) {

	const geometry = brush.geometry;
	const position = geometry.attributes.position;
	const index = geometry.index;
	const matrix = brush.matrixWorld.elements;

	let matrixHash = 0;
	for ( let i = 0; i < 16; i ++ ) {

		matrixHash = Math.imul( matrixHash ^ Math.round( matrix[ i ] * 1e5 ), 0x01000193 ) >>> 0;

	}

	return fnv1a( [
		geometry.uuid,
		position ? `${ position.count }:${ position.version }` : '0:0',
		index ? `${ index.count }:${ index.version }` : '-1:-1',
		geometry.groups.length,
		matrixHash,
	].join( '|' ) );

}

function serializeMaterial( material ) {

	if ( Array.isArray( material ) ) {

		return material.map( serializeMaterial );

	}

	if ( ! material ) {

		return null;

	}

	return {
		color: material.color ? material.color.getHex() : 0xffffff,
		opacity: material.opacity ?? 1,
		transparent: !! material.transparent,
		metalness: material.metalness ?? 0,
		roughness: material.roughness ?? 0.5,
		side: material.side ?? 0,
		flatShading: !! material.flatShading,
	};

}

function deserializeMaterial( data ) {

	if ( Array.isArray( data ) ) {

		return data.map( deserializeMaterial );

	}

	if ( ! data ) {

		return new MeshStandardMaterial();

	}

	return new MeshStandardMaterial( {
		color: data.color,
		opacity: data.opacity,
		transparent: data.transparent,
		metalness: data.metalness,
		roughness: data.roughness,
		side: data.side,
		flatShading: data.flatShading,
	} );

}

/**
 * Copies a geometry into a structured-clone friendly payload.
 * Typed arrays are always `.slice()`d so that transferring them cannot detach
 * buffers still referenced by the sender.
 */
export function serializeGeometry( geometry ) {

	const attributes = {};
	for ( const name in geometry.attributes ) {

		const attribute = geometry.attributes[ name ];
		if ( attribute.isInterleavedBufferAttribute ) {

			// Interleaved attributes are not supported by three-bvh-csg's
			// prepareGeometry() either, so mirror that limitation instead of
			// silently producing corrupt meshes.
			throw new Error( `serializeGeometry: interleaved attribute "${ name }" is not supported.` );

		}

		attributes[ name ] = {
			array: attribute.array.slice(),
			itemSize: attribute.itemSize,
			normalized: attribute.normalized,
		};

	}

	return {
		attributes,
		index: geometry.index
			? { array: geometry.index.array.slice(), itemSize: 1, normalized: false }
			: null,
		groups: geometry.groups.map( group => ( { ...group } ) ),
		drawRange: { ...geometry.drawRange },
	};

}

export function deserializeGeometry( data ) {

	const geometry = new BufferGeometry();

	for ( const name in data.attributes ) {

		const { array, itemSize, normalized } = data.attributes[ name ];
		geometry.setAttribute( name, new BufferAttribute( array, itemSize, normalized ) );

	}

	if ( data.index ) {

		geometry.setIndex( new BufferAttribute( data.index.array, 1, false ) );

	}

	geometry.groups = data.groups.map( group => ( { ...group } ) );
	if ( data.drawRange ) {

		geometry.setDrawRange( data.drawRange.start, data.drawRange.count );

	}

	return geometry;

}

export function serializeBrush( brush ) {

	return {
		geometry: serializeGeometry( brush.geometry ),
		matrixWorld: Float64Array.from( brush.matrixWorld.elements ),
		material: serializeMaterial( brush.material ),
	};

}

export function deserializeBrush( data ) {

	const geometry = deserializeGeometry( data.geometry );
	const material = deserializeMaterial( data.material );
	const brush = new Brush( geometry, material );

	brush.matrixWorld.fromArray( data.matrixWorld );
	brush.matrixWorld.decompose( brush.position, brush.quaternion, brush.scale );
	brush.matrix.copy( brush.matrixWorld );
	brush.updateMatrixWorld( true );

	return brush;

}

/**
 * Collects every transferable `ArrayBuffer` inside a brush descriptor so the
 * caller can hand them to `postMessage`'s transfer list.
 */
export function collectTransferables( payload, out = [] ) {

	if ( ! payload ) return out;

	if ( Array.isArray( payload ) ) {

		payload.forEach( item => collectTransferables( item, out ) );
		return out;

	}

	if ( payload.buffer instanceof ArrayBuffer ) {

		out.push( payload.buffer );
		return out;

	}

	if ( payload.attributes ) {

		for ( const name in payload.attributes ) {

			collectTransferables( payload.attributes[ name ].array, out );

		}

		if ( payload.index ) {

			collectTransferables( payload.index.array, out );

		}

		return out;

	}

	return out;

}

/** Cheap triangle count that respects the draw range, mirroring three-bvh-csg. */
export function countTriangles( geometry ) {

	const index = geometry.index;
	const position = geometry.attributes.position;
	const drawCount = geometry.drawRange.count;
	let total = index ? index.count / 3 : position.count / 3;
	if ( Number.isFinite( drawCount ) ) {

		total = Math.min( total, drawCount / 3 );

	}

	return Math.floor( total );

}
