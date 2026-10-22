/**
 * CSG Forge workbench entry point.
 *
 * Wires the document model to the worker-backed AsyncEvaluator and keeps the
 * main thread free: every boolean evaluation happens off-thread, and a slider
 * drag supersedes the in-flight job instead of queueing behind it.
 */
import { AsyncEvaluator } from '../../src/workers/AsyncEvaluator.js';
import {
	Doc,
	History,
	BrushStore,
	PRIMITIVES,
	OPERATIONS,
	PRESETS,
	createNode,
} from './graph.js';
import { Viewport } from './viewport.js';
import { exportGLB, exportSTL, exportOBJ, exportDocument, formatBytes } from './exporter.js';

const $ = selector => document.querySelector( selector );

const els = {
	presets: $( '#presets' ),
	chain: $( '#chain' ),
	nodeCount: $( '#node-count' ),
	addGrid: $( '#add-grid' ),
	inspector: $( '#inspector-body' ),
	inspectorKind: $( '#inspector-kind' ),
	viewport: $( '#viewport' ),
	undo: $( '#undo' ),
	redo: $( '#redo' ),
	exportBtn: $( '#export-btn' ),
	exportPanel: $( '#export-panel' ),
	autoRotate: $( '#auto-rotate' ),
	resetView: $( '#reset-view' ),
	status: $( '#status' ),
	statusText: $( '#status-text' ),
	hudTris: $( '#hud-tris' ),
	hudEval: $( '#hud-eval' ),
	hudReused: $( '#hud-reused' ),
	hudFps: $( '#hud-fps' ),
	hudQueue: $( '#hud-queue' ),
	hudMode: $( '#hud-mode' ),
	sectionEnabled: $( '#section-enabled' ),
	sectionAxis: $( '#section-axis' ),
	sectionOffset: $( '#section-offset' ),
	mobileTabs: $( '#mobile-tabs' ),
	chainPanel: $( '#chain-panel' ),
	inspectorPanel: $( '#inspector' ),
};

const SWATCHES = [ 0xd9a066, 0xc9a227, 0x8fb996, 0x7f9cf5, 0xb98bdb, 0xe08a8a, 0x9aa7b8, 0x5c6675 ];

// ── State ────────────────────────────────────────────────────────────────

const doc = new Doc( PRESETS[ 'Mounting Bracket' ]() );
const store = new BrushStore();
const history = new History();
const viewport = new Viewport( els.viewport );
const evaluator = new AsyncEvaluator( {
	workers: 1,
	createWorker: () => new Worker( new URL( '../../src/workers/csg.worker.js', import.meta.url ), { type: 'module', name: 'csg-forge' } ),
} );

let selectedId = doc.nodes[ 0 ].id;
let controller = null;
let scheduled = false;
let lastStats = null;
let firstFrameDone = false;
let evalSeq = 0;

// ── Evaluation pipeline ──────────────────────────────────────────────────

function setStatus( text, state = 'idle' ) {

	els.statusText.textContent = text;
	els.status.classList.toggle( 'busy', state === 'busy' );
	els.status.classList.toggle( 'error', state === 'error' );
	els.status.classList.toggle( 'show', state !== 'idle' || text !== 'Ready' );

}

function formatMs( ms ) {

	if ( ! Number.isFinite( ms ) ) return '—';
	if ( ms < 1 ) return `${ ms.toFixed( 2 ) } ms`;
	if ( ms < 100 ) return `${ ms.toFixed( 1 ) } ms`;
	return `${ Math.round( ms ) } ms`;

}

function scheduleEvaluate() {

	if ( scheduled ) return;
	scheduled = true;
	requestAnimationFrame( () => {

		scheduled = false;
		runEvaluate();

	} );

}

