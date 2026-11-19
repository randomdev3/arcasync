/**
 * "The loom": a ruled page in perspective with four coloured threads weaving over and under it,
 * each ending in a named caret. Loaded lazily by the landing page (its own chunk, with three);
 * purely decorative (`aria-hidden` canvas). 11 draw calls, about 8k vertices.
 */
import {
	BufferAttribute,
	BufferGeometry,
	CanvasTexture,
	Color,
	DynamicDrawUsage,
	Fog,
	Group,
	LineSegments,
	Mesh,
	MeshBasicMaterial,
	PerspectiveCamera,
	PlaneGeometry,
	Scene,
	ShaderMaterial,
	Sprite,
	SpriteMaterial,
	SRGBColorSpace,
	WebGLRenderer,
} from "three";
import {
	advance,
	createSim,
	edgeFade,
	type Head,
	PAGE,
	type Sim,
	step,
	stillFrame,
	swell,
	TRAIL,
	trailPoint,
	weave,
} from "./paths";

const THREADS = ["--t1", "--t2", "--t3", "--t4"];
const RIBBON_WIDTH = 0.034;
const DISTANCE = 7.2;
const FOG_NEAR = 6;
const FOG_FAR = 10.5;

export interface LoomOptions {
	reducedMotion: boolean;
	/** Called once if WebGL fails later (context lost); the page shows the SVG again. */
	onFail: () => void;
}

export interface Loom {
	setReducedMotion(reduced: boolean): void;
	recolor(): void;
	dispose(): void;
}

function cssColor(name: string): Color {
	const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
	return new Color(value || "#888888");
}

/** Page and rules share this vertex shader: two summed sines, and a hand-rolled linear fog. */
const VERTEX = /* glsl */ `
uniform float uTime;
uniform float uLift;
varying float vFogDepth;
void main() {
	vec3 p = position;
	p.z += 0.05 * sin(p.x * 1.1 + uTime * 0.45) + 0.035 * sin(p.y * 1.7 - uTime * 0.35 + p.x * 0.4) + uLift;
	vec4 mv = modelViewMatrix * vec4(p, 1.0);
	vFogDepth = -mv.z;
	gl_Position = projectionMatrix * mv;
}`;

const FRAGMENT = /* glsl */ `
uniform vec3 uColor;
uniform vec3 uFogColor;
uniform float uFogNear;
uniform float uFogFar;
varying float vFogDepth;
void main() {
	float fog = smoothstep(uFogNear, uFogFar, vFogDepth);
	gl_FragColor = vec4(mix(uColor, uFogColor, fog), 1.0);
	#include <colorspace_fragment>
}`;

function surfaceMaterial(lift: number) {
	const u = {
		uTime: { value: 0 },
		uLift: { value: lift },
		uColor: { value: new Color() },
		uFogColor: { value: new Color() },
		uFogNear: { value: FOG_NEAR },
		uFogFar: { value: FOG_FAR },
	};
	const material = new ShaderMaterial({
		uniforms: u,
		vertexShader: VERTEX,
		fragmentShader: FRAGMENT,
	});
	return { material, u };
}

/** ~28 horizontal rules plus a margin line, as one LineSegments of short pieces. */
function rulesGeometry(): BufferGeometry {
	const lines = 28;
	const pieces = 96;
	const positions: number[] = [];
	const left = -PAGE.width / 2 + 0.06;
	const right = PAGE.width / 2 - 0.06;
	for (let l = 1; l <= lines; l++) {
		const y = -PAGE.height / 2 + (PAGE.height * l) / (lines + 1);
		for (let p = 0; p < pieces; p++) {
			const x0 = left + ((right - left) * p) / pieces;
			const x1 = left + ((right - left) * (p + 1)) / pieces;
			positions.push(x0, y, 0, x1, y, 0);
		}
	}
	const geometry = new BufferGeometry();
	geometry.setAttribute("position", new BufferAttribute(new Float32Array(positions), 3));
	return geometry;
}

