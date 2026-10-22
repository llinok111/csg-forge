/**
 * CSG Forge — benchmark runner.
 *
 * Drives the workbench's own benchmark harness (`window.__runBench`) and writes
 * the raw result to disk. The harness compares main-thread evaluation against
 * the worker pool with identical inputs, so the numbers are directly comparable.
 *
 * Run: node scripts/run-bench.mjs [--url=...] [--out=...] [--rounds=12]
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
const OUT = path.resolve( args.out || 'docs/shots/bench.json' );
const ROUNDS = Number( args.rounds || 12 );

fs.mkdirSync( path.dirname( OUT ), { recursive: true } );

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
page.on( 'pageerror', ( e ) => errors.push( String( e ) ) );

await page.goto( URL, { waitUntil: 'networkidle', timeout: 45000 } );
await page.waitForFunction( () => !! window.__csgForge, null, { timeout: 20000 } );
await page.evaluate( () => window.__csgForge.whenReady() );

const started = Date.now();
const result = await page.evaluate( async ( rounds ) => {

	return window.__runBench( { rounds } );

}, ROUNDS );
const elapsed = Date.now() - started;

const payload = {
	url: URL,
	rounds: ROUNDS,
	elapsedMs: elapsed,
	errors,
	result
};

fs.writeFileSync( OUT, JSON.stringify( payload, null, 2 ) );
console.log( JSON.stringify( payload, null, 2 ) );

await browser.close();
await closeServer( handle );
