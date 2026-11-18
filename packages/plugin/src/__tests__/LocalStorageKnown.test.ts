import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import { IndexStore } from "../workspace/IndexStore";
import { LocalStorageKnown } from "../workspace/LocalFiles";
import { Reconciler } from "../workspace/Reconciler";
import { FakeFiles } from "./indexHarness";

const KEY = "teamsync:vault:ws:known";

beforeEach(() => {
	const data = new Map<string, string>();
	vi.stubGlobal("window", {
		localStorage: {
			getItem: (k: string) => data.get(k) ?? null,
			setItem: (k: string, v: string) => data.set(k, v),
		},
	});
});
afterEach(() => vi.unstubAllGlobals());

describe("LocalStorageKnown", () => {
	it("round-trips the record for the same root", () => {
		new LocalStorageKnown(KEY, "Shared").save({ "a.md": "A" });
		expect(new LocalStorageKnown(KEY, "Shared").load()).toEqual({ "a.md": "A" });
	});

	it("loads empty for another root, so remapping the folder deletes nothing", async () => {
		new LocalStorageKnown(KEY, "Shared").save({ "a.md": "A", "b.md": "B" });

		const doc = new Y.Doc();
		const index = new IndexStore(doc);
		for (const [path, id] of [
			["a.md", "A"],
			["b.md", "B"],
		] as const) {
			index.set(path, { id, kind: "md", updatedBy: "u", updatedAt: 1 });
		}
		const files = new FakeFiles();
		const reconciler = new Reconciler({
			index,
			files,
			known: new LocalStorageKnown(KEY, "Team"),
			userId: "u",
			isSynced: () => true,
			isAcked: () => true,
		});
		await reconciler.run();
		expect(index.entries().map((e) => e.path)).toEqual(["a.md", "b.md"]);
		expect(files.ops).toEqual(["create a.md", "create b.md"]);
	});

	it("treats an unreadable record as empty", () => {
		window.localStorage.setItem(KEY, "{not json");
		expect(new LocalStorageKnown(KEY, "Shared").load()).toEqual({});
	});
});
