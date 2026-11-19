/**
 * The display's scene, with no DOM: three people co-write a short note on a dot lattice. It is
 * deterministic (a fixed script and a seeded jitter), so the canvas animation, the reduced-motion
 * still, the build-time SVG and the tests all come from this one module.
 */
import { GLYPH_H, GLYPH_W, GLYPHS, TAG_H, TAG_W, TAGS } from "./glyphs";

/** One character cell: the glyph plus a blank column. */
export const CELL = GLYPH_W + 1;
/**
 * Rows a line takes: name tag (5), two clear rows, glyph (7), one row under it, one clear row.
 * The caret is a pole from under its tag to under the text, so a tag hangs off its own caret and
 * never comes within two dots of the text below it.
 */
export const LINE_ROWS = TAG_H + GLYPH_H + 4;
/** Rows from a line's top to its glyphs. */
const GLYPH_TOP = TAG_H + 2;
/** Dots in a caret. */
export const CARET_H = GLYPH_H + 3;
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
/** The third peer's grey. */
export const DIM = 2;

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
	/** The visitor's pointer, in dots; it becomes a fourth caret on the nearest line. */
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
		y0: Math.max(0, Math.min(rows - MIN_ROWS, Math.floor((rows - TEXT_ROWS) / 2) - GLYPH_TOP)),
		text: Array.from({ length: LINES }, () => ""),
		peers: NAMES.map((name, i) => ({
			name,
			tone: i === ANA ? RED : i === SOL ? DIM : FG,
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
			case "select":
				// The whole line at once, as a triple click would: the caret and its tag move once.
				peer.doing = "selecting";
				peer.sel = { from: 0, to: peer.col };
				peer.col = 0;
				peer.idle = 0;
				peer.acc = 0;
				break;
			case "cut":
				peer.doing = "selecting";
				if (peer.acc < 0.7) return;
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

/** Where one caret and its name tag are drawn. */
export interface Mark {
	name: string;
	tone: number;
	line: number;
	/** The caret's dot column, or null when another caret already has its place. */
	x: number | null;
	/** The tag's first dot column, or null when it has no tag. */
	tagLeft: number | null;
	/** With a tag up the caret stays lit; otherwise it blinks. */
	lit: boolean;
}

const tagWidth = (name: string) => name.length * (TAG_W + 1) - 1;
/** Dots kept clear between two tags on a line. */
const TAG_GAP = 3;

/**
 * Places every caret and tag so that none shares a dot with another or with the text:
 * - a tag sits in the gap above its line, starting at its own caret (or ending at it when it
 *   would run off the display or into another tag), and is dropped if neither side is free;
 * - a caret with a tag stays lit, so no tag is ever left without its caret;
 * - carets on the same spot: the first keeps it, the next moves one dot into free space (or is
 *   not drawn inside text); a follower never shows a tag while it sits on its leader.
 */
export function marks(scene: Scene): Mark[] {
	const holders = scene.peers.map((peer, index) => ({
		name: peer.name as string,
		tone: peer.tone,
		line: peer.line,
		col: peer.col,
		following: peer.follow >= 0,
		wantsTag: peer.follow < 0 && peer.idle < TAG_HOLD,
		blinkOn: peer.idle < 0.5 || (scene.t + index * 0.37) % 1.1 < 0.62,
		// The visitor first, then leaders before followers, then whoever acted last.
		rank: (peer.follow >= 0 ? 1000 : 0) + Math.min(peer.idle, 900) + index / 10,
	}));
	if (scene.you) {
		const maxCol = Math.floor((scene.cols - 1 - scene.x0) / CELL);
		const line = Math.round((scene.you.y - scene.y0 - GLYPH_TOP - (GLYPH_H - 1) / 2) / LINE_ROWS);
		holders.push({
			name: "YOU",
			tone: FG,
			line: Math.max(0, Math.min(LINES - 1, line)),
			col: Math.max(0, Math.min(maxCol, Math.round((scene.you.x - scene.x0 + 1) / CELL))),
			following: false,
			wantsTag: true,
			blinkOn: true,
			rank: -1,
		});
	}
	holders.sort((a, b) => a.rank - b.rank);

	const out: Mark[] = [];
	const carets = new Set<string>();
	const tags: { line: number; left: number; right: number }[] = [];
	for (const holder of holders) {
		const base = caretX(scene, holder.col);
		const length = (scene.text[holder.line] ?? "").length;
		// Free dots beside this spot: to the right past the end of the line, to the left before it.
		const step = holder.col >= length ? 1 : holder.col === 0 ? -1 : 0;
		let x: number | null = base;
		while (x !== null && carets.has(`${holder.line}:${x}`)) {
			x = step === 0 || x + step < 0 || x + step >= scene.cols ? null : x + step;
		}
		if (x !== null) carets.add(`${holder.line}:${x}`);

		let tagLeft: number | null = null;
		if (x !== null && holder.wantsTag) {
			const width = tagWidth(holder.name);
			const free = (left: number) =>
				left >= 0 &&
				left + width <= scene.cols &&
				!tags.some(
					(t) =>
						t.line === holder.line &&
						left <= t.right + TAG_GAP &&
						left + width - 1 >= t.left - TAG_GAP,
				);
			tagLeft = [x, x - width + 1].find(free) ?? null;
			if (tagLeft !== null)
				tags.push({ line: holder.line, left: tagLeft, right: tagLeft + width - 1 });
		}
		out.push({
			name: holder.name,
			tone: holder.tone,
			line: holder.line,
			x,
			tagLeft,
			lit: tagLeft !== null || holder.blinkOn,
		});
	}
	return out;
}

/** Lights the dots of `glyph`; `claims` counts how many solid things use each dot. */
function stamp(
	scene: Scene,
	level: Float32Array,
	tone: Uint8Array,
	claims: Uint8Array | undefined,
	glyph: string[] | undefined,
	x: number,
	y: number,
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
			level[i] = 1;
			tone[i] = color;
			if (claims) claims[i] = (claims[i] ?? 0) + 1;
		}
	}
}

/**
 * Writes what the display should show into `level` (0 unlit to 1 lit, per dot) and `tone` (FG,
 * RED or DIM). Both are `cols × rows`. `claims`, for tests, counts the text, tags and carets on
 * each dot: more than one means two of them collide.
 */
export function paint(
	scene: Scene,
	level: Float32Array,
	tone: Uint8Array,
	claims?: Uint8Array,
): void {
	level.fill(0);
	tone.fill(FG);
	claims?.fill(0);
	for (let line = 0; line < LINES; line++) {
		const y = lineTop(scene, line) + GLYPH_TOP;
		[...(scene.text[line] ?? "")].forEach((ch, i) => {
			stamp(scene, level, tone, claims, GLYPHS[ch], scene.x0 + i * CELL, y, FG);
		});
	}
	// A selection raises the unlit dots under it; the text on it stays as it is.
	for (const peer of scene.peers) {
		if (!peer.sel) continue;
		const y = lineTop(scene, peer.line) + GLYPH_TOP;
		for (let x = caretX(scene, peer.sel.from) + 1; x < caretX(scene, peer.sel.to); x++) {
			for (let cy = y; cy < y + GLYPH_H + 1; cy++) {
				const i = cy * scene.cols + x;
				if (x >= 0 && x < scene.cols && cy < scene.rows && (level[i] ?? 0) === 0) {
					level[i] = 0.3;
					tone[i] = peer.tone;
				}
			}
		}
	}
	const bar = Array<string>(CARET_H).fill("#");
	for (const mark of marks(scene)) {
		const top = lineTop(scene, mark.line);
		if (mark.x !== null && mark.lit) {
			// A caret grows one dot to reach its tag; without one it stops a row short of the tag
			// gap, so it never looks attached to somebody else's tag.
			const reach = mark.tagLeft === null ? 1 : 0;
			stamp(scene, level, tone, claims, bar.slice(reach), mark.x, top + TAG_H + reach, mark.tone);
		}
		if (mark.tagLeft !== null) {
			[...mark.name].forEach((ch, i) => {
				const x = (mark.tagLeft ?? 0) + i * (TAG_W + 1);
				stamp(scene, level, tone, claims, TAGS[ch], x, top, mark.tone);
			});
		}
	}
}
