/**
 * The display's scene, with no DOM: three people co-write a short note on a dot lattice. It is
 * deterministic (a fixed script and a seeded jitter), so the canvas animation, the reduced-motion
 * still, the build-time SVG and the tests all come from this one module.
 */
import { GLYPH_H, GLYPH_W, GLYPHS, TAG_H, TAG_W, TAGS } from "./glyphs";

/** One character cell: the glyph plus a blank column. */
export const CELL = GLYPH_W + 1;
/** Rows a line takes: name tag (5), caret top (1), glyph (7), caret bottom (1), gap (1). */
export const LINE_ROWS = TAG_H + GLYPH_H + 3;
export const LINES = 3;
export const MARGIN_X = 3;
/** Fewest rows and columns the scene fits in. */
export const MIN_ROWS = LINES * LINE_ROWS;
/** Rows from the top of the first line of text to the bottom of the last. */
const TEXT_ROWS = (LINES - 1) * LINE_ROWS + GLYPH_H;
export const NARROW_CHARS = 9;
export const WIDE_CHARS = 18;
export const MIN_COLS = MARGIN_X * 2 + NARROW_CHARS * CELL;

/** Seconds a name tag stays up after its peer last did something. */
const TAG_HOLD = 3.2;
/** Where the still frame is taken: mid-sentence, one peer following another. */
export const STILL_T = 7;

export const FG = 0;
export const RED = 1;

type Op =
	| { k: "until"; t: number }
	| { k: "wait"; s: number }
	| { k: "go"; line: number; col: number | "end" }
	| { k: "type"; text: string }
	| { k: "erase"; n: number }
	| { k: "select" }
	| { k: "cut" }
	| { k: "follow"; peer: number; s: number };

export interface Peer {
	name: string;
	tone: number;
	/** Brightness of this peer's caret and tag (the third peer is grey). */
	gain: number;
	line: number;
	col: number;
	/** Seconds since this peer last acted. */
	idle: number;
	/** Index of the peer being followed, or -1. */
	follow: number;
	sel: { from: number; to: number } | null;
	doing: "idle" | "typing" | "selecting" | "following";
	ops: Op[];
	pc: number;
	acc: number;
	delay: number;
	done: number;
}

export interface Scene {
	cols: number;
	rows: number;
	/** Characters that fit on a line. */
	chars: number;
	narrow: boolean;
	x0: number;
	y0: number;
	text: string[];
	peers: Peer[];
	/** Seconds into the current note. */
	t: number;
	note: number;
	/** How many notes have been written and cleared. */
	cycles: number;
	/** What is happening, for the label over the display. */
	status: string;
	/** The visitor's pointer as a fourth caret, in cells. */
	you: { x: number; y: number } | null;
	seed: number;
}

const NAMES = ["ANA", "KAI", "SOL"] as const;
const ANA = 0;
const SOL = 2;

const until = (t: number): Op => ({ k: "until", t });
const wait = (s: number): Op => ({ k: "wait", s });
const go = (line: number, col: number | "end"): Op => ({ k: "go", line, col });
const type = (text: string): Op => ({ k: "type", text });
const clear = (t: number, line: number): Op[] => [
	until(t),
	go(line, "end"),
	{ k: "select" },
	{ k: "cut" },
];

