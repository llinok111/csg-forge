/**
 * CSG Forge — full verification harness.
 *
 * Proves the workbench actually works rather than merely rendering a shell:
 *
 *   1. clean load (no console errors, no failed requests)
 *   2. DOM geometry — regions inside the viewport, no horizontal overflow
 *   3. WebGL output — the canvas is decoded and measured (background estimate,
 *      ink coverage, palette spread, warm/cool split), so a blank canvas fails
 *   4. interaction chain — presets, primitives, selection, parameter edit,
 *      display modes, section plane, undo/redo, all four export formats
 *   5. responsive layouts at three widths
 *
 * Run: node scripts/verify.mjs [--url=...] [--out=...]
 */
import { chromium } from 'playwright-core';
import { PNG } from 'pngjs';
import fs from 'node:fs';
import path from 'node:path';
import { ensureServer, closeServer, DEFAULT_URL } from './_server.mjs';

const args = Object.fromEntries(
	process.argv.slice( 2 ).map( ( a ) => {

		const [ k, v ] = a.replace( /^--/, '' ).split( '=' );
		return [ k, v ?? true ];

	} )
);

const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const URL = args.url || DEFAULT_URL;
const OUT = path.resolve( args.out || 'docs/shots' );
fs.mkdirSync( OUT, { recursive: true } );

const results = { url: URL, shots: [], interactions: {}, errors: [], failed: [] };
const assert = ( cond, message ) => {

	if ( ! cond ) throw new Error( `ASSERT FAILED: ${message}` );

};

/* ------------------------------ pixel maths ------------------------------ */

function analyse( file ) {

	const png = PNG.sync.read( fs.readFileSync( file ) );
	const { width, height, data } = png;

	// Estimate the background from the four corners (the viewport gradient).
	const corner = ( x, y ) => {

		const i = ( y * width + x ) * 4;
		return [ data[ i ], data[ i + 1 ], data[ i + 2 ] ];

	};

	const corners = [
		corner( 2, 2 ),
		corner( width - 3, 2 ),
		corner( 2, height - 3 ),
		corner( width - 3, height - 3 )
	];
	const bg = [ 0, 1, 2 ].map( ( c ) => Math.round( corners.reduce( ( a, p ) => a + p[ c ], 0 ) / 4 ) );

	let ink = 0;
	let warm = 0;
	let cool = 0;
	let lumaSum = 0;
	let minL = 255;
	let maxL = 0;
	const palette = new Set();
	const total = width * height;

	for ( let i = 0; i < data.length; i += 4 ) {

		const r = data[ i ];
		const g = data[ i + 1 ];
		const b = data[ i + 2 ];
		const dist = Math.abs( r - bg[ 0 ] ) + Math.abs( g - bg[ 1 ] ) + Math.abs( b - bg[ 2 ] );
		if ( dist > 20 ) ink += 1;
		if ( r > g && g > b && r - b > 24 ) warm += 1;
		if ( b > r && b - r > 24 ) cool += 1;
		const l = 0.2126 * r + 0.7152 * g + 0.0722 * b;
		lumaSum += l;
		if ( l < minL ) minL = l;
		if ( l > maxL ) maxL = l;
		palette.add( ( ( r >> 3 ) << 10 ) | ( ( g >> 3 ) << 5 ) | ( b >> 3 ) );

	}

	return {
		file: path.basename( file ),
		size: `${width}x${height}`,
		background: bg,
		inkRatio: + ( ink / total ).toFixed( 4 ),
		warmRatio: + ( warm / total ).toFixed( 4 ),
		coolRatio: + ( cool / total ).toFixed( 4 ),
		meanLuma: + ( lumaSum / total ).toFixed( 1 ),
		dynamicRange: + ( maxL - minL ).toFixed( 1 ),
		paletteSize: palette.size
	};

}

const handle = await ensureServer( URL );
const browser = await chromium.launch( {
	executablePath: EDGE,
	args: [
		'--force-device-scale-factor=1',
		'--hide-scrollbars',
		'--enable-unsafe-swiftshader',
		'--use-gl=angle',
		'--use-angle=swiftshader'
	]
} );
const context = await browser.newContext( {
	viewport: { width: 1600, height: 1000 },
	acceptDownloads: true
} );
const page = await context.newPage();

page.on( 'console', ( m ) => {

	if ( m.type() === 'error' ) results.errors.push( m.text() );

} );
page.on( 'pageerror', ( e ) => results.errors.push( String( e ) ) );
page.on( 'response', ( r ) => {

	if ( r.status() >= 400 ) results.failed.push( `${r.status()} ${r.url()}` );

} );

const settle = async ( ms = 260 ) => {

	await page.evaluate( () => window.__csgForge.whenIdle() );
	await page.waitForTimeout( ms );

};

