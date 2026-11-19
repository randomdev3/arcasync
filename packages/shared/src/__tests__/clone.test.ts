import { describe, expect, it } from "vitest";
import { decodeClone, encodeClone } from "../clone.js";

describe("clone framing", () => {
	it("round-trips an empty list", () => {
		expect(decodeClone(encodeClone([], []))).toEqual({ entries: [], remaining: [] });
	});

	it("round-trips entries and remaining docs", () => {
		const entries = [
			{ doc: "ws1/note-a", update: new Uint8Array([1, 2, 3]) },
			{ doc: "ws1/note-b", update: new Uint8Array(0) },
		];
		const out = decodeClone(encodeClone(entries, ["ws1/note-c", "ws1/ünï"]));
		expect(out.entries).toEqual(entries);
		expect(out.remaining).toEqual(["ws1/note-c", "ws1/ünï"]);
	});

	it("round-trips a 3 MiB update", () => {
		const update = new Uint8Array(3 * 1024 * 1024);
		for (let i = 0; i < update.length; i++) update[i] = (i * 31) & 0xff;
		const out = decodeClone(encodeClone([{ doc: "big", update }], []));
		expect(out.entries).toHaveLength(1);
		expect(out.entries[0]?.doc).toBe("big");
		const got = out.entries[0]?.update ?? new Uint8Array(0);
		expect(got.length).toBe(update.length);
		expect(got.every((b, i) => b === update[i])).toBe(true);
	});

	it("rejects trailing bytes", () => {
		const bytes = encodeClone([], []);
		expect(() => decodeClone(new Uint8Array([...bytes, 0]))).toThrow();
	});
});
