import { describe, expect, it } from "vitest";
import { chunkFile, sha256Hex } from "../hash.js";
import { kindForPath, isIgnoredPath } from "../fileKinds.js";

describe("hash", () => {
	it("sha256 of empty string", async () => {
		expect(await sha256Hex("")).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
	});
	it("chunks by size and handles empty", async () => {
		const data = new Uint8Array(10);
		const chunks = await chunkFile(data, 4);
		expect(chunks.map((c) => c.size)).toEqual([4, 4, 2]);
		expect(await chunkFile(new Uint8Array(0))).toHaveLength(1);
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
