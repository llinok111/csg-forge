/**
 * Document model for the CSG workbench.
 *
 * A document is a *linear modifier chain*: one base solid followed by N
 * modifiers, each carrying the boolean operation applied against the running
 * result. This is the model Tinkercad-style editors use because it maps
 * directly onto `Evaluator.evaluate( result, modifier, op )` and keeps the
 * prefix cache in the worker meaningful.
 */
import {
	BoxGeometry,
	SphereGeometry,
	CylinderGeometry,
	ConeGeometry,
	TorusGeometry,
	MeshStandardMaterial,
} from 'three';
import {
	Brush,
	ADDITION,
	SUBTRACTION,
	INTERSECTION,
	DIFFERENCE,
} from '../../src/index.js';

export const OPERATIONS = [
	{ value: ADDITION, label: 'Union', glyph: '∪', className: 'op-union' },
	{ value: SUBTRACTION, label: 'Subtract', glyph: '−', className: 'op-subtract' },
	{ value: INTERSECTION, label: 'Intersect', glyph: '∩', className: 'op-intersect' },
	{ value: DIFFERENCE, label: 'Difference', glyph: '⊕', className: 'op-difference' },
];

export const PRIMITIVES = {
	box: {
		label: 'Box',
		short: 'BOX',
		icon: '▣',
		params: [
			{ key: 'width', label: 'Width', min: 0.1, max: 6, step: 0.05, value: 2 },
			{ key: 'height', label: 'Height', min: 0.1, max: 6, step: 0.05, value: 2 },
			{ key: 'depth', label: 'Depth', min: 0.1, max: 6, step: 0.05, value: 2 },
			{ key: 'segments', label: 'Segments', min: 1, max: 4, step: 1, value: 1 },
		],
	},
	sphere: {
		label: 'Sphere',
		short: 'SPH',
		icon: '●',
		params: [
			{ key: 'radius', label: 'Radius', min: 0.1, max: 4, step: 0.05, value: 1.2 },
			{ key: 'widthSegments', label: 'Segments', min: 8, max: 96, step: 2, value: 40 },
		],
	},
	cylinder: {
		label: 'Cylinder',
		short: 'CYL',
		icon: '⬭',
		params: [
			{ key: 'radiusTop', label: 'Top R', min: 0, max: 3, step: 0.05, value: 0.8 },
			{ key: 'radiusBottom', label: 'Base R', min: 0, max: 3, step: 0.05, value: 0.8 },
			{ key: 'height', label: 'Height', min: 0.1, max: 8, step: 0.05, value: 2.4 },
			{ key: 'radialSegments', label: 'Segments', min: 6, max: 96, step: 2, value: 40 },
		],
	},
	cone: {
		label: 'Cone',
		short: 'CONE',
		icon: '▲',
		params: [
			{ key: 'radius', label: 'Radius', min: 0.1, max: 3, step: 0.05, value: 1 },
			{ key: 'height', label: 'Height', min: 0.1, max: 8, step: 0.05, value: 2.2 },
			{ key: 'radialSegments', label: 'Segments', min: 6, max: 96, step: 2, value: 40 },
		],
	},
	torus: {
		label: 'Torus',
		short: 'TOR',
		icon: '◎',
		params: [
			{ key: 'radius', label: 'Radius', min: 0.2, max: 3, step: 0.05, value: 1.1 },
			{ key: 'tube', label: 'Tube', min: 0.05, max: 1, step: 0.02, value: 0.3 },
			{ key: 'radialSegments', label: 'Segments', min: 6, max: 64, step: 2, value: 24 },
			{ key: 'tubularSegments', label: 'Tubular', min: 12, max: 160, step: 4, value: 72 },
		],
	},
};

export function defaultParams( kind ) {

	const params = {};
	for ( const param of PRIMITIVES[ kind ].params ) {

		params[ param.key ] = param.value;

	}

	return params;

}

let nodeSeq = 0;

export function createNode( kind, overrides = {} ) {

	return {
		id: `node-${ ++ nodeSeq }`,
		kind,
		op: ADDITION,
		params: defaultParams( kind ),
		transform: { position: [ 0, 0, 0 ], rotation: [ 0, 0, 0 ], scale: [ 1, 1, 1 ] },
		color: 0xd9a066,
		enabled: true,
		...overrides,
	};

}

export function createGeometry( node ) {

	const p = node.params;
	switch ( node.kind ) {

		case 'box':
			return new BoxGeometry( p.width, p.height, p.depth, p.segments, p.segments, p.segments );
		case 'sphere':
			return new SphereGeometry( p.radius, p.widthSegments, Math.max( 6, p.widthSegments >> 1 ) );
		case 'cylinder':
			return new CylinderGeometry( p.radiusTop, p.radiusBottom, p.height, p.radialSegments, 1 );
		case 'cone':
			return new ConeGeometry( p.radius, p.height, p.radialSegments, 1 );
		case 'torus':
			return new TorusGeometry( p.radius, p.tube, p.radialSegments, p.tubularSegments );
		default:
			throw new Error( `Unknown primitive "${ node.kind }"` );

	}

}