const shoot = async ( name, clip ) => {

	const file = path.join( OUT, name );
	if ( clip ) await page.locator( clip ).screenshot( { path: file } );
	else await page.screenshot( { path: file } );
	const stats = analyse( file );
	results.shots.push( stats );
	return stats;

};

/* ------------------------------- 1. load -------------------------------- */

await page.goto( URL, { waitUntil: 'networkidle', timeout: 45000 } );
await page.waitForFunction( () => !! window.__csgForge, null, { timeout: 20000 } );
await page.evaluate( async () => {

	await window.__csgForge.whenReady();
	await window.__csgForge.whenIdle();

} );
await settle( 900 );

assert( results.errors.length === 0, `console errors: ${results.errors.join( ' | ' )}` );
assert( results.failed.length === 0, `failed requests: ${results.failed.join( ' | ' )}` );

/* --------------------------- 2. DOM geometry ---------------------------- */

const dom = await page.evaluate( () => {

	const rect = ( el ) => {

		if ( ! el ) return null;
		const r = el.getBoundingClientRect();
		return { x: + r.x.toFixed( 1 ), y: + r.y.toFixed( 1 ), w: + r.width.toFixed( 1 ), h: + r.height.toFixed( 1 ) };

	};

	const vw = window.innerWidth;
	const vh = window.innerHeight;
	const regions = {
		topbar: rect( document.querySelector( '.topbar' ) ),
		chain: rect( document.getElementById( 'chain-panel' ) ),
		viewport: rect( document.querySelector( '.viewport-wrap' ) ),
		inspector: rect( document.getElementById( 'inspector' ) )
	};
	const outside = Object.entries( regions )
		.filter( ( [ , r ] ) => ! r || r.x < - 1 || r.y < - 1 || r.x + r.w > vw + 1 || r.y + r.h > vh + 1 )
		.map( ( [ k ] ) => k );

	const canvas = document.querySelector( '#viewport canvas' );
	return {
		viewport: { w: vw, h: vh },
		regions,
		outside,
		overflowX: document.documentElement.scrollWidth > vw + 1,
		canvas: canvas ? { css: rect( canvas ), buffer: [ canvas.width, canvas.height ] } : null,
		nodeRows: document.querySelectorAll( '#chain .node' ).length,
		addButtons: Array.from( document.querySelectorAll( '#add-grid button' ) ).map( ( b ) => b.dataset.kind || b.textContent.trim() ),
		presets: Array.from( document.querySelectorAll( '#presets .preset-btn' ) ).map( ( b ) => b.textContent.trim() ),
		hud: {
			tris: document.getElementById( 'hud-tris' ).textContent,
			eval: document.getElementById( 'hud-eval' ).textContent,
			mode: document.getElementById( 'hud-mode' ).textContent
		},
		stats: window.__csgForge.getStats()
	};

} );

results.dom = dom;
assert( dom.outside.length === 0, `regions outside viewport: ${dom.outside}` );
assert( dom.overflowX === false, 'horizontal overflow detected' );
assert( dom.canvas !== null, 'no canvas in viewport' );
assert( dom.canvas.css.w > 600 && dom.canvas.css.h > 500, 'canvas too small' );
assert( dom.nodeRows === 4, `expected 4 chain rows, got ${dom.nodeRows}` );
assert( dom.addButtons.length >= 5, `expected >=5 primitive buttons, got ${dom.addButtons.length}` );
assert( dom.presets.length >= 3, `expected >=3 presets, got ${dom.presets.length}` );
assert( dom.stats.triangles > 100, `result has only ${dom.stats.triangles} triangles` );

/* --------------------------- 3. WebGL output ---------------------------- */

await shoot( '01-initial.png' );
const viewportShot = await shoot( '02-viewport.png', '#viewport' );
assert( viewportShot.inkRatio > 0.05, `canvas looks blank (ink ${viewportShot.inkRatio})` );
assert( viewportShot.dynamicRange > 40, `canvas has no shading (range ${viewportShot.dynamicRange})` );
assert( viewportShot.paletteSize > 40, `canvas palette too flat (${viewportShot.paletteSize})` );

/* -------------------------- 4. interaction chain ------------------------ */

// 4a. presets
const presetNodes = [];
for ( let i = 0; i < dom.presets.length; i += 1 ) {

	await page.locator( '#presets .preset-btn' ).nth( i ).click();
	await settle();
	const info = await page.evaluate( () => ( {
		nodes: window.__csgForge.doc.nodes.length,
		kinds: window.__csgForge.doc.nodes.map( ( n ) => n.kind ),
		tris: window.__csgForge.getStats().triangles
	} ) );
	presetNodes.push( { index: i, name: dom.presets[ i ], ...info } );
	await shoot( `03-preset-${i}.png`, '#viewport' );

}