/** A ribbon of TRAIL samples (two vertices each), rewritten in place every frame. */
function ribbonGeometry(color: Color): BufferGeometry {
	const geometry = new BufferGeometry();
	const position = new BufferAttribute(new Float32Array(TRAIL * 2 * 3), 3);
	position.setUsage(DynamicDrawUsage);
	const colors = new Float32Array(TRAIL * 2 * 4);
	for (let j = 0; j < TRAIL; j++) {
		// The trail fades out over its oldest 40%.
		const a = Math.min(1, j / (TRAIL * 0.4));
		const alpha = a * a * (3 - 2 * a);
		for (const side of [0, 1]) {
			colors.set([color.r, color.g, color.b, alpha], (j * 2 + side) * 4);
		}
	}
	const index: number[] = [];
	for (let j = 0; j < TRAIL - 1; j++) {
		const a = j * 2;
		index.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
	}
	geometry.setAttribute("position", position);
	geometry.setAttribute("color", new BufferAttribute(colors, 4));
	geometry.setIndex(index);
	return geometry;
}

function flagTexture(name: string, color: string, font: string): CanvasTexture {
	const canvas = document.createElement("canvas");
	canvas.width = 192;
	canvas.height = 64;
	const ctx = canvas.getContext("2d");
	if (ctx) {
		ctx.font = `600 30px ${font}`;
		const width = Math.min(188, ctx.measureText(name).width + 28);
		ctx.fillStyle = color;
		ctx.beginPath();
		ctx.roundRect(0, 4, width, 48, 9);
		ctx.fill();
		ctx.fillStyle = "#1b1a17";
		ctx.textBaseline = "middle";
		ctx.fillText(name, 14, 29);
	}
	const texture = new CanvasTexture(canvas);
	texture.colorSpace = SRGBColorSpace;
	return texture;
}

