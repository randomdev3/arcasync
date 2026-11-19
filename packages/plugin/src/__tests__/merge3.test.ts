import { describe, expect, it } from "vitest";
import { merge3 } from "../doc/merge3";

/** mulberry32: a small seeded PRNG, so a failing case can be replayed. */
function rng(seed: number) {
	let a = seed >>> 0;
	const next = () => {
		a = (a + 0x6d2b79f5) >>> 0;
		let t = a;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
	const int = (n: number) => Math.floor(next() * n);
	const word = () => {
		let w = "";
		for (let i = 3 + int(6); i > 0; i--) w += String.fromCharCode(97 + int(26));
		return w;
	};
	const line = (tag: string) => `${tag} ${word()} ${word()} ${word()}`;
	return { int, word, line };
}

describe("merge3", () => {
	it("merges disjoint line edits", () => {
		expect(merge3("A\nB\nC\n", "A1\nB\nC\n", "A\nB\nC3\n")).toEqual({
			ok: true,
			text: "A1\nB\nC3\n",
		});
	});

	it("takes the other side when one side did not change", () => {
		expect(merge3("a\n", "a\n", "b\n")).toEqual({ ok: true, text: "b\n" });
		expect(merge3("a\n", "b\n", "a\n")).toEqual({ ok: true, text: "b\n" });
		expect(merge3("a\n", "b\n", "b\n")).toEqual({ ok: true, text: "b\n" });
	});

	it("merges an insert at the start with an append at the end", () => {
		const base = "first line\nmiddle line\nlast line\n";
		expect(merge3(base, `title\n${base}`, `${base}appended\n`)).toEqual({
			ok: true,
			text: `title\n${base}appended\n`,
		});
	});

	it("finds a patch far from where the base had it", () => {
		const r = rng(7);
		const lines = Array.from({ length: 100 }, (_, i) => r.line(`l${i}`));
		const base = `${lines.join("\n")}\n`;
		const prefix = `${Array.from({ length: 30 }, (_, i) => r.line(`p${i}`)).join("\n")}\n`;
		expect(prefix.length).toBeGreaterThan(500);
		const ours = base.replace(lines[99] as string, "the last line, edited");
		const theirs = prefix + base;
		expect(merge3(base, ours, theirs)).toEqual({ ok: true, text: prefix + ours });
	});

	it("refuses the same line edited differently", () => {
		expect(merge3("A\nB\nC\n", "A\nB-ours\nC\n", "A\nB-theirs\nC\n")).toEqual({ ok: false });
	});

	it("refuses a deleted paragraph against an edit inside it", () => {
		const base =
			"Intro line.\n\nThis paragraph goes away in one version and is edited in the other.\n\nOutro.\n";
		const ours = "Intro line.\n\nOutro.\n";
		const theirs =
			"Intro line.\n\nThis paragraph goes away in one version and is CHANGED in the other.\n\nOutro.\n";
		expect(merge3(base, ours, theirs)).toEqual({ ok: false });
	});

	it("normalises CRLF input to LF", () => {
		expect(merge3("A\r\nB\r\nC\r\n", "A1\r\nB\r\nC\r\n", "A\nB\nC3\n")).toEqual({
			ok: true,
			text: "A1\nB\nC3\n",
		});
	});

	it("merges 200 random edits of disjoint line ranges", () => {
		for (let seed = 1; seed <= 200; seed++) {
			const r = rng(seed);
			const n = 20 + r.int(30);
			const base = Array.from({ length: n }, (_, i) => r.line(`L${i}`));
			// Two ranges [s, e) with at least one untouched line between them; either may be empty
			// (a pure insert) and either may be replaced by nothing (a delete).
			const s1 = r.int(n - 2);
			const e1 = s1 + r.int(Math.min(4, n - 2 - s1));
			const s2 = e1 + 1 + r.int(n - e1 - 1);
			const e2 = s2 + r.int(Math.min(4, n - s2) + 1);
			const repl = (tag: string) =>
				Array.from({ length: r.int(4) }, (_, i) => r.line(`${tag}${i}`));
			const ours = repl("O");
			const theirs = repl("T");
			const withOurs = [...base.slice(0, s1), ...ours, ...base.slice(e1)];
			const withTheirs = [...base.slice(0, s2), ...theirs, ...base.slice(e2)];
			const expected = [
				...base.slice(0, s1),
				...ours,
				...base.slice(e1, s2),
				...theirs,
				...base.slice(e2),
			];
			const text = (lines: string[]) => `${lines.join("\n")}\n`;
			const result = merge3(text(base), text(withOurs), text(withTheirs));
			expect(result, `seed ${seed}`).toEqual({ ok: true, text: text(expected) });
			expect(merge3(text(base), text(withTheirs), text(withOurs)), `seed ${seed} swapped`).toEqual(
				result,
			);
		}
	});

	it("never drops either side's insert in 200 random overlapping edits", () => {
		let merged = 0;
		for (let seed = 1; seed <= 200; seed++) {
			const r = rng(1000 + seed);
			const base = `${Array.from({ length: 6 }, (_, i) => r.line(`L${i}`)).join("\n")}\n`;
			// An insert of `marker` at `at` and, every other time, a delete of up to 12 chars near it
			// (never around its own insert, but possibly around the other side's).
			const edit = (text: string, marker: string, at: number) => {
				const pos = Math.max(0, Math.min(text.length, at));
				if (r.int(2) === 0) return text.slice(0, pos) + marker + text.slice(pos);
				const from = Math.max(0, Math.min(text.length, pos + r.int(21) - 10));
				const to = Math.min(text.length, from + 1 + r.int(12));
				if (pos > from && pos < to) return text.slice(0, from) + marker + text.slice(to);
				const kept = text.slice(0, from) + text.slice(to);
				const p = pos >= to ? pos - (to - from) : pos;
				return kept.slice(0, p) + marker + kept.slice(p);
			};
			const at = r.int(base.length);
			const ours = edit(base, "[[ours]]", at);
			const theirs = edit(base, "[[theirs]]", Math.max(0, at + r.int(21) - 10));
			const result = merge3(base, ours, theirs);
			if (!result.ok) continue;
			merged++;
			expect(result.text, `seed ${seed}`).toContain("[[ours]]");
			expect(result.text, `seed ${seed}`).toContain("[[theirs]]");
		}
		// Most overlapping pairs still merge (the inserts sit at different points).
		expect(merged).toBeGreaterThan(0);
	});
});
