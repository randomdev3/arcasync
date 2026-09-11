import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const bundlePath = fileURLToPath(new URL("../../dist/main.js", import.meta.url));

/**
 * Two copies of Yjs in one bundle break `instanceof Item`/`GC` across the
 * boundary, which shows up much later as corrupted documents rather than as a
 * build error. `esbuild.config.mjs` asserts this too; the test keeps the check
 * visible in `pnpm test` after a build.
 */
describe("dist bundle", () => {
	it.skipIf(!existsSync(bundlePath))("contains exactly one copy of yjs", () => {
		const bundle = readFileSync(bundlePath, "utf8");
		// A string literal from `AbstractType.js`: unlike an identifier it
		// survives minification, and it appears once per copy of yjs.
		const marker = "Invalid access: Add Yjs type to a document before reading data.";
		expect(bundle.split(marker).length - 1).toBe(1);
	});

	it.skipIf(!existsSync(bundlePath))("keeps obsidian external", () => {
		const bundle = readFileSync(bundlePath, "utf8");
		expect(bundle).toMatch(/require\("obsidian"\)/);
	});
});