async function runEvaluate() {

	if ( controller ) controller.abort();
	const mine = new AbortController();
	controller = mine;

	const active = doc.nodes.filter( node => node.enabled );
	if ( active.length === 0 ) {

		setStatus( 'Nothing to evaluate', 'error' );
		return;

	}

	const chain = active.map( node => ( { brush: store.get( node ), op: node.op } ) );
	setStatus( 'Computing…', 'busy' );
	updateQueue();

	try {

		const { brush, stats } = await evaluator.evaluateChain( chain, { signal: mine.signal } );
		if ( controller !== mine ) return;

		viewport.setResult( brush, { frame: ! firstFrameDone } );
		firstFrameDone = true;
		lastStats = stats;
		evalSeq ++;
		renderHud( stats );
		setStatus( `Ready · ${ formatMs( stats.totalMs ) }` );

	} catch ( error ) {

		if ( error && error.name === 'AbortError' ) return;
		setStatus( error.message || 'Evaluation failed', 'error' );
		console.error( error );

	} finally {

		if ( controller === mine ) {

			controller = null;
			updateQueue();

		}

	}

}

function updateQueue() {

	els.hudQueue.textContent = String( evaluator.pending );

}

function renderHud( stats ) {

	if ( ! stats ) return;
	els.hudTris.textContent = stats.triangles.toLocaleString( 'en-US' );
	els.hudEval.textContent = formatMs( stats.totalMs );
	els.hudReused.textContent = `${ stats.reusedStages }/${ doc.nodes.filter( n => n.enabled ).length }`;

}

viewport.onFps( fps => {

	els.hudFps.textContent = fps.toFixed( 0 );

} );

// ── Chain rendering ──────────────────────────────────────────────────────

function opMeta( value ) {

	return OPERATIONS.find( op => op.value === value ) ?? OPERATIONS[ 0 ];

}

function summarise( node ) {

	const p = node.params;
	switch ( node.kind ) {

		case 'box':
			return `${ p.width }×${ p.height }×${ p.depth }`;
		case 'sphere':
			return `r${ p.radius } · ${ p.widthSegments }seg`;
		case 'cylinder':
			return `r${ p.radiusTop }/${ p.radiusBottom } · h${ p.height }`;
		case 'cone':
			return `r${ p.radius } · h${ p.height }`;
		case 'torus':
			return `r${ p.radius } · t${ p.tube }`;
		default:
			return '';

	}

}

