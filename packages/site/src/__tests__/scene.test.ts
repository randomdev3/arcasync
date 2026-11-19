import { describe, expect, it } from "vitest";
import { GLYPH_H, GLYPH_W, GLYPHS, MARK, PICTOS, TAGS, wordRows } from "../matrix/glyphs";
import {
	advance,
	CELL,
	caretX,
	createScene,
	LINES,
	MARGIN_X,
	MIN_COLS,
	MIN_ROWS,
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

	it("draws the visitor's pointer as a fourth caret", () => {
		const scene = stillScene(150, 51);
		const before = frame(scene).level.filter((v) => v > 0).length;
		scene.you = { x: 120, y: 30 };
		expect(frame(scene).level.filter((v) => v > 0).length).toBeGreaterThan(before + 9);
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
