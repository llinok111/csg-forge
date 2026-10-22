/**
 * Shared dev-server helper for the verification scripts.
 *
 * If the target URL already answers, reuse it (so you can keep `npm run start`
 * open in another terminal). Otherwise spin up a Vite server programmatically
 * and shut it down when the script finishes.
 */
import { createServer } from 'vite';
import { fileURLToPath } from 'node:url';

const PORT = 5199;
export const DEFAULT_URL = `http://localhost:${PORT}/workbench.html`;
const CONFIG = fileURLToPath( new URL( '../vite.config.js', import.meta.url ) );

async function reachable( url ) {

	try {

		const res = await fetch( url, { method: 'GET' } );
		return res.ok || res.status === 304;

	} catch {

		return false;

	}

}

export async function ensureServer( url = DEFAULT_URL ) {

	if ( await reachable( url ) ) {

		return { url, server: null, owned: false };

	}

	const server = await createServer( {
		configFile: CONFIG,
		server: { port: PORT, strictPort: true }
	} );
	await server.listen();
	// Vite prints its own banner; keep the harness output readable.
	server.printUrls = () => {};

	for ( let i = 0; i < 40; i += 1 ) {

		if ( await reachable( url ) ) return { url, server, owned: true };
		await new Promise( ( r ) => setTimeout( r, 150 ) );

	}

	await server.close();
	throw new Error( `dev server did not become reachable at ${url}` );

}

export async function closeServer( handle ) {

	if ( handle && handle.owned && handle.server ) {

		await handle.server.close();

	}

}