function renderChain() {

	const fragment = document.createDocumentFragment();

	doc.nodes.forEach( ( node, index ) => {

		const meta = opMeta( node.op );
		const isBase = index === 0;

		const row = document.createElement( 'div' );
		row.className = `node op-${ meta.className.replace( 'op-', '' ) }${ isBase ? ' node-base' : '' }`;
		row.dataset.id = node.id;
		row.setAttribute( 'role', 'option' );
		row.setAttribute( 'aria-selected', String( node.id === selectedId ) );
		row.tabIndex = 0;
		if ( ! isBase ) row.draggable = true;
		if ( ! node.enabled ) row.style.opacity = '0.45';

		const bar = document.createElement( 'span' );
		bar.className = 'node-bar';

		const icon = document.createElement( 'span' );
		icon.className = 'node-icon';
		icon.textContent = PRIMITIVES[ node.kind ].icon;

		const main = document.createElement( 'span' );
		main.className = 'node-main';
		const title = document.createElement( 'span' );
		title.className = 'node-title';
		title.textContent = isBase ? `${ PRIMITIVES[ node.kind ].label } · base` : PRIMITIVES[ node.kind ].label;
		const metaLine = document.createElement( 'span' );
		metaLine.className = 'node-meta';
		metaLine.textContent = summarise( node );
		main.append( title, metaLine );

		const opTag = document.createElement( 'span' );
		opTag.className = 'node-op';
		opTag.textContent = isBase ? 'base' : meta.glyph;

		const actions = document.createElement( 'span' );
		actions.className = 'node-actions';

		const mute = document.createElement( 'button' );
		mute.className = 'mini-btn';
		mute.textContent = node.enabled ? '◉' : '○';
		mute.title = node.enabled ? 'Mute from chain' : 'Unmute';
		mute.addEventListener( 'click', event => {

			event.stopPropagation();
			node.enabled = ! node.enabled;
			doc.touch( 'structure' );

		} );

		const duplicate = document.createElement( 'button' );
		duplicate.className = 'mini-btn';
		duplicate.textContent = '⧉';
		duplicate.title = 'Duplicate';
		duplicate.addEventListener( 'click', event => {

			event.stopPropagation();
			const copy = doc.duplicate( node.id );
			if ( copy ) selectedId = copy.id;

		} );

		const remove = document.createElement( 'button' );
		remove.className = 'mini-btn';
		remove.textContent = '✕';
		remove.title = 'Remove';
		remove.disabled = isBase;
		remove.addEventListener( 'click', event => {

			event.stopPropagation();
			doc.remove( node.id );
			if ( selectedId === node.id ) selectedId = doc.nodes[ 0 ].id;

		} );

		actions.append( mute, duplicate, remove );

		row.append( bar, icon, main, opTag, actions );

		row.addEventListener( 'click', () => {

			selectedId = node.id;
			renderChain();
			renderInspector();

		} );
		row.addEventListener( 'keydown', event => {

			if ( event.key === 'Enter' || event.key === ' ' ) {

				event.preventDefault();
				row.click();

			}

		} );

		if ( ! isBase ) {

			row.addEventListener( 'dragstart', event => {

				event.dataTransfer.setData( 'text/plain', node.id );
				event.dataTransfer.effectAllowed = 'move';

			} );
			row.addEventListener( 'dragover', event => {

				event.preventDefault();
				event.dataTransfer.dropEffect = 'move';
				row.style.borderTopColor = 'var(--accent)';

			} );
			row.addEventListener( 'dragleave', () => {

				row.style.borderTopColor = '';

			} );
			row.addEventListener( 'drop', event => {

				event.preventDefault();
				row.style.borderTopColor = '';
				const draggedId = event.dataTransfer.getData( 'text/plain' );
				if ( draggedId && draggedId !== node.id ) {

					doc.reorder( draggedId, node.id );
					selectedId = draggedId;

				}

			} );

		}

		fragment.append( row );

	} );

	els.chain.replaceChildren( fragment );
	els.nodeCount.textContent = String( doc.nodes.length );
	els.undo.disabled = ! history.canUndo;
	els.redo.disabled = ! history.canRedo;

}

// ── Inspector ────────────────────────────────────────────────────────────

function field( label, value, min, max, step, onInput ) {

	const wrap = document.createElement( 'div' );
	wrap.className = 'field';

	const head = document.createElement( 'div' );
	head.className = 'field-head';
	const labelEl = document.createElement( 'label' );
	labelEl.textContent = label;
	const output = document.createElement( 'output' );
	output.textContent = String( value );
	head.append( labelEl, output );

	const input = document.createElement( 'input' );
	input.type = 'range';
	input.min = String( min );
	input.max = String( max );
	input.step = String( step );
	input.value = String( value );
	input.addEventListener( 'input', () => {

		const next = Number( input.value );
		output.textContent = String( next );
		onInput( next );

	} );

	wrap.append( head, input );
	return wrap;

}

function vecRow( axis, value, onChange ) {

	const row = document.createElement( 'div' );
	row.className = 'vec-row';

	const axisEl = document.createElement( 'span' );
	axisEl.className = 'axis';
	axisEl.textContent = axis;

	const slider = document.createElement( 'input' );
	slider.type = 'range';
	slider.min = '-3';
	slider.max = '3';
	slider.step = '0.02';
	slider.value = String( value );

	const number = document.createElement( 'input' );
	number.type = 'number';
	number.min = '-8';
	number.max = '8';
	number.step = '0.05';
	number.value = String( Number( value ).toFixed( 2 ) );

	slider.addEventListener( 'input', () => {

		const next = Number( slider.value );
		number.value = next.toFixed( 2 );
		onChange( next );

	} );

	number.addEventListener( 'input', () => {

		const next = Number( number.value );
		if ( Number.isNaN( next ) ) return;
		slider.value = String( Math.max( - 3, Math.min( 3, next ) ) );
		onChange( next );

	} );

	row.append( axisEl, slider, number );
	return row;

}