/** The two notes, per peer. Narrow lines fit nine characters, wide ones eighteen. */
function script(note: number, narrow: boolean): Op[][] {
	if (note === 0) {
		const ship = narrow ? "- SHIP I" : "- SHIP THE REL";
		const invite = narrow ? "- INVITE" : "- INVITE KAI + SOL";
		return [
			[until(0.6), go(0, 0), type("# FRIDAY"), until(5), go(2, 0), type(invite), ...clear(12.4, 2)],
			[
				until(1.4),
				go(1, 0),
				type(`${ship}Y`),
				wait(0.45),
				{ k: "erase", n: 1 },
				wait(0.2),
				type(narrow ? "T" : "AY"),
				...(narrow ? [] : [until(9.2), go(0, "end"), type(" PLAN")]),
				...clear(12.9, 1),
			],
			[
				until(3.2),
				go(0, "end"),
				wait(0.6),
				{ k: "follow", peer: ANA, s: 4.8 },
				...clear(13.4, 0),
				wait(1.2),
			],
		];
	}
	const cursor = narrow ? "- CURSORS" : "- EVERY CURSOR";
	const folder = narrow ? "- FOLDER" : "- ONE FOLDER";
	return [
		[
			until(2),
			go(1, "end"),
			{ k: "follow", peer: SOL, s: 2.6 },
			until(7.4),
			go(0, "end"),
			type(narrow ? " 2" : " 02"),
			...clear(11.9, 0),
			wait(1.2),
		],
		[until(0.5), go(0, 0), type("# IDEAS"), until(4.4), go(2, 0), type(folder), ...clear(10.9, 2)],
		[until(1.5), go(1, 0), type(cursor), ...clear(11.4, 1)],
	];
}

function rand(scene: Scene): number {
	scene.seed = (scene.seed + 0x6d2b79f5) | 0;
	let x = Math.imul(scene.seed ^ (scene.seed >>> 15), 1 | scene.seed);
	x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x;
	return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
}

function load(scene: Scene): void {
	const ops = script(scene.note, scene.narrow);
	scene.t = 0;
	scene.peers.forEach((peer, i) => {
		peer.ops = ops[i] ?? [];
		peer.pc = 0;
		peer.acc = 0;
		peer.done = 0;
		peer.delay = 0.12;
	});
}

export interface SceneOptions {
	/** Force the nine-character script; by default it follows the width. */
	narrow?: boolean;
}

export function createScene(cols: number, rows: number, options: SceneOptions = {}): Scene {
	const chars = Math.floor((cols - MARGIN_X * 2) / CELL);
	const scene: Scene = {
		cols,
		rows,
		chars,
		narrow: options.narrow ?? chars < WIDE_CHARS,
		x0: MARGIN_X,
		// Centre the three lines of text, not their tag rows.
		y0: Math.max(0, Math.min(rows - MIN_ROWS, Math.floor((rows - TEXT_ROWS) / 2) - TAG_H - 1)),
		text: Array.from({ length: LINES }, () => ""),
		peers: NAMES.map((name, i) => ({
			name,
			tone: i === ANA ? RED : FG,
			gain: i === SOL ? 0.62 : 1,
			line: i,
			col: 0,
			idle: 99,
			follow: -1,
			sel: null,
			doing: "idle",
			ops: [],
			pc: 0,
			acc: 0,
			delay: 0.12,
			done: 0,
		})),
		t: 0,
		note: 0,
		cycles: 0,
		status: "IN SYNC",
		you: null,
		seed: 7,
	};
	load(scene);
	return scene;
}

/** The scene at its still frame. */
export function stillScene(cols: number, rows: number, options: SceneOptions = {}): Scene {
	const scene = createScene(cols, rows, options);
	for (let i = 0; i < STILL_T * 30; i++) advance(scene, 1 / 30);
	return scene;
}

function insert(scene: Scene, peer: Peer, ch: string): void {
	const line = scene.text[peer.line] ?? "";
	if (line.length >= scene.chars) return;
	scene.text[peer.line] = line.slice(0, peer.col) + ch + line.slice(peer.col);
	for (const other of scene.peers) {
		if (other !== peer && other.line === peer.line && other.col > peer.col) other.col += 1;
	}
	peer.col += 1;
}

function remove(scene: Scene, line: number, from: number, to: number): void {
	const text = scene.text[line] ?? "";
	scene.text[line] = text.slice(0, from) + text.slice(to);
	for (const other of scene.peers) {
		if (other.line !== line) continue;
		if (other.col >= to) other.col -= to - from;
		else if (other.col > from) other.col = from;
	}
}