results.interactions.presets = presetNodes;
assert( presetNodes.every( ( p ) => p.nodes >= 2 ), 'a preset produced fewer than 2 nodes' );
assert( new Set( presetNodes.map( ( p ) => p.tris ) ).size > 1, 'all presets produced identical triangle counts' );

// back to the default bracket for the remaining tests
await page.locator( '#presets .preset-btn' ).nth( 0 ).click();
await settle();

// 4b. add a primitive
const beforeAdd = await page.evaluate( () => window.__csgForge.doc.nodes.length );
await page.locator( '#add-grid button' ).nth( 1 ).click();
await settle();
const afterAdd = await page.evaluate( () => window.__csgForge.doc.nodes.length );
results.interactions.addPrimitive = { before: beforeAdd, after: afterAdd };
assert( afterAdd === beforeAdd + 1, `add primitive failed (${beforeAdd} -> ${afterAdd})` );

// 4c. selection drives the inspector
await page.locator( '#chain .node' ).nth( 1 ).click();
await page.waitForTimeout( 180 );
const inspector = await page.evaluate( () => ( {
	kind: document.getElementById( 'inspector-kind' ).textContent,
	fields: document.querySelectorAll( '#inspector-body input[type="range"]' ).length,
	selected: window.__csgForge.getSelected()
} ) );
results.interactions.inspector = inspector;
assert( inspector.kind !== '—', 'inspector did not populate on selection' );
assert( inspector.fields >= 2, `inspector has only ${inspector.fields} sliders` );

// 4d. editing a parameter re-evaluates and changes the mesh
const paramEdit = await page.evaluate( async () => {

	const api = window.__csgForge;
	const before = { ...api.getStats() };
	const slider = document.querySelector( '#inspector-body input[type="range"]' );
	const original = slider.value;
	slider.value = String( Number( original ) + ( Number( slider.max ) - Number( slider.min ) ) * 0.25 );
	slider.dispatchEvent( new Event( 'input', { bubbles: true } ) );
	await api.whenIdle();
	await new Promise( ( r ) => setTimeout( r, 260 ) );
	const after = { ...api.getStats() };
	return { original, changed: slider.value, before, after };

} );
results.interactions.paramEdit = paramEdit;
assert( paramEdit.after.evaluations > paramEdit.before.evaluations, 'parameter edit did not trigger a re-evaluation' );
assert( paramEdit.after.triangles !== paramEdit.before.triangles, 'parameter edit did not change the mesh' );

// 4e. display modes
const modeShots = {};
for ( const mode of [ 'wireframe', 'xray', 'solid' ] ) {

	await page.locator( `[data-mode="${mode}"]` ).click();
	await page.waitForTimeout( 320 );
	const s = await shoot( `04-mode-${mode}.png`, '#viewport' );
	modeShots[ mode ] = { ink: s.inkRatio, palette: s.paletteSize, range: s.dynamicRange };

}

results.interactions.modes = modeShots;
assert( modeShots.wireframe.ink < modeShots.solid.ink, 'wireframe should ink less than solid' );

// 4f. section plane
const solidBefore = modeShots.solid.ink;
await page.locator( '#section-enabled' ).check();
await page.evaluate( () => {

	const s = document.getElementById( 'section-offset' );
	s.value = '0.6';
	s.dispatchEvent( new Event( 'input', { bubbles: true } ) );

} );
await page.waitForTimeout( 420 );
const sectionShot = await shoot( '05-section.png', '#viewport' );
results.interactions.section = { before: solidBefore, after: sectionShot.inkRatio };
assert( Math.abs( sectionShot.inkRatio - solidBefore ) > 0.004, 'section plane did not change the render' );
await page.locator( '#section-enabled' ).uncheck();
await page.waitForTimeout( 260 );

// 4g. undo / redo — add a primitive first so the history entry is unambiguous
const undoProbe = await page.evaluate( async () => {

	const api = window.__csgForge;
	const settle = () => new Promise( ( r ) => setTimeout( r, 200 ) );
	const before = api.doc.nodes.length;

	document.querySelectorAll( '#add-grid button' )[ 0 ].click();
	await api.whenIdle();
	await settle();
	const added = api.doc.nodes.length;

	document.getElementById( 'undo' ).click();
	await api.whenIdle();
	await settle();
	const undone = api.doc.nodes.length;

	document.getElementById( 'redo' ).click();
	await api.whenIdle();
	await settle();
	const redone = api.doc.nodes.length;

	return { before, added, undone, redone };

} );
results.interactions.undo = undoProbe;
assert( undoProbe.added === undoProbe.before + 1, 'add-primitive did not grow the document' );
assert( undoProbe.undone === undoProbe.before, `undo did not remove the node (${undoProbe.undone} vs ${undoProbe.before})` );
assert( undoProbe.redone === undoProbe.added, `redo did not restore the node (${undoProbe.redone} vs ${undoProbe.added})` );