function group( title ) {

	const wrap = document.createElement( 'div' );
	wrap.className = 'group';
	const heading = document.createElement( 'h3' );
	heading.className = 'group-title';
	heading.textContent = title;
	wrap.append( heading );
	return wrap;

}

function renderInspector() {

	const node = doc.get( selectedId );
	els.inspector.replaceChildren();

	if ( ! node ) {

		els.inspectorKind.textContent = '—';
		const empty = document.createElement( 'p' );
		empty.className = 'empty';
		empty.textContent = 'Select a node in the modifier chain.';
		els.inspector.append( empty );
		return;

	}

	const isBase = doc.nodes[ 0 ].id === node.id;
	els.inspectorKind.textContent = PRIMITIVES[ node.kind ].label;

	if ( ! isBase ) {

		const opGroup = group( 'Boolean operation' );
		const grid = document.createElement( 'div' );
		grid.className = 'op-grid';

		OPERATIONS.forEach( op => {

			const button = document.createElement( 'button' );
			button.className = 'op-btn';
			button.dataset.op = String( op.value );
			button.setAttribute( 'aria-pressed', String( node.op === op.value ) );
			const glyph = document.createElement( 'i' );
			glyph.textContent = op.glyph;
			const label = document.createElement( 'span' );
			label.textContent = op.label;
			button.append( glyph, label );
			button.addEventListener( 'click', () => {

				node.op = op.value;
				doc.touch( 'structure' );

			} );
			grid.append( button );

		} );

		opGroup.append( grid );
		els.inspector.append( opGroup );

	}

	const shapeGroup = group( 'Geometry' );
	PRIMITIVES[ node.kind ].params.forEach( param => {

		shapeGroup.append( field(
			param.label,
			node.params[ param.key ],
			param.min,
			param.max,
			param.step,
			value => {

				doc.updateParam( node.id, param.key, value );

			},
		) );

	} );
	els.inspector.append( shapeGroup );

	const transformGroup = group( 'Position' );
	[ 'x', 'y', 'z' ].forEach( ( axis, index ) => {

		transformGroup.append( vecRow( axis.toUpperCase(), node.transform.position[ index ], value => {

			node.transform.position[ index ] = value;
			doc.touch( 'param' );

		} ) );

	} );
	els.inspector.append( transformGroup );

	const rotationGroup = group( 'Rotation (rad)' );
	[ 'x', 'y', 'z' ].forEach( ( axis, index ) => {

		rotationGroup.append( vecRow( axis.toUpperCase(), node.transform.rotation[ index ], value => {

			node.transform.rotation[ index ] = value;
			doc.touch( 'param' );

		} ) );

	} );
	els.inspector.append( rotationGroup );

	const colorGroup = group( 'Material' );
	const swatches = document.createElement( 'div' );
	swatches.className = 'swatches';
	SWATCHES.forEach( hex => {

		const button = document.createElement( 'button' );
		button.className = 'swatch';
		button.style.background = `#${ hex.toString( 16 ).padStart( 6, '0' ) }`;
		button.setAttribute( 'aria-pressed', String( node.color === hex ) );
		button.title = `#${ hex.toString( 16 ).padStart( 6, '0' ) }`;
		button.addEventListener( 'click', () => {

			node.color = hex;
			doc.touch( 'structure' );

		} );
		swatches.append( button );

	} );
	colorGroup.append( swatches );
	els.inspector.append( colorGroup );

	if ( ! isBase ) {

		const hint = document.createElement( 'p' );
		hint.className = 'hint';
		hint.innerHTML = `<b>${ opMeta( node.op ).label }</b> applies this solid against everything above it in the chain. Drag the row to reorder — the worker reuses every stage before the first changed node.`;
		els.inspector.append( hint );

	}

}

// ── Commit / history ─────────────────────────────────────────────────────

let snapshotTimer = 0;

/**
 * Single source of truth for "the document changed": every mutation path ends
 * up here, so no interaction can silently skip a re-render or a re-evaluation.
 */
