import { describe, expect, it } from "vitest";
import { GLYPH_H, GLYPH_W, GLYPHS, MARK, PICTOS, TAGS, wordRows } from "../matrix/glyphs";
import {
	advance,
	CELL,
	caretX,
	createScene,
	LINES,
	lineTop,
	MARGIN_X,
	MIN_COLS,
	MIN_ROWS,
	marks,
	NARROW_CHARS,
	paint,
	RED,
	type Scene,
	STILL_T,
	stillScene,
	WIDE_CHARS,
} from "../matrix/scene";
import { dotsSvg, sceneSvg } from "../matrix/svg";

function frame(scene: Scene) {
	const level = new Float32Array(scene.cols * scene.rows);
	const tone = new Uint8Array(scene.cols * scene.rows);
	paint(scene, level, tone);
	return { level, tone };
}

/** Runs the scene for `seconds` and returns every distinct status it showed. */
function run(scene: Scene, seconds: number, each?: (scene: Scene) => void): Set<string> {
	const seen = new Set<string>();
	for (let i = 0; i < seconds * 30; i++) {
		advance(scene, 1 / 30);
		seen.add(scene.status);
		each?.(scene);
	}
	return seen;
}

describe("glyphs", () => {
	it("draws every letter on the same grid", () => {
		for (const rows of [...Object.values(GLYPHS), MARK]) {
			expect(rows).toHaveLength(GLYPH_H);
			for (const row of rows) expect(row).toMatch(new RegExp(`^[#R.]{${GLYPH_W}}$`));
		}
		for (const rows of Object.values(TAGS)) expect(rows.join("")).toMatch(/^[#.]{15}$/);
		for (const rows of Object.values(PICTOS)) expect(rows.join("")).toMatch(/^[#R.]{49}$/);
	});

	it("sets the wordmark with the mark as its first letter, one red dot in all", () => {
		const rows = wordRows("ARCASYNC", MARK);
		expect(rows[0]).toHaveLength(8 * GLYPH_W + 7);
		expect(rows.join("").split("R")).toHaveLength(2);
	});
});

describe("the display's scene", () => {
	it("is deterministic", () => {
		const a = createScene(150, 51);
		const b = createScene(150, 51);
		run(a, 20);
		run(b, 20);
		expect(a.text).toEqual(b.text);
		expect(frame(a).level).toEqual(frame(b).level);
	});

	it.each([
		["a desktop", 150, 51, false],
		["a phone", 71, 51, true],
		["the smallest phone", 70, 51, true],
		["the narrowest it runs at", MIN_COLS, MIN_ROWS, true],
	])("keeps every line and caret on %s display", (_, cols, rows, narrow) => {
		const scene = createScene(cols, rows);
		expect(scene.narrow).toBe(narrow);
		const longest = { chars: 0 };
		run(scene, 60, (s) => {
			for (const line of s.text) longest.chars = Math.max(longest.chars, line.length);
			for (const peer of s.peers) {
				expect(peer.line).toBeGreaterThanOrEqual(0);
				expect(peer.line).toBeLessThan(LINES);
				expect(caretX(s, peer.col)).toBeGreaterThanOrEqual(MARGIN_X - 1);
				expect(caretX(s, peer.col)).toBeLessThan(cols);
			}
		});
		expect(longest.chars).toBe(narrow ? NARROW_CHARS : WIDE_CHARS);
		expect(longest.chars).toBeLessThanOrEqual(scene.chars);
		expect(MARGIN_X + longest.chars * CELL).toBeLessThanOrEqual(cols);
	});

	it("types, selects, follows, then clears the note and starts the next", () => {
		const scene = createScene(150, 51);
		const seen = run(scene, 30);
		expect(seen).toContain("SOL FOLLOWING ANA");
		expect(seen).toContain("ANA FOLLOWING SOL");
		expect([...seen].some((s) => s.endsWith("TYPING"))).toBe(true);
		expect([...seen].some((s) => s.endsWith("SELECTING"))).toBe(true);
		expect(scene.cycles).toBeGreaterThanOrEqual(2);
	});

	it("fixes its typo and leaves each note empty before the next", () => {
		const scene = createScene(150, 51);
		const lines = new Set<string>();
		let cycles = 0;
		run(scene, 32, (s) => {
			for (const line of s.text) lines.add(line);
			if (s.cycles !== cycles) {
				cycles = s.cycles;
				expect(s.text.join("")).toBe("");
			}
		});
		expect(lines).toContain("- SHIP THE RELY");
		expect(lines).toContain("- SHIP THE RELAY");
		expect(lines).toContain("# FRIDAY PLAN");
		expect(lines).toContain("- INVITE KAI + SOL");
		expect(lines).toContain("- EVERY CURSOR");
	});

	it("has a still frame with text, a red caret and someone following", () => {
		const scene = stillScene(150, 51);
		expect(scene.t).toBeCloseTo(STILL_T, 1);
		expect(scene.status).toBe("SOL FOLLOWING ANA");
		expect(scene.text[0]).toBe("# FRIDAY");
		const { level, tone } = frame(scene);
		const lit = level.filter((v) => v > 0).length;
		const red = tone.filter((t, i) => t === RED && (level[i] ?? 0) > 0).length;
		expect(lit).toBeGreaterThan(300);
		expect(red).toBeGreaterThan(9);
		expect(red).toBeLessThan(lit / 4);
	});

	it("draws the visitor's pointer as a fourth caret on the nearest line", () => {
		const scene = stillScene(150, 51);
		const before = frame(scene).level.filter((v) => v > 0).length;
		scene.you = { x: 120, y: 30 };
		expect(frame(scene).level.filter((v) => v > 0).length).toBeGreaterThan(before + 9);
		const you = marks(scene).find((m) => m.name === "YOU");
		expect(you).toMatchObject({ line: 1, lit: true });
		expect(you?.tagLeft).toBe(you?.x);
	});
});

describe("carets and name tags", () => {
	const TAG_DOTS = 11;

	/** Every rule a frame must keep; returns what it saw, for the coverage checks below. */
	function check(scene: Scene, claims: Uint8Array, level: Float32Array, tone: Uint8Array) {
		paint(scene, level, tone, claims);
		const at = `note ${scene.note} t=${scene.t.toFixed(2)} you=${JSON.stringify(scene.you)}`;
		// No dot is used by two of: text, a tag, a caret.
		expect(Math.max(...claims), at).toBeLessThanOrEqual(1);
		const all = marks(scene);
		const seen = { tags: 0, hiddenTags: 0, moved: 0 };
		for (const mark of all) {
			if (mark.tagLeft === null) continue;
			seen.tags += 1;
			// A tag hangs off its own lit caret, starting or ending on the caret's column.
			expect(mark.x, at).not.toBeNull();
			expect(mark.lit, at).toBe(true);
			expect([mark.tagLeft, mark.tagLeft + TAG_DOTS - 1], at).toContain(mark.x);
			expect(mark.tagLeft, at).toBeGreaterThanOrEqual(0);
			expect(mark.tagLeft + TAG_DOTS, at).toBeLessThanOrEqual(scene.cols);
			// It keeps clear of every other tag on its line, and of the text under it.
			for (const other of all) {
				if (other === mark || other.tagLeft === null || other.line !== mark.line) continue;
				const gap = Math.max(mark.tagLeft, other.tagLeft) - Math.min(mark.tagLeft, other.tagLeft);
				expect(gap, at).toBeGreaterThanOrEqual(TAG_DOTS + 3);
			}
			// Under a tag: only its own caret touches it, and nothing but carets is in the row below.
			const top = lineTop(scene, mark.line);
			const carets = all.filter((m) => m.line === mark.line).map((m) => m.x);
			for (let x = mark.tagLeft; x < mark.tagLeft + TAG_DOTS; x++) {
				if (x !== mark.x) expect(level[(top + 5) * scene.cols + x], at).toBe(0);
				if (!carets.includes(x)) expect(level[(top + 6) * scene.cols + x], at).toBe(0);
			}
		}
		// Carets never share a column; a follower shows no tag.
		const spots = all.filter((m) => m.x !== null).map((m) => `${m.line}:${m.x}`);
		expect(new Set(spots).size, at).toBe(spots.length);
		scene.peers.forEach((peer) => {
			const mark = all.find((m) => m.name === peer.name);
			if (peer.follow >= 0) expect(mark?.tagLeft, at).toBeNull();
			if (mark && mark.x !== null && mark.x !== caretX(scene, peer.col)) seen.moved += 1;
			if (mark && peer.follow < 0 && peer.idle < 3 && mark.tagLeft === null) seen.hiddenTags += 1;
		});
		return seen;
	}

	it.each([
		["a desktop", 150, 51],
		["a tablet", 114, 51],
		["a phone", 71, 51],
		["the smallest phone", 60, 48],
	])(
		"never collide over two full loops on %s display",
		(_, cols, rows) => {
			const scene = createScene(cols, rows);
			const buffers = [
				new Uint8Array(cols * rows),
				new Float32Array(cols * rows),
				new Uint8Array(cols * rows),
			] as const;
			const total = { tags: 0, hiddenTags: 0, moved: 0 };
			let frames = 0;
			while (scene.cycles < 4 && frames < 4000) {
				advance(scene, 1 / 30);
				const seen = check(scene, ...buffers);
				total.tags += seen.tags;
				total.hiddenTags += seen.hiddenTags;
				total.moved += seen.moved;
				frames += 1;
			}
			expect(scene.cycles).toBe(4);
			// The rules were exercised: tags were shown, some gave way, and carets stepped aside.
			expect(total.tags).toBeGreaterThan(frames);
			expect(total.moved).toBeGreaterThan(30);
		},
		60_000,
	); // two full loops of the scene: seconds on a slow CI runner

	it("never collide with the visitor's caret, wherever the pointer is", () => {
		const scene = createScene(150, 51);
		const buffers = [
			new Uint8Array(150 * 51),
			new Float32Array(150 * 51),
			new Uint8Array(150 * 51),
		] as const;
		let step = 0;
		while (scene.cycles < 2) {
			advance(scene, 1 / 10);
			// Sweep the pointer over the whole display, and park it on each caret in turn.
			const peer = scene.peers[step % 3];
			scene.you =
				step % 2 === 0 || !peer
					? { x: (step * 37) % 150, y: (step * 11) % 51 }
					: { x: caretX(scene, peer.col), y: lineTop(scene, peer.line) + 10 };
			check(scene, ...buffers);
			step += 1;
		}
		expect(step).toBeGreaterThan(200);
	});
});

describe("generated SVG", () => {
	it("draws dots as classes on the page and as attributes in a file, never inline styles", () => {
		const inline = dotsSvg(MARK, { className: "mark" });
		expect(inline).toContain('class="dots mark"');
		expect(inline).toContain('class="dots__red"');
		const file = dotsSvg(MARK, { colors: { on: "#fff", red: "#f00" }, title: "ArcaSync" });
		expect(file).toContain('xmlns="http://www.w3.org/2000/svg"');
		expect(file).toContain('stroke="#f00"');
		for (const svg of [inline, file, sceneSvg(150, 51, false, "wide")]) {
			expect(svg).not.toMatch(/style=|<style/);
		}
	});

	it("renders the still frame for wide and narrow screens", () => {
		const wide = sceneSvg(240, 51, false, "wide");
		const narrow = sceneSvg(160, 51, true, "narrow");
		expect(wide).toContain('viewBox="0 0 2400 510"');
		expect(wide).toContain("still__red");
		expect(narrow.length).toBeLessThan(wide.length);
	});
});