function signature( node ) {

	return JSON.stringify( [ node.kind, node.params, node.transform, node.color ] );

}

/**
 * Keeps one `Brush` instance per node id and rebuilds its geometry only when the
 * node's parameters actually change. This matters: the worker keys its geometry
 * cache on a fingerprint derived from the Brush, so reusing the Brush object is
 * what turns "drag a slider" into a single CSG evaluation instead of a full
 * re-upload plus full re-evaluation.
 */
export class BrushStore {

	constructor() {

		this._entries = new Map();

	}

	get( node ) {

		const sig = signature( node );
		const existing = this._entries.get( node.id );

		if ( existing && existing.sig === sig ) {

			return existing.brush;

		}

		const brush = existing ? existing.brush : new Brush();
		if ( brush.geometry ) brush.geometry.dispose();
		brush.geometry = createGeometry( node );

		const [ px, py, pz ] = node.transform.position;
		const [ rx, ry, rz ] = node.transform.rotation;
		const [ sx, sy, sz ] = node.transform.scale;
		brush.position.set( px, py, pz );
		brush.rotation.set( rx, ry, rz );
		brush.scale.set( sx, sy, sz );
		brush.updateMatrixWorld( true );
		brush.matrix.copy( brush.matrixWorld );

		if ( ! brush.material || Array.isArray( brush.material ) ) {

			brush.material = new MeshStandardMaterial();

		}

		brush.material.color.setHex( node.color );
		brush.material.metalness = 0.15;
		brush.material.roughness = 0.55;

		this._entries.set( node.id, { sig, brush } );
		return brush;

	}

	prune( validIds ) {

		for ( const id of [ ...this._entries.keys() ] ) {

			if ( ! validIds.has( id ) ) {

				this._entries.get( id ).brush.geometry.dispose();
				this._entries.delete( id );

			}

		}

	}

	clear() {

		for ( const { brush } of this._entries.values() ) {

			brush.geometry.dispose();

		}

		this._entries.clear();

	}

}

/** Immutable-ish document with snapshot-based undo. */
export class Doc {

	constructor( nodes ) {

		this.nodes = nodes;
		this.listeners = new Set();

	}

	onChange( fn ) {

		this.listeners.add( fn );
		return () => this.listeners.delete( fn );

	}

	_emit( reason ) {

		this.listeners.forEach( fn => fn( reason, this ) );

	}

	/** Notify listeners after an in-place mutation (node.op = …, transform[i] = …). */
	touch( reason = 'param' ) {

		this._emit( reason );

	}

	snapshot() {

		return JSON.stringify( this.nodes );

	}

	restore( snapshot ) {

		this.nodes = JSON.parse( snapshot );
		this._emit( 'restore' );

	}

	get( id ) {

		return this.nodes.find( node => node.id === id );

	}

	add( node, afterId ) {

		if ( afterId ) {

			const index = this.nodes.findIndex( n => n.id === afterId );
			this.nodes.splice( index + 1, 0, node );

		} else {

			this.nodes.push( node );

		}

		this._emit( 'structure' );
		return node;

	}

	remove( id ) {

		if ( this.nodes.length <= 1 ) return;
		const index = this.nodes.findIndex( n => n.id === id );
		if ( index === - 1 ) return;
		this.nodes.splice( index, 1 );
		this._emit( 'structure' );

	}

	duplicate( id ) {

		const node = this.get( id );
		if ( ! node ) return null;
		const copy = JSON.parse( JSON.stringify( node ) );
		copy.id = `node-${ ++ nodeSeq }`;
		copy.transform.position[ 0 ] += 0.6;
		copy.op = node.op;
		return this.add( copy, id );

	}

	move( id, delta ) {

		const index = this.nodes.findIndex( n => n.id === id );
		const target = index + delta;
		if ( index < 1 || target < 1 || target >= this.nodes.length ) return;
		const [ node ] = this.nodes.splice( index, 1 );
		this.nodes.splice( target, 0, node );
		this._emit( 'structure' );

	}

	/** Drag-and-drop reorder: move `fromId` into `toId`'s slot. The base node is immovable. */
	reorder( fromId, toId ) {

		const from = this.nodes.findIndex( n => n.id === fromId );
		if ( from < 1 ) return;
		const [ node ] = this.nodes.splice( from, 1 );
		const to = this.nodes.findIndex( n => n.id === toId );
		if ( to < 1 ) {

			// Dropped onto the base row — send it to the end instead of losing it.
			this.nodes.push( node );

		} else {

			this.nodes.splice( to, 0, node );

		}

		this._emit( 'structure' );

	}

	update( id, patch, reason = 'param' ) {

		const node = this.get( id );
		if ( ! node ) return;
		Object.assign( node, patch );
		this._emit( reason );

	}

	updateParam( id, key, value ) {

		const node = this.get( id );
		if ( ! node ) return;
		node.params[ key ] = value;
		this._emit( 'param' );

	}

}

