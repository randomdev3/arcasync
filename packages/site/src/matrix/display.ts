/**
 * The display's renderer: the scene on a 2D canvas. A flat lattice of dots needs no 3D, so there
 * is no WebGL: the dots are stamped from a small pre-rendered atlas, and each frame redraws only
 * the dots whose brightness changed. The pitch is a whole number of device pixels, which keeps
 * every dot identical.
 */
import { advance, DIM, FG, MIN_COLS, MIN_ROWS, paint, RED, type Scene, stillScene } from "./scene";
import { R_OFF, R_ON } from "./svg";

const LEVELS = 16;
/**
 * Seconds a dot takes to come on. Dots go out at once: anything slower leaves a ghost of a moving
 * caret or name tag behind it.
 */
const RISE = 0.03;

export interface DisplayOptions {
	reducedMotion: boolean;
	/** Called when the scene's status line changes. */
	onStatus?: (status: string, online: number) => void;
}

export interface Display {
	setReducedMotion(reduced: boolean): void;
	/** Re-reads the theme's colours. */
	recolor(): void;
	destroy(): void;
	/** Milliseconds the last frames took to simulate and draw (for measurement). */
	frameCost(): number;
}

type Rgb = [number, number, number];

function parseColor(value: string, fallback: Rgb): Rgb {
	const hex = value.trim().match(/^#([0-9a-f]{6})$/i)?.[1];
	if (!hex) return fallback;
	return [0, 2, 4].map((i) => Number.parseInt(hex.slice(i, i + 2), 16)) as Rgb;
}

export function createDisplay(
	host: HTMLElement,
	canvas: HTMLCanvasElement,
	options: DisplayOptions,
): Display | null {
	const ctx = canvas.getContext("2d");
	if (!ctx) return null;

	let reduced = options.reducedMotion;
	let scene: Scene | null = null;
	let target = new Float32Array(0);
	let tone = new Uint8Array(0);
	let shown = new Float32Array(0);
	let shownTone = new Uint8Array(0);
	let drawn = new Int16Array(0);
	let atlas: HTMLCanvasElement | null = null;
	let pitch = 0;
	let raf = 0;
	let last = 0;
	let visible = true;
	let status = "";
	let cost = 0;

	function buildAtlas() {
		const style = getComputedStyle(host);
		const off = parseColor(style.getPropertyValue("--dot-off"), [34, 34, 34]);
		const tones: Rgb[] = [];
		tones[FG] = parseColor(style.getPropertyValue("--fg"), [240, 240, 236]);
		tones[RED] = parseColor(style.getPropertyValue("--red"), [255, 59, 47]);
		tones[DIM] = parseColor(style.getPropertyValue("--fg-2"), [163, 163, 159]);
		atlas = document.createElement("canvas");
		atlas.width = pitch * LEVELS;
		atlas.height = pitch * tones.length;
		const a = atlas.getContext("2d");
		if (!a) return;
		tones.forEach((rgb, t) => {
			for (let l = 0; l < LEVELS; l++) {
				const k = l / (LEVELS - 1);
				const mix = rgb.map((c, i) => Math.round((off[i] ?? 0) + (c - (off[i] ?? 0)) * k));
				a.fillStyle = `rgb(${mix.join(" ")})`;
				a.beginPath();
				a.arc(
					l * pitch + pitch / 2,
					t * pitch + pitch / 2,
					pitch * (R_OFF + (R_ON - R_OFF) * k),
					0,
					Math.PI * 2,
				);
				a.fill();
			}
		});
	}

	function draw(dt: number, snap: boolean) {
		if (!scene || !atlas) return;
		paint(scene, target, tone);
		const up = snap ? 1 : 1 - Math.exp(-dt / RISE);
		const { cols } = scene;
		for (let i = 0; i < target.length; i++) {
			const want = target[i] ?? 0;
			const have = shown[i] ?? 0;
			if (want > 0) shownTone[i] = tone[i] ?? FG;
			const next = want > have ? have + (want - have) * up : want;
			shown[i] = next;
			const level = Math.round(next * (LEVELS - 1));
			const key = level + (shownTone[i] ?? 0) * LEVELS;
			if (key === drawn[i]) continue;
			drawn[i] = key;
			const x = (i % cols) * pitch;
			const y = Math.floor(i / cols) * pitch;
			ctx?.clearRect(x, y, pitch, pitch);
			ctx?.drawImage(
				atlas,
				level * pitch,
				(shownTone[i] ?? 0) * pitch,
				pitch,
				pitch,
				x,
				y,
				pitch,
				pitch,
			);
		}
		if (scene.status !== status) {
			status = scene.status;
			options.onStatus?.(status, scene.peers.length + (scene.you ? 1 : 0));
		}
	}

	function frame(now: number) {
		raf = 0;
		if (!scene) return;
		const dt = Math.min(0.05, last ? (now - last) / 1000 : 1 / 60);
		last = now;
		const started = performance.now();
		advance(scene, dt);
		draw(dt, false);
		cost = cost * 0.9 + (performance.now() - started) * 0.1;
		schedule();
	}

	function schedule() {
		if (!raf && visible && !reduced && !document.hidden && scene)
			raf = requestAnimationFrame(frame);
	}

	function stop() {
		if (raf) cancelAnimationFrame(raf);
		raf = 0;
		last = 0;
	}

	function resize() {
		// The inner box: the host's hairlines are not part of the lattice.
		const box = { width: host.clientWidth, height: host.clientHeight };
		const dpr = Math.min(window.devicePixelRatio || 1, 3);
		// The stylesheet owns the pitch (`--pitch`, stepped with the width) and sizes the host from
		// it. Rounding down to a whole device pixel keeps the lattice inside the host at any ratio.
		const cssPitch = Number.parseFloat(getComputedStyle(host).getPropertyValue("--pitch")) || 5;
		const nextPitch = Math.max(2, Math.floor(cssPitch * dpr));
		const cols = Math.floor((box.width * dpr) / nextPitch);
		const rows = Math.floor((box.height * dpr) / nextPitch);
		if (cols < MIN_COLS || rows < MIN_ROWS) return;
		if (scene && cols === scene.cols && rows === scene.rows && nextPitch === pitch) return;
		pitch = nextPitch;
		canvas.width = cols * pitch;
		canvas.height = rows * pitch;
		canvas.style.width = `${(cols * pitch) / dpr}px`;
		canvas.style.height = `${(rows * pitch) / dpr}px`;
		scene = stillScene(cols, rows);
		target = new Float32Array(cols * rows);
		tone = new Uint8Array(cols * rows);
		shown = new Float32Array(cols * rows);
		shownTone = new Uint8Array(cols * rows);
		drawn = new Int16Array(cols * rows).fill(-1);
		buildAtlas();
		draw(0, true);
		schedule();
	}

	function onPointer(event: PointerEvent) {
		if (!scene || reduced || event.pointerType !== "mouse") return;
		const box = canvas.getBoundingClientRect();
		const scale = scene.cols / box.width;
		scene.you = {
			x: Math.floor((event.clientX - box.left) * scale),
			y: Math.floor((event.clientY - box.top) * scale),
		};
		status = "";
	}

	function onLeave() {
		if (scene) scene.you = null;
		status = "";
	}

	const onVisibility = () => (document.hidden ? stop() : schedule());
	const resizer = new ResizeObserver(resize);
	const watcher = new IntersectionObserver(([entry]) => {
		visible = entry?.isIntersecting ?? true;
		if (visible) schedule();
		else stop();
	});
	resizer.observe(host);
	watcher.observe(host);
	document.addEventListener("visibilitychange", onVisibility);
	host.addEventListener("pointermove", onPointer);
	host.addEventListener("pointerleave", onLeave);
	resize();
	if (!scene) return null;

	return {
		setReducedMotion(next) {
			reduced = next;
			if (reduced) {
				stop();
				const { cols, rows } = scene ?? { cols: 0, rows: 0 };
				if (cols) scene = stillScene(cols, rows);
				draw(0, true);
			} else schedule();
		},
		recolor() {
			buildAtlas();
			drawn.fill(-1);
			draw(0, true);
		},
		destroy() {
			stop();
			resizer.disconnect();
			watcher.disconnect();
			document.removeEventListener("visibilitychange", onVisibility);
			host.removeEventListener("pointermove", onPointer);
			host.removeEventListener("pointerleave", onLeave);
		},
		frameCost: () => cost,
	};
}
