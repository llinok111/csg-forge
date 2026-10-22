/**
 * Three.js viewport for the workbench: scene, lighting, orbit controls,
 * section plane, display modes and a real (measured, not estimated) FPS meter.
 */
import {
	Scene,
	PerspectiveCamera,
	WebGLRenderer,
	DirectionalLight,
	AmbientLight,
	HemisphereLight,
	GridHelper,
	Plane,
	Vector3,
	Color,
	PCFSoftShadowMap,
	Fog,
	MathUtils,
} from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

export class Viewport {

	constructor( container ) {

		this.container = container;

		const scene = new Scene();
		scene.background = new Color( 0x0b0d10 );
		scene.fog = new Fog( 0x0b0d10, 14, 30 );

		const camera = new PerspectiveCamera( 42, 1, 0.1, 200 );
		camera.position.set( 4.2, 3.4, 5.4 );

		const renderer = new WebGLRenderer( { antialias: true, alpha: false, powerPreference: 'high-performance' } );
		renderer.setPixelRatio( Math.min( window.devicePixelRatio, 2 ) );
		renderer.shadowMap.enabled = true;
		renderer.shadowMap.type = PCFSoftShadowMap;
		renderer.localClippingEnabled = true;
		container.appendChild( renderer.domElement );

		const hemi = new HemisphereLight( 0xdfe7ff, 0x2a2118, 1.15 );
		scene.add( hemi );

		const ambient = new AmbientLight( 0xffffff, 0.25 );
		scene.add( ambient );

		const key = new DirectionalLight( 0xfff0dd, 2.4 );
		key.position.set( 6, 9, 5 );
		key.castShadow = true;
		key.shadow.mapSize.set( 1024, 1024 );
		key.shadow.camera.near = 1;
		key.shadow.camera.far = 30;
		key.shadow.camera.left = - 8;
		key.shadow.camera.right = 8;
		key.shadow.camera.top = 8;
		key.shadow.camera.bottom = - 8;
		key.shadow.bias = - 0.0012;
		scene.add( key );

		const rim = new DirectionalLight( 0x6ea8ff, 0.85 );
		rim.position.set( - 7, 4, - 6 );
		scene.add( rim );

		const grid = new GridHelper( 20, 40, 0x2b323c, 0x181d24 );
		grid.position.y = - 1.9;
		scene.add( grid );

		const controls = new OrbitControls( camera, renderer.domElement );
		controls.enableDamping = true;
		controls.dampingFactor = 0.075;
		controls.minDistance = 1.6;
		controls.maxDistance = 26;
		controls.maxPolarAngle = Math.PI * 0.92;
		controls.target.set( 0, 0, 0 );

		this.scene = scene;
		this.camera = camera;
		this.renderer = renderer;
		this.controls = controls;
		this.grid = grid;
		this.current = null;

		this.mode = 'solid';
		this.section = { enabled: false, axis: 'x', offset: 0 };
		this._plane = new Plane( new Vector3( - 1, 0, 0 ), 0 );

		this._frames = 0;
		this._lastFpsAt = performance.now();
		this.fps = 0;
		this._onFps = null;

		this._resizeObserver = new ResizeObserver( () => this.resize() );
		this._resizeObserver.observe( container );
		this.resize();

		const loop = () => {

			this._raf = requestAnimationFrame( loop );
			this.controls.update();
			this.renderer.render( scene, camera );
			this._tickFps();

		};

		loop();

	}

	_tickFps() {

		this._frames ++;
		const now = performance.now();
		const elapsed = now - this._lastFpsAt;
		if ( elapsed >= 500 ) {

			this.fps = ( this._frames * 1000 ) / elapsed;
			this._frames = 0;
			this._lastFpsAt = now;
			this._onFps?.( this.fps );

		}

	}

	onFps( fn ) {

		this._onFps = fn;

	}

	resize() {

		const width = this.container.clientWidth || 1;
		const height = this.container.clientHeight || 1;
		this.renderer.setSize( width, height, false );
		this.camera.aspect = width / height;
		this.camera.updateProjectionMatrix();

	}

	setMode( mode ) {

		this.mode = mode;
		this._applyMode();

	}

	setSection( patch ) {

		Object.assign( this.section, patch );
		const normal = { x: new Vector3( - 1, 0, 0 ), y: new Vector3( 0, - 1, 0 ), z: new Vector3( 0, 0, - 1 ) }[ this.section.axis ];
		this._plane.normal.copy( normal );
		this._plane.constant = this.section.offset;
		this.renderer.clippingPlanes = this.section.enabled ? [ this._plane ] : [];
		this._applyMode();

	}

	_applyMode() {

		if ( ! this.current ) return;
		const materials = Array.isArray( this.current.material ) ? this.current.material : [ this.current.material ];
		materials.forEach( material => {

			if ( ! material ) return;
			if ( ! material.userData.__base ) {

				material.userData.__base = {
					transparent: material.transparent,
					opacity: material.opacity,
					depthWrite: material.depthWrite,
				};

			}

			const base = material.userData.__base;
			material.wireframe = this.mode === 'wireframe';
			material.transparent = this.mode === 'xray' ? true : base.transparent;
			material.opacity = this.mode === 'xray' ? 0.28 : base.opacity;
			material.depthWrite = this.mode === 'xray' ? false : base.depthWrite;
			material.clippingPlanes = this.section.enabled ? [ this._plane ] : null;
			material.needsUpdate = true;

		} );

	}

	setResult( brush, { frame = false } = {} ) {

		if ( this.current ) {

			this.scene.remove( this.current );
			this._disposeMaterials( this.current );
			this.current.geometry?.dispose?.();

		}

		this.current = brush;
		brush.castShadow = true;
		brush.receiveShadow = true;
		this.scene.add( brush );
		this._applyMode();
		if ( frame ) this._frame( brush );

	}

	_disposeMaterials( mesh ) {

		const materials = Array.isArray( mesh.material ) ? mesh.material : [ mesh.material ];
		materials.forEach( material => material?.dispose?.() );

	}

	_frame( mesh ) {

		const box = mesh.geometry.boundingBox || ( mesh.geometry.computeBoundingBox(), mesh.geometry.boundingBox );
		if ( ! box ) return;
		const size = new Vector3();
		box.getSize( size );
		const radius = Math.max( size.x, size.y, size.z, 0.6 );
		const distance = radius * 2.9;
		const direction = new Vector3( 0.72, 0.55, 0.86 ).normalize();
		this.camera.position.copy( direction.multiplyScalar( distance ) );
		this.camera.near = Math.max( 0.01, radius * 0.02 );
		this.camera.far = radius * 40;
		this.camera.updateProjectionMatrix();
		this.controls.target.copy( box.getCenter( new Vector3() ) );
		this.controls.minDistance = radius * 0.8;
		this.controls.maxDistance = radius * 8;
		this.controls.update();
		this.grid.position.y = box.min.y - 0.15;

	}

	resetView() {

		if ( this.current ) this._frame( this.current );

	}

	setAutoRotate( enabled ) {

		this.controls.autoRotate = enabled;
		this.controls.autoRotateSpeed = 0.85;

	}

	dispose() {

		cancelAnimationFrame( this._raf );
		this._resizeObserver.disconnect();
		this.controls.dispose();
		if ( this.current ) this._disposeMaterials( this.current );
		this.renderer.dispose();

	}

}

export { MathUtils };
