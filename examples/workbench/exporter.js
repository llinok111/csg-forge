/**
 * Export helpers: binary glTF, ASCII STL, Wavefront OBJ and the editable
 * document JSON. Everything is produced in-browser and handed to the user as a
 * download — no server round-trip.
 */
import { GLTFExporter } from 'three/addons/exporters/GLTFExporter.js';
import { STLExporter } from 'three/addons/exporters/STLExporter.js';
import { OBJExporter } from 'three/addons/exporters/OBJExporter.js';

function download( blob, filename ) {

	const url = URL.createObjectURL( blob );
	const anchor = document.createElement( 'a' );
	anchor.href = url;
	anchor.download = filename;
	document.body.appendChild( anchor );
	anchor.click();
	anchor.remove();
	// Give the browser a tick to start the download before revoking.
	setTimeout( () => URL.revokeObjectURL( url ), 4000 );

}

function timestamp() {

	const now = new Date();
	const pad = n => String( n ).padStart( 2, '0' );
	return `${ now.getFullYear() }${ pad( now.getMonth() + 1 ) }${ pad( now.getDate() ) }-${ pad( now.getHours() ) }${ pad( now.getMinutes() ) }`;

}

export async function exportGLB( mesh, name = 'csg-model' ) {

	const exporter = new GLTFExporter();
	const result = await exporter.parseAsync( mesh, { binary: true, onlyVisible: false } );
	download( new Blob( [ result ], { type: 'model/gltf-binary' } ), `${ name }-${ timestamp() }.glb` );
	return result.byteLength;

}

export function exportSTL( mesh, name = 'csg-model' ) {

	const exporter = new STLExporter();
	const data = exporter.parse( mesh, { binary: true } );
	download( new Blob( [ data ], { type: 'model/stl' } ), `${ name }-${ timestamp() }.stl` );
	return data.byteLength;

}

export function exportOBJ( mesh, name = 'csg-model' ) {

	const exporter = new OBJExporter();
	const text = exporter.parse( mesh );
	download( new Blob( [ text ], { type: 'text/plain' } ), `${ name }-${ timestamp() }.obj` );
	return text.length;

}

export function exportDocument( doc, name = 'csg-doc' ) {

	const payload = JSON.stringify( {
		format: 'csg-forge/document',
		version: 1,
		createdAt: new Date().toISOString(),
		nodes: doc.nodes,
	}, null, 2 );

	download( new Blob( [ payload ], { type: 'application/json' } ), `${ name }-${ timestamp() }.json` );
	return payload.length;

}

export function formatBytes( bytes ) {

	if ( bytes < 1024 ) return `${ bytes } B`;
	if ( bytes < 1024 * 1024 ) return `${ ( bytes / 1024 ).toFixed( 1 ) } KB`;
	return `${ ( bytes / ( 1024 * 1024 ) ).toFixed( 2 ) } MB`;

}