// 4h. exports
const exportResults = {};
for ( const kind of [ 'glb', 'stl', 'obj', 'json' ] ) {

	await page.locator( '#export-btn' ).click();
	await page.waitForTimeout( 120 );
	const [ download ] = await Promise.all( [
		page.waitForEvent( 'download', { timeout: 20000 } ),
		page.locator( `[data-export="${kind}"]` ).click()
	] );
	const file = await download.path();
	const size = file ? fs.statSync( file ).size : 0;
	exportResults[ kind ] = { name: download.suggestedFilename(), bytes: size };
	await page.waitForTimeout( 120 );

}

results.interactions.exports = exportResults;
assert( exportResults.glb.bytes > 2000, `glb export too small: ${exportResults.glb.bytes}` );
assert( exportResults.stl.bytes > 500, `stl export too small: ${exportResults.stl.bytes}` );
assert( exportResults.obj.bytes > 2000, `obj export too small: ${exportResults.obj.bytes}` );
assert( exportResults.json.bytes > 500, `json export too small: ${exportResults.json.bytes}` );
assert( /\.glb$/.test( exportResults.glb.name ), 'glb filename wrong' );

/* ---------------------------- 5. responsive ----------------------------- */

for ( const [ label, size ] of [
	[ '06-tablet', { width: 1100, height: 820 } ],
	[ '07-narrow', { width: 860, height: 900 } ],
	[ '08-phone', { width: 430, height: 880 } ]
] ) {

	await page.setViewportSize( size );
	await page.waitForTimeout( 520 );
	const overflow = await page.evaluate(
		() => document.documentElement.scrollWidth > window.innerWidth + 1
	);
	const canvasBox = await page.locator( '#viewport canvas' ).boundingBox();
	const shot = await shoot( `${label}.png` );
	results.interactions[ label ] = {
		overflow,
		canvas: canvasBox ? { w: + canvasBox.width.toFixed( 1 ), h: + canvasBox.height.toFixed( 1 ) } : null,
		ink: shot.inkRatio
	};
	assert( overflow === false, `horizontal overflow at ${size.width}px` );
	assert( canvasBox && canvasBox.width > 200, `canvas collapsed at ${size.width}px` );
	assert( shot.inkRatio > 0.03, `layout looks empty at ${size.width}px (ink ${shot.inkRatio})` );

}

// mobile sheet switching (only present under the narrow breakpoint)
await page.setViewportSize( { width: 430, height: 880 } );
await page.waitForTimeout( 420 );
const sheets = {};
for ( const sheet of [ 'chain', 'inspector', 'none' ] ) {

	await page.locator( `#mobile-tabs button[data-sheet="${sheet}"]` ).click();
	await page.waitForTimeout( 240 );
	sheets[ sheet ] = await page.evaluate( () => ( {
		chain: document.getElementById( 'chain-panel' ).classList.contains( 'sheet-open' ),
		inspector: document.getElementById( 'inspector' ).classList.contains( 'sheet-open' ),
		pressed: Array.from( document.querySelectorAll( '#mobile-tabs button' ) ).map( ( b ) =>
			b.getAttribute( 'aria-pressed' )
		)
	} ) );

}

results.interactions.mobileSheets = sheets;
assert( sheets.chain.chain === true && sheets.chain.inspector === false, 'chain sheet did not open alone' );
assert( sheets.inspector.inspector === true && sheets.inspector.chain === false, 'inspector sheet did not open alone' );
assert( sheets.none.chain === false && sheets.none.inspector === false, 'viewport tab did not close both sheets' );
await shoot( '09-phone-sheet.png' );

await page.setViewportSize( { width: 1600, height: 1000 } );

/* ------------------------------- report -------------------------------- */

await browser.close();
await closeServer( handle );

results.summary = {
	shots: results.shots.length,
	inkRange: [
		Math.min( ...results.shots.map( ( s ) => s.inkRatio ) ),
		Math.max( ...results.shots.map( ( s ) => s.inkRatio ) )
	],
	paletteRange: [
		Math.min( ...results.shots.map( ( s ) => s.paletteSize ) ),
		Math.max( ...results.shots.map( ( s ) => s.paletteSize ) )
	],
	errors: results.errors,
	failed: results.failed
};

fs.writeFileSync( path.join( OUT, 'verify-report.json' ), JSON.stringify( results, null, 2 ) );

console.log(
	JSON.stringify(
		{
			summary: results.summary,
			dom: {
				canvas: dom.canvas,
				nodeRows: dom.nodeRows,
				addButtons: dom.addButtons.length,
				presets: dom.presets,
				stats: dom.stats,
				outside: dom.outside
			},
			interactions: results.interactions
		},
		null,
		2
	)
);
console.log( '\nVERIFY OK' );
