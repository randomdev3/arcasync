import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// Obsidian's community-plugin bot and BRAT read manifest.json (and versions.json) from the
// repository root, so the root copies must match the plugin's own files.
const root = join(__dirname, "..", "..", "..", "..");
const plugin = join(__dirname, "..", "..");
const read = (dir: string, file: string) => JSON.parse(readFileSync(join(dir, file), "utf8"));

describe("root release manifests", () => {
	for (const file of ["manifest.json", "versions.json"]) {
		it(`${file} at the repo root matches packages/plugin/${file}`, () => {
			expect(read(root, file)).toEqual(read(plugin, file));
		});
	}
});