export async function createLoom(canvas: HTMLCanvasElement, options: LoomOptions): Promise<Loom> {
	const renderer = new WebGLRenderer({
		canvas,
		antialias: true,
		powerPreference: "low-power",
		alpha: false,
	});
	const scene = new Scene();
	scene.fog = new Fog(0xffffff, FOG_NEAR, FOG_FAR);
	const camera = new PerspectiveCamera(35, 1, 0.1, 30);
	camera.position.set(0, 0, DISTANCE);

	const page = new Group();
	page.rotation.set(-0.62, -0.42, 0.16);
	page.position.set(0.45, 0.05, 0);
	scene.add(page);

	const surface = surfaceMaterial(0);
	const sheet = new Mesh(new PlaneGeometry(PAGE.width, PAGE.height, 48, 32), surface.material);
	page.add(sheet);
	const ruleMaterial = surfaceMaterial(0.001);
	const rules = new LineSegments(rulesGeometry(), ruleMaterial.material);
	page.add(rules);

	const threadColors = THREADS.map(cssColor);
	const ribbons = threadColors.map((color) => {
		const mesh = new Mesh(
			ribbonGeometry(color),
			new MeshBasicMaterial({ vertexColors: true, transparent: true, depthWrite: false }),
		);
		mesh.frustumCulled = false;
		page.add(mesh);
		return mesh;
	});

	// Four caret bars in one geometry (one draw call).
	const caretGeometry = new BufferGeometry();
	const caretPositions = new BufferAttribute(new Float32Array(4 * 4 * 3), 3);
	caretPositions.setUsage(DynamicDrawUsage);
	const caretColors = new BufferAttribute(new Float32Array(4 * 4 * 4), 4);
	caretColors.setUsage(DynamicDrawUsage);
	threadColors.forEach((c, i) => {
		for (let v = 0; v < 4; v++) caretColors.set([c.r, c.g, c.b, 1], (i * 4 + v) * 4);
	});
	const caretIndex: number[] = [];
	for (let i = 0; i < 4; i++)
		caretIndex.push(i * 4, i * 4 + 1, i * 4 + 2, i * 4 + 2, i * 4 + 1, i * 4 + 3);
	caretGeometry.setAttribute("position", caretPositions);
	caretGeometry.setAttribute("color", caretColors);
	caretGeometry.setIndex(caretIndex);
	const carets = new Mesh(
		caretGeometry,
		new MeshBasicMaterial({ vertexColors: true, transparent: true }),
	);
	carets.frustumCulled = false;
	page.add(carets);

	let sim: Sim = options.reducedMotion ? stillFrame() : createSim();
	if (!options.reducedMotion) advance(sim, 6);

	// Name flags: wait briefly for the mono face so the canvas text uses it.
	let font = "monospace";
	try {
		await Promise.race([
			document.fonts.load('600 30px "Geist Mono Variable"'),
			new Promise((r) => setTimeout(r, 800)),
		]);
		if (document.fonts.check('600 30px "Geist Mono Variable"'))
			font = '"Geist Mono Variable", monospace';
	} catch {}
	const hex = THREADS.map((name) =>
		getComputedStyle(document.documentElement).getPropertyValue(name).trim(),
	);
	const flags = sim.heads.map((head, i) => {
		const material = new SpriteMaterial({
			map: flagTexture(head.name, hex[i] || "#888", font),
			depthTest: false,
			transparent: true,
		});
		const sprite = new Sprite(material);
		sprite.center.set(0, 0);
		sprite.scale.set(0.57, 0.19, 1);
		sprite.renderOrder = 10;
		page.add(sprite);
		return sprite;
	});

	const point: [number, number] = [0, 0];
	const prev: [number, number] = [0, 0];

	function writeRibbon(mesh: Mesh, head: Head, phase: number, t: number) {
		const attr = mesh.geometry.getAttribute("position") as BufferAttribute;
		const array = attr.array as Float32Array;
		for (let j = 0; j < TRAIL; j++) {
			trailPoint(head, j, point);
			trailPoint(head, Math.max(0, j - 1), prev);
			let tx = point[0] - prev[0];
			let ty = point[1] - prev[1];
			const len = Math.hypot(tx, ty);
			if (len < 1e-5) {
				tx = 1;
				ty = 0;
			} else {
				tx /= len;
				ty /= len;
			}
			const nx = -ty * (RIBBON_WIDTH / 2);
			const ny = tx * (RIBBON_WIDTH / 2);
			// Near the head the thread rises above the page, so the caret is never hidden.
			const lift = Math.max(0, (j - (TRAIL - 14)) / 14) * 0.06;
			const z = swell(point[0], point[1], t) + weave(point[0], phase) + lift;
			const o = j * 6;
			array[o] = point[0] + nx;
			array[o + 1] = point[1] + ny;
			array[o + 2] = z;
			array[o + 3] = point[0] - nx;
			array[o + 4] = point[1] - ny;
			array[o + 5] = z;
		}
		attr.needsUpdate = true;
	}

	function update() {
		const t = sim.t;
		surface.u.uTime.value = t;
		ruleMaterial.u.uTime.value = t;
		const caretArray = caretPositions.array as Float32Array;
		const caretRgba = caretColors.array as Float32Array;
		sim.heads.forEach((head, i) => {
			const fade = edgeFade(head.x);
			const ribbon = ribbons[i];
			if (ribbon) {
				writeRibbon(ribbon, head, head.phase, t);
				(ribbon.material as MeshBasicMaterial).opacity = fade;
			}
			const flag = flags[i];
			if (flag) flag.material.opacity = fade;
			for (let v = 0; v < 4; v++) caretRgba[(i * 4 + v) * 4 + 3] = fade;
			const z = swell(head.x, head.y, t) + 0.07;
			const corners = [
				[head.x - 0.011, head.y - 0.1],
				[head.x + 0.011, head.y - 0.1],
				[head.x - 0.011, head.y + 0.1],
				[head.x + 0.011, head.y + 0.1],
			];
			corners.forEach(([x, y], v) => {
				caretArray.set([x ?? 0, y ?? 0, z], (i * 4 + v) * 3);
			});
			flags[i]?.position.set(head.x - 0.011, head.y + 0.11, z);
		});
		caretPositions.needsUpdate = true;
		caretColors.needsUpdate = true;
	}

	// --- colours ---------------------------------------------------------------------------

	function recolor() {
		const paper = cssColor("--paper");
		const dark = paper.r + paper.g + paper.b < 1.2;
		const sheetColor = cssColor("--paper-2");
		const rule = cssColor("--rule");
		if (dark) rule.offsetHSL(0, 0, 0.15);
		renderer.setClearColor(paper);
		(scene.fog as Fog).color.copy(paper);
		surface.u.uColor.value.copy(sheetColor);
		surface.u.uFogColor.value.copy(paper);
		ruleMaterial.u.uColor.value.copy(rule);
		ruleMaterial.u.uFogColor.value.copy(paper);
	}

	// --- sizing, parallax, loop ------------------------------------------------------------

	let width = 0;
	let height = 0;
	function resize() {
		const rect = canvas.getBoundingClientRect();
		width = Math.max(1, Math.round(rect.width));
		height = Math.max(1, Math.round(rect.height));
		const narrow = window.innerWidth < 640;
		renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, narrow ? 1.25 : 1.75));
		renderer.setSize(width, height, false);
		camera.aspect = width / height;
		// Keep the whole page in view on tall, narrow canvases.
		camera.position.z = camera.aspect < 1 ? DISTANCE / Math.max(0.55, camera.aspect) : DISTANCE;
		// Desktop: the canvas is the hero's right side, so the page leans right; phones: centred band.
		page.position.x = window.innerWidth < 760 ? 0 : 0.45;
		camera.updateProjectionMatrix();
	}

	const tilt = { x: 0, y: 0, tx: 0, ty: 0 };
	const base = { x: page.rotation.x, y: page.rotation.y };
	const onPointer = (event: PointerEvent) => {
		tilt.ty = ((event.clientX / window.innerWidth) * 2 - 1) * 0.05;
		tilt.tx = ((event.clientY / window.innerHeight) * 2 - 1) * 0.05;
	};

	let reduced = options.reducedMotion;
	let visible = !document.hidden;
	let onscreen = true;
	let frame = 0;
	let last = 0;
	let disposed = false;

	function draw() {
		page.rotation.x = base.x + tilt.x;
		page.rotation.y = base.y + tilt.y;
		update();
		renderer.render(scene, camera);
	}

	function loop(now: number) {
		frame = 0;
		if (disposed || reduced || !visible || !onscreen) return;
		const dt = last ? (now - last) / 1000 : 0;
		last = now;
		step(sim, dt);
		const k = 1 - Math.exp(-dt * 4);
		tilt.x += (tilt.tx - tilt.x) * k;
		tilt.y += (tilt.ty - tilt.y) * k;
		draw();
		frame = requestAnimationFrame(loop);
	}

	function schedule() {
		if (disposed) return;
		if (reduced) {
			draw();
			return;
		}
		if (!frame && visible && onscreen) {
			last = 0;
			frame = requestAnimationFrame(loop);
		}
	}

	let resizeFrame = 0;
	const resizeObserver = new ResizeObserver(() => {
		if (resizeFrame) return;
		resizeFrame = requestAnimationFrame(() => {
			resizeFrame = 0;
			resize();
			if (reduced) draw();
		});
	});
	resizeObserver.observe(canvas);
	const intersection = new IntersectionObserver((entries) => {
		onscreen = entries.some((e) => e.isIntersecting);
		schedule();
	});
	intersection.observe(canvas);
	const onVisibility = () => {
		visible = !document.hidden;
		schedule();
	};
	document.addEventListener("visibilitychange", onVisibility);
	window.addEventListener("pointermove", onPointer, { passive: true });

	const onLost = (event: Event) => {
		event.preventDefault();
		dispose();
		options.onFail();
	};
	canvas.addEventListener("webglcontextlost", onLost);
	window.addEventListener("pagehide", dispose);

	function dispose() {
		if (disposed) return;
		disposed = true;
		if (frame) cancelAnimationFrame(frame);
		resizeObserver.disconnect();
		intersection.disconnect();
		document.removeEventListener("visibilitychange", onVisibility);
		window.removeEventListener("pointermove", onPointer);
		window.removeEventListener("pagehide", dispose);
		canvas.removeEventListener("webglcontextlost", onLost);
		page.traverse((object) => {
			const mesh = object as Mesh;
			mesh.geometry?.dispose();
			const material = mesh.material as (MeshBasicMaterial | SpriteMaterial) | undefined;
			if (material) {
				(material as SpriteMaterial).map?.dispose();
				material.dispose();
			}
		});
		renderer.dispose();
	}

	recolor();
	resize();
	draw();
	schedule();

	return {
		setReducedMotion(next) {
			if (next === reduced) return;
			reduced = next;
			sim = next ? stillFrame() : createSim();
			if (!next) advance(sim, 6);
			tilt.tx = tilt.ty = tilt.x = tilt.y = 0;
			schedule();
		},
		recolor() {
			recolor();
			if (reduced || !frame) draw();
		},
		dispose,
	};
}