function step(scene: Scene, peer: Peer, dt: number): void {
	peer.acc += dt;
	peer.idle += dt;
	for (;;) {
		const op = peer.ops[peer.pc];
		if (!op) {
			peer.doing = "idle";
			return;
		}
		switch (op.k) {
			case "until":
				if (scene.t < op.t) {
					peer.doing = "idle";
					return;
				}
				peer.acc = 0;
				break;
			case "wait":
				if (peer.acc < op.s) {
					peer.doing = "idle";
					return;
				}
				peer.acc -= op.s;
				break;
			case "go":
				peer.line = op.line;
				peer.col = op.col === "end" ? (scene.text[op.line] ?? "").length : op.col;
				peer.sel = null;
				peer.idle = 0;
				break;
			case "type": {
				peer.doing = "typing";
				if (peer.acc < peer.delay) return;
				peer.acc -= peer.delay;
				const ch = op.text[peer.done] ?? " ";
				insert(scene, peer, ch);
				peer.idle = 0;
				peer.delay = 0.1 + rand(scene) * 0.09 + (ch === " " ? 0.06 : 0);
				peer.done += 1;
				if (peer.done < op.text.length) return;
				peer.done = 0;
				break;
			}
			case "erase":
				peer.doing = "typing";
				if (peer.acc < 0.12) return;
				peer.acc -= 0.12;
				if (peer.col > 0) remove(scene, peer.line, peer.col - 1, peer.col);
				peer.idle = 0;
				peer.done += 1;
				if (peer.done < op.n) return;
				peer.done = 0;
				break;
			case "select": {
				peer.doing = "selecting";
				peer.sel ??= { from: peer.col, to: peer.col };
				if (peer.acc < 0.04) return;
				peer.acc -= 0.04;
				peer.idle = 0;
				if (peer.sel.from > 0) {
					peer.sel.from -= 1;
					peer.col = peer.sel.from;
					return;
				}
				break;
			}
			case "cut":
				peer.doing = "selecting";
				if (peer.acc < 0.45) return;
				peer.acc = 0;
				if (peer.sel) remove(scene, peer.line, peer.sel.from, peer.sel.to);
				peer.sel = null;
				peer.col = 0;
				peer.idle = 0;
				break;
			case "follow": {
				const target = scene.peers[op.peer];
				if (target && peer.acc < op.s) {
					peer.doing = "following";
					peer.follow = op.peer;
					peer.line = target.line;
					peer.col = target.col;
					peer.idle = 0;
					return;
				}
				peer.acc = 0;
				peer.follow = -1;
				break;
			}
		}
		peer.pc += 1;
	}
}

function describe(scene: Scene): string {
	const by = (doing: Peer["doing"]) => scene.peers.filter((p) => p.doing === doing);
	const [follower] = by("following");
	if (follower) return `${follower.name} FOLLOWING ${scene.peers[follower.follow]?.name ?? ""}`;
	const [selecting] = by("selecting");
	if (selecting) return `${selecting.name} SELECTING`;
	const typing = by("typing");
	if (typing.length) return `${typing.map((p) => p.name).join(" + ")} TYPING`;
	return "IN SYNC";
}

/** Moves the scene on by `dt` seconds; when a note is written and cleared, the next one starts. */
export function advance(scene: Scene, dt: number): void {
	scene.t += dt;
	for (const peer of scene.peers) step(scene, peer, dt);
	scene.status = describe(scene);
	if (scene.peers.every((p) => p.pc >= p.ops.length)) {
		scene.note = (scene.note + 1) % 2;
		scene.cycles += 1;
		scene.text.fill("");
		load(scene);
	}
}

/** The first row of a line's block (its name-tag row). */
export const lineTop = (scene: Scene, line: number) => scene.y0 + line * LINE_ROWS;
/** The dot column of the caret before character `col`. */
export const caretX = (scene: Scene, col: number) => scene.x0 + col * CELL - 1;

