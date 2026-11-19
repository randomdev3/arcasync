import { Platform } from "obsidian";
import { afterEach, describe, expect, it } from "vitest";
import { limits } from "../platform";

describe("limits", () => {
	afterEach(() => {
		Platform.isMobile = false;
	});

	it("desktop: 20 warm docs, 3 background jobs, no size limit, 1 MiB merge base", () => {
		Platform.isMobile = false;
		expect(limits()).toEqual({
			warmDocs: 20,
			bgConcurrency: 3,
			maxMdBytes: Number.POSITIVE_INFINITY,
			maxBaseBytes: 1024 * 1024,
		});
	});

	it("mobile: 5 warm docs, 1 background job, notes up to 2 MiB, 256 KiB merge base", () => {
		Platform.isMobile = true;
		expect(limits()).toEqual({
			warmDocs: 5,
			bgConcurrency: 1,
			maxMdBytes: 2 * 1024 * 1024,
			maxBaseBytes: 256 * 1024,
		});
	});

	it("follows Platform.isMobile at call time (emulateMobile reloads the plugin)", () => {
		Platform.isMobile = true;
		expect(limits().warmDocs).toBe(5);
		Platform.isMobile = false;
		expect(limits().warmDocs).toBe(20);
	});
});
