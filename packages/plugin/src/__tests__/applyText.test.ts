import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { applyText, textOps } from "../doc/applyText";
import { diskText } from "../doc/diskText";

/** mulberry32: small seeded PRNG so failures reproduce. */
function rng(seed: number) {
	let a = seed >>> 0;
	return () => {
		a = (a + 0x6d2b79f5) >>> 0;
		let t = a;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

const ALPHABET = ["a", "b", "c", " ", "\n", "é", "😀", "😁", "👍🏽", "日"];

function randomString(next: () => number, max: number): string {
	const len = Math.floor(next() * max);
	let s = "";
	for (let i = 0; i < len; i++) s += ALPHABET[Math.floor(next() * ALPHABET.length)];
	return s;
}

/** A mutated copy: a few random inserts/deletes/replacements of `base`. */
function mutate(next: () => number, base: string): string {
	let s = base;
	const edits = 1 + Math.floor(next() * 4);
	for (let i = 0; i < edits; i++) {
		const chars = Array.from(s);
		const at = Math.floor(next() * (chars.length + 1));
		const del = Math.floor(next() * 3);
		chars.splice(at, del, ...Array.from(randomString(next, 4)));
		s = chars.join("");
	}
	return s;
}

function textDoc(initial: string) {
	const doc = new Y.Doc();
	const ytext = doc.getText("contents");
	ytext.insert(0, initial);
	return { doc, ytext };
}

describe("applyText", () => {
	it("reaches the target for 500 seeded random pairs without corrupting surrogate pairs", () => {
		const next = rng(42);
		for (let i = 0; i < 500; i++) {
			const from = randomString(next, 40);
			const to = next() < 0.5 ? mutate(next, from) : randomString(next, 40);
			const { ytext } = textDoc(from);
			applyText(ytext, to, "test");
			expect(ytext.toString(), `pair ${i}: ${JSON.stringify([from, to])}`).toBe(to);
		}
	});

	it("turns a single-character insert or delete into one op", () => {
		const { doc, ytext } = textDoc("Hello world\n");
		const deltas: unknown[] = [];
		ytext.observe((e) => deltas.push(e.delta));
		expect(applyText(ytext, "Hello, world\n", "test")).toBe(1);
		expect(deltas).toEqual([[{ retain: 5 }, { insert: "," }]]);
		expect(applyText(ytext, "Hello world\n", "test")).toBe(1);
		expect(deltas[1]).toEqual([{ retain: 5 }, { delete: 1 }]);
		doc.destroy();
	});

	it("does nothing when the text already matches", () => {
		const { doc, ytext } = textDoc("same");
		let updates = 0;
		doc.on("update", () => updates++);
		expect(applyText(ytext, "same", "test")).toBe(0);
		expect(updates).toBe(0);
	});

	it("applies every op in one transaction with the given origin", () => {
		const { doc, ytext } = textDoc("one two three");
		const origins: unknown[] = [];
		doc.on("afterTransaction", (tr: Y.Transaction) => origins.push(tr.origin));
		applyText(ytext, "zero two four", "DISK");
		expect(origins).toEqual(["DISK"]);
		expect(ytext.toString()).toBe("zero two four");
	});

	it("widens ops that would split a surrogate pair", () => {
		// 😀 and 😁 share their high surrogate; a naive diff replaces only the low half.
		const ops = textOps("a😀b", "a😁b");
		expect(ops).toEqual([{ oldStart: 1, oldEnd: 3, newStart: 1, newEnd: 3 }]);
		const { ytext } = textDoc("a😀b");
		applyText(ytext, "a😁b", "test");
		expect(ytext.toString()).toBe("a😁b");
	});
});

describe("diskText", () => {
	it("strips a BOM and normalises CRLF and CR to LF", () => {
		expect(diskText("﻿a\r\nb\rc\n")).toBe("a\nb\nc\n");
		expect(diskText("plain\n")).toBe("plain\n");
	});
});
