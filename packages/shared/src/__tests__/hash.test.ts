import { describe, expect, it } from "vitest";
import { isIgnoredPath, kindForPath } from "../fileKinds.js";
import { chunkFile, fileHash, sha256Hex } from "../hash.js";

describe("hash", () => {
	it("sha256 of empty string", async () => {
		expect(await sha256Hex("")).toBe(
			"e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
		);
	});
	it("chunks by size and handles empty", async () => {
		const data = new Uint8Array(10);
		const chunks = await chunkFile(data, 4);
		expect(chunks.map((c) => c.size)).toEqual([4, 4, 2]);
		expect(await chunkFile(new Uint8Array(0))).toHaveLength(1);
	});
	it("fileHash is stable and order-sensitive", async () => {
		const a = "a".repeat(64);
		const b = "b".repeat(64);
		expect(await fileHash([a, b])).toBe(await fileHash([a, b]));
		expect(await fileHash([a, b])).toBe(await sha256Hex(`${a},${b}`));
		expect(await fileHash([a, b])).not.toBe(await fileHash([b, a]));
		expect(await fileHash([a])).not.toBe(await fileHash([a, a]));
	});
});

describe("fileKinds", () => {
	it("classifies paths", () => {
		expect(kindForPath("a/b.md")).toBe("md");
		expect(kindForPath("a/Board.excalidraw.md")).toBe("xd");
		expect(kindForPath("x.canvas")).toBe("canvas");
		expect(kindForPath("x.base")).toBe("base");
		expect(kindForPath(".obsidian/app.json")).toBe("config");
		expect(kindForPath("img.PNG")).toBe("binary");
		expect(isIgnoredPath(".trash/x.md")).toBe(true);
		expect(isIgnoredPath(".obsidian/app.json")).toBe(false);
	});
});