function stamp(
	scene: Scene,
	level: Float32Array,
	tone: Uint8Array,
	glyph: string[] | undefined,
	x: number,
	y: number,
	value: number,
	color: number,
): void {
	if (!glyph) return;
	for (let gy = 0; gy < glyph.length; gy++) {
		const row = glyph[gy] ?? "";
		const cy = y + gy;
		if (cy < 0 || cy >= scene.rows) continue;
		for (let gx = 0; gx < row.length; gx++) {
			const cx = x + gx;
			if (row[gx] === "." || cx < 0 || cx >= scene.cols) continue;
			const i = cy * scene.cols + cx;
			if (value >= (level[i] ?? 0)) {
				level[i] = value;
				tone[i] = color;
			}
		}
	}
}

function bar(
	scene: Scene,
	level: Float32Array,
	tone: Uint8Array,
	x: number,
	y: number,
	height: number,
	value: number,
	color: number,
): void {
	if (x < 0 || x >= scene.cols) return;
	for (let cy = Math.max(0, y); cy < Math.min(scene.rows, y + height); cy++) {
		level[cy * scene.cols + x] = value;
		tone[cy * scene.cols + x] = color;
	}
}

function tag(
	scene: Scene,
	level: Float32Array,
	tone: Uint8Array,
	name: string,
	x: number,
	y: number,
	value: number,
	color: number,
	endAt: boolean,
): void {
	const width = name.length * (TAG_W + 1) - 1;
	let left = endAt ? x - width + 1 : x;
	left = Math.max(0, Math.min(scene.cols - width, left));
	[...name].forEach((ch, i) => {
		stamp(scene, level, tone, TAGS[ch], left + i * (TAG_W + 1), y, value, color);
	});
}

/**
 * Writes what the display should show into `level` (0 unlit to 1 lit, per dot) and `tone` (FG or
 * RED). Both are `cols × rows`.
 */
export function paint(scene: Scene, level: Float32Array, tone: Uint8Array): void {
	level.fill(0);
	tone.fill(FG);
	for (let line = 0; line < LINES; line++) {
		const y = lineTop(scene, line) + TAG_H + 1;
		[...(scene.text[line] ?? "")].forEach((ch, i) => {
			stamp(scene, level, tone, GLYPHS[ch], scene.x0 + i * CELL, y, 1, FG);
		});
	}
	for (const peer of scene.peers) {
		if (!peer.sel) continue;
		const y = lineTop(scene, peer.line) + TAG_H;
		for (let x = caretX(scene, peer.sel.from); x < caretX(scene, peer.sel.to); x++) {
			for (let cy = y; cy < y + GLYPH_H + 2; cy++) {
				const i = cy * scene.cols + x;
				if (x >= 0 && x < scene.cols && cy < scene.rows && (level[i] ?? 0) === 0) {
					level[i] = 0.3 * peer.gain;
					tone[i] = peer.tone;
				}
			}
		}
	}
	scene.peers.forEach((peer, index) => {
		// A follower's caret sits right beside the one it follows, its tag on the other side.
		const following = peer.follow >= 0;
		const x = caretX(scene, peer.col) + (following ? 1 : 0);
		const top = lineTop(scene, peer.line);
		const blink = peer.idle < 0.5 || (scene.t + index * 0.37) % 1.1 < 0.62;
		if (blink) bar(scene, level, tone, x, top + TAG_H, GLYPH_H + 2, peer.gain, peer.tone);
		const shown = Math.max(0, Math.min(1, (TAG_HOLD - peer.idle) / 0.4));
		if (shown > 0) {
			const at = following ? x - 5 : x;
			tag(scene, level, tone, peer.name, at, top, peer.gain * shown, peer.tone, following);
		}
	});
	if (scene.you) {
		const { x, y } = scene.you;
		bar(scene, level, tone, x, y - 4, GLYPH_H + 2, 1, FG);
		tag(scene, level, tone, "YOU", x, y - 4 - TAG_H - 1, 1, FG, false);
	}
}