doc.onChange( reason => {

	if ( reason === 'restore' ) {

		store.prune( new Set( doc.nodes.map( n => n.id ) ) );
		if ( ! doc.get( selectedId ) ) selectedId = doc.nodes[ 0 ].id;

	}

	renderChain();
	renderInspector();
	scheduleEvaluate();
	updateQueue();

	if ( reason === 'param' ) {

		// Coalesce a slider drag into one undo entry instead of hundreds.
		clearTimeout( snapshotTimer );
		snapshotTimer = setTimeout( () => {

			history.push( doc.snapshot() );
			renderChain();

		}, 420 );

	} else {

		clearTimeout( snapshotTimer );
		history.push( doc.snapshot() );

	}

} );

function applySnapshot( snapshot ) {

	if ( ! snapshot ) return;
	doc.restore( snapshot );

}

// ── Static UI ────────────────────────────────────────────────────────────

Object.entries( PRIMITIVES ).forEach( ( [ kind, meta ] ) => {

	const button = document.createElement( 'button' );
	button.title = `Add ${ meta.label }`;
	const icon = document.createElement( 'span' );
	icon.textContent = meta.icon;
	const label = document.createElement( 'small' );
	label.textContent = meta.short ?? meta.label.slice( 0, 4 );
	button.append( icon, label );
	button.addEventListener( 'click', () => {

		const node = createNode( kind, { op: 1 } );
		node.transform.position[ 1 ] = 0.6;
		// Append to the end of the chain: the newest modifier is the last one
		// applied, which matches how people reason about a modifier stack.
		doc.add( node );
		selectedId = node.id;

	} );
	els.addGrid.append( button );

} );

Object.keys( PRESETS ).forEach( ( name, index ) => {

	const button = document.createElement( 'button' );
	button.className = 'preset-btn';
	button.textContent = name;
	button.setAttribute( 'aria-pressed', String( index === 0 ) );
	button.addEventListener( 'click', () => {

		els.presets.querySelectorAll( '.preset-btn' ).forEach( el => el.setAttribute( 'aria-pressed', 'false' ) );
		button.setAttribute( 'aria-pressed', 'true' );

		doc.nodes = PRESETS[ name ]();
		selectedId = doc.nodes[ 0 ].id;
		store.clear();
		firstFrameDone = false;
		history.past.length = 0;
		history.future.length = 0;
		history.push( doc.snapshot() );
		renderChain();
		renderInspector();
		scheduleEvaluate();

	} );
	els.presets.append( button );

} );

els.undo.addEventListener( 'click', () => {

	applySnapshot( history.undo() );

} );

els.redo.addEventListener( 'click', () => {

	applySnapshot( history.redo() );

} );

els.resetView.addEventListener( 'click', () => viewport.resetView() );

els.autoRotate.addEventListener( 'change', () => viewport.setAutoRotate( els.autoRotate.checked ) );

document.querySelectorAll( '.seg' ).forEach( button => {

	button.addEventListener( 'click', () => {

		document.querySelectorAll( '.seg' ).forEach( el => el.setAttribute( 'aria-pressed', 'false' ) );
		button.setAttribute( 'aria-pressed', 'true' );
		viewport.setMode( button.dataset.mode );

	} );

} );

els.sectionEnabled.addEventListener( 'change', () => {

	viewport.setSection( { enabled: els.sectionEnabled.checked } );

} );

els.sectionAxis.addEventListener( 'change', () => {

	viewport.setSection( { axis: els.sectionAxis.value } );

} );

els.sectionOffset.addEventListener( 'input', () => {

	viewport.setSection( { offset: Number( els.sectionOffset.value ) } );

} );

// Export menu
els.exportBtn.addEventListener( 'click', event => {

	event.stopPropagation();
	const open = els.exportPanel.classList.toggle( 'open' );
	els.exportBtn.setAttribute( 'aria-expanded', String( open ) );

} );

document.addEventListener( 'click', () => {

	els.exportPanel.classList.remove( 'open' );
	els.exportBtn.setAttribute( 'aria-expanded', 'false' );

} );

