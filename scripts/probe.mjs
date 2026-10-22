/**
 * CSG Forge — smoke probe.
 *
 * Loads the workbench, waits for the first evaluation to settle, then reports
 * console errors, DOM geometry, HUD values and whether the worker pool is
 * actually being used. Used to catch regressions before the full verification
 * harness runs.
 *
 * Run: node scripts/probe.mjs [--url=...] [--out=...]
 */
import { chromium } from 'playwright-core';
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
const page = await browser.newPage( { viewport: { width: 1600, height: 1000 } } );

const errors = [];
page.on( 'console', ( m ) => {

	if ( m.type() === 'error' ) errors.push( m.text() );

} );
page.on( 'pageerror', ( e ) => errors.push( String( e ) ) );
const notFound = [];
page.on( 'response', ( r ) => {

	if ( r.status() >= 400 ) notFound.push( `${r.status()} ${r.url()}` );

} );

await page.goto( URL, { waitUntil: 'networkidle', timeout: 45000 } );
await page.waitForFunction( () => !! window.__csgForge, null, { timeout: 20000 } );

// Wait for the first evaluation to finish (or time out loudly).
const ready = await page
	.evaluate( async () => {

		const api = window.__csgForge;
		await api.whenReady();
		await api.whenIdle();
		return true;

	} )
	.catch( ( e ) => String( e ) );

await page.waitForTimeout( 1200 );

const probe = await page.evaluate( () => {

	const api = window.__csgForge;
	const rect = ( el ) => {

		if ( ! el ) return null;
		const r = el.getBoundingClientRect();
		return { x: + r.x.toFixed( 1 ), y: + r.y.toFixed( 1 ), w: + r.width.toFixed( 1 ), h: + r.height.toFixed( 1 ) };

	};

	const canvas = document.querySelector( '#viewport canvas' );
	return {
		title: document.title,
		nodeCount: api.doc.nodes.length,
		nodeKinds: api.doc.nodes.map( ( n ) => n.kind ),
		evaluatorMode: api.evaluator.mode,
		evaluatorWorkers: api.evaluator.workers,
		stats: api.getStats(),
		hud: {
			tris: document.getElementById( 'hud-tris' ).textContent,
			eval: document.getElementById( 'hud-eval' ).textContent,
			reused: document.getElementById( 'hud-reused' ).textContent,
			fps: document.getElementById( 'hud-fps' ).textContent,
			mode: document.getElementById( 'hud-mode' ).textContent
		},
		chainRows: document.querySelectorAll( '#chain .node' ).length,
		addButtons: document.querySelectorAll( '#add-grid button' ).length,
		presets: document.querySelectorAll( '#presets button' ).length,
		inspectorRows: document.querySelectorAll( '#inspector-body .field, #inspector-body .row' ).length,
		canvas: canvas ? { ...rect( canvas ), w: canvas.width, h: canvas.height } : null,
		regions: {
			topbar: rect( document.querySelector( '.topbar' ) ),
			chain: rect( document.getElementById( 'chain-panel' ) ),
			viewport: rect( document.querySelector( '.viewport-wrap' ) ),
			inspector: rect( document.getElementById( 'inspector' ) )
		},
		webgl: ( () => {

			const c = document.createElement( 'canvas' );
			const gl = c.getContext( 'webgl2' ) || c.getContext( 'webgl' );
			return gl ? gl.getParameter( gl.VERSION ) : null;

		} )()
	};

} );

await page.screenshot( { path: path.join( OUT, 'probe-01-initial.png' ) } );

console.log( JSON.stringify( { ready, errors, notFound, probe }, null, 2 ) );

await browser.close();
await closeServer( handle );