/** Ring of snapshots so undo/redo never allocates more than `limit` entries. */
export class History {

	constructor( limit = 60 ) {

		this.limit = limit;
		this.past = [];
		this.future = [];

	}

	push( snapshot ) {

		if ( this.past[ this.past.length - 1 ] === snapshot ) return false;
		this.past.push( snapshot );
		if ( this.past.length > this.limit ) this.past.shift();
		this.future.length = 0;
		return true;

	}

	undo() {

		if ( this.past.length < 2 ) return null;
		const previous = this.past[ this.past.length - 2 ];
		const discarded = this.past.pop();
		this.future.push( discarded );
		return previous;

	}

	redo() {

		if ( ! this.future.length ) return null;
		const next = this.future.pop();
		this.past.push( next );
		return next;

	}

	get canUndo() {

		return this.past.length > 1;

	}

	get canRedo() {

		return this.future.length > 0;

	}

}

export const PRESETS = {
	'Mounting Bracket': () => [
		createNode( 'box', { params: { width: 3, height: 0.5, depth: 2, segments: 1 }, color: 0xc9a227 } ),
		createNode( 'cylinder', {
			op: SUBTRACTION,
			params: { radiusTop: 0.42, radiusBottom: 0.42, height: 1.4, radialSegments: 40 },
			transform: { position: [ - 1, 0, 0 ], rotation: [ 0, 0, 0 ], scale: [ 1, 1, 1 ] },
			color: 0x8b5cf6,
		} ),
		createNode( 'cylinder', {
			op: SUBTRACTION,
			params: { radiusTop: 0.42, radiusBottom: 0.42, height: 1.4, radialSegments: 40 },
			transform: { position: [ 1, 0, 0 ], rotation: [ 0, 0, 0 ], scale: [ 1, 1, 1 ] },
			color: 0x8b5cf6,
		} ),
		createNode( 'box', {
			op: SUBTRACTION,
			params: { width: 1.1, height: 1.2, depth: 1.1, segments: 1 },
			transform: { position: [ 0, 0.35, 0.7 ], rotation: [ 0, 0, 0 ], scale: [ 1, 1, 1 ] },
			color: 0x8b5cf6,
		} ),
	],
	'Vented Cube': () => [
		createNode( 'box', { params: { width: 2.4, height: 2.4, depth: 2.4, segments: 1 }, color: 0xd9a066 } ),
		createNode( 'sphere', {
			op: SUBTRACTION,
			params: { radius: 1.55, widthSegments: 48 },
			transform: { position: [ 0, 0, 0 ], rotation: [ 0, 0, 0 ], scale: [ 1, 1, 1 ] },
			color: 0x8b5cf6,
		} ),
		createNode( 'cylinder', {
			op: INTERSECTION,
			params: { radiusTop: 1.35, radiusBottom: 1.35, height: 3.4, radialSegments: 6 },
			transform: { position: [ 0, 0, 0 ], rotation: [ 0, 0, 0 ], scale: [ 1, 1, 1 ] },
			color: 0x38bdf8,
		} ),
		createNode( 'torus', {
			op: SUBTRACTION,
			params: { radius: 1.05, tube: 0.16, radialSegments: 24, tubularSegments: 80 },
			transform: { position: [ 0, 0, 0 ], rotation: [ Math.PI / 2, 0, 0 ], scale: [ 1, 1, 1 ] },
			color: 0xf87171,
		} ),
	],
	'Gear Blank': () => {

		const nodes = [
			createNode( 'cylinder', {
				params: { radiusTop: 1.5, radiusBottom: 1.5, height: 0.5, radialSegments: 64 },
				color: 0xc9a227,
			} ),
		];
		const teeth = 10;
		for ( let i = 0; i < teeth; i ++ ) {

			const angle = ( i / teeth ) * Math.PI * 2;
			nodes.push( createNode( 'box', {
				op: ADDITION,
				params: { width: 0.34, height: 0.5, depth: 0.3, segments: 1 },
				transform: {
					position: [ Math.cos( angle ) * 1.58, 0, Math.sin( angle ) * 1.58 ],
					rotation: [ 0, - angle, 0 ],
					scale: [ 1, 1, 1 ],
				},
				color: 0xc9a227,
			} ) );

		}

		nodes.push( createNode( 'cylinder', {
			op: SUBTRACTION,
			params: { radiusTop: 0.5, radiusBottom: 0.5, height: 1.2, radialSegments: 48 },
			color: 0x8b5cf6,
		} ) );
		nodes.push( createNode( 'cylinder', {
			op: SUBTRACTION,
			params: { radiusTop: 0.22, radiusBottom: 0.22, height: 1.2, radialSegments: 32 },
			transform: { position: [ 1.05, 0, 0 ], rotation: [ 0, 0, 0 ], scale: [ 1, 1, 1 ] },
			color: 0x8b5cf6,
		} ) );
		return nodes;

	},
};