els.exportPanel.addEventListener( 'click', async event => {

	const button = event.target.closest( '[data-export]' );
	if ( ! button ) return;
	const kind = button.dataset.export;
	const mesh = viewport.current;
	if ( ! mesh && kind !== 'json' ) {

		setStatus( 'Nothing to export yet', 'error' );
		return;

	}

	try {

		let size = 0;
		if ( kind === 'glb' ) size = await exportGLB( mesh );
		if ( kind === 'stl' ) size = exportSTL( mesh );
		if ( kind === 'obj' ) size = exportOBJ( mesh );
		if ( kind === 'json' ) size = exportDocument( doc );
		setStatus( `Exported ${ kind.toUpperCase() } · ${ formatBytes( size ) }` );

	} catch ( error ) {

		setStatus( `Export failed: ${ error.message }`, 'error' );
		console.error( error );

	}

} );

// Keyboard shortcuts
window.addEventListener( 'keydown', event => {

	const typing = /^(INPUT|SELECT|TEXTAREA)$/.test( document.activeElement?.tagName ?? '' );
	if ( typing ) return;

	if ( ( event.ctrlKey || event.metaKey ) && event.key.toLowerCase() === 'z' ) {

		event.preventDefault();
		applySnapshot( event.shiftKey ? history.redo() : history.undo() );

	} else if ( event.key === 'Delete' || event.key === 'Backspace' ) {

		if ( doc.nodes[ 0 ].id === selectedId ) return;
		event.preventDefault();
		doc.remove( selectedId );
		selectedId = doc.nodes[ 0 ].id;

	} else if ( event.key >= '1' && event.key <= '3' ) {

		const modes = [ 'solid', 'wireframe', 'xray' ];
		const mode = modes[ Number( event.key ) - 1 ];
		document.querySelector( `[data-mode="${ mode }"]` )?.click();

	}

} );

// Mobile sheets
els.mobileTabs.addEventListener( 'click', event => {

	const button = event.target.closest( '[data-sheet]' );
	if ( ! button ) return;
	const target = button.dataset.sheet;

	els.mobileTabs.querySelectorAll( 'button' ).forEach( el => el.setAttribute( 'aria-pressed', String( el === button ) ) );
	els.chainPanel.classList.toggle( 'sheet-open', target === 'chain' );
	els.inspectorPanel.classList.toggle( 'sheet-open', target === 'inspector' );
	viewport.resize();

} );

// ── Boot ─────────────────────────────────────────────────────────────────

history.push( doc.snapshot() );
renderChain();
renderInspector();
els.hudMode.textContent = evaluator.mode === 'worker' ? `worker ×${ evaluator.workers }` : 'main thread';
setStatus( 'Computing…', 'busy' );
scheduleEvaluate();

window.__csgForge = {
	doc,
	evaluator,
	viewport,
	store,
	getStats: () => lastStats,
	touch: reason => doc.touch( reason ),
	scheduleEvaluate,
	select( id ) {

		selectedId = id;
		renderChain();
		renderInspector();

	},
	getSelected: () => selectedId,
	getEvalSeq: () => evalSeq,
	whenIdle: () => evaluator.whenIdle(),
	whenReady: () => evaluator.whenReady(),
};

// Benchmark hook — dynamically imported so the harness never ships in the
// normal workbench bundle path.
window.__runBench = async ( options = {} ) => {

	const { runBench } = await import( './bench.js' );
	return runBench( { nodes: doc.nodes, ...options } );

};

// Step-wise probes, used by the verification harness to isolate a hang.
window.__benchProbe = async ( kind, iterations ) => {

	const bench = await import( './bench.js' );
	switch ( kind ) {

		case 'cpu-main': return bench.cpuLoop( iterations );
		case 'cpu-worker': return bench.probeWorkerCpu( iterations );
		case 'solve-main': return bench.solveLoop( iterations );
		case 'solve-worker': return bench.probeWorkerSolve( iterations );
		default: throw new Error( `unknown probe "${ kind }"` );

	}

};
