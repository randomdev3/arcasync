import { beforeEach, describe, expect, it } from "vitest";
import type { IndexDelta } from "../workspace/IndexStore";
import { clock, Device, exchange, settle, snapshot } from "./indexHarness";

function record(d: Device) {
	const seen: { delta: IndexDelta; local: boolean }[] = [];
	d.index.observe((delta, local) => seen.push({ delta, local }));
	return seen;
}

/** Devices whose first reconcile already ran (nothing on disk, empty index). */
async function online(...names: string[]): Promise<Device[]> {
	const devices = names.map((n) => new Device(n));
	for (const d of devices) await d.reconciler.run();
	return devices;
}

beforeEach(() => {
	clock.t = 1000;
});

describe("IndexStore", () => {
	it("skips writes that would not change the stored value", () => {
		const a = new Device("a");
		a.index.set("x.md", a.meta("X"));
		expect(a.writes).toBe(1);
		a.index.set("x.md", a.meta("X"));
		a.index.delete("missing.md");
		expect(a.writes).toBe(1);
		expect(a.index.get("x.md")?.id).toBe("X");
	});

	it("reports adds, meta changes and removals with their old values", () => {
		const a = new Device("a");
		const seen = record(a);
		a.index.set("x.md", a.meta("X"));
		a.index.set("x.md", a.meta("X", { mtime: 5 }));
		a.index.delete("x.md");
		expect(seen.map((s) => s.local)).toEqual([true, true, true]);
		expect(seen[0]?.delta.added).toEqual([{ path: "x.md", meta: a.meta("X") }]);
		expect(seen[1]?.delta.changed[0]?.old.mtime).toBeUndefined();
		expect(seen[1]?.delta.changed[0]?.meta.mtime).toBe(5);
		expect(seen[2]?.delta.removed).toEqual([{ path: "x.md", meta: a.meta("X", { mtime: 5 }) }]);
	});

	it("detects a delete plus an add of the same id as a move, locally and remotely", () => {
		const a = new Device("a");
		const b = new Device("b");
		a.index.set("old.md", a.meta("X"));
		exchange(a, b);
		const local = record(a);
		const remote = record(b);
		a.index.move("old.md", "dir/new.md", a.meta("X"));
		exchange(a, b);
		for (const [seen, isLocal] of [
			[local, true],
			[remote, false],
		] as const) {
			expect(seen).toHaveLength(1);
			expect(seen[0]?.local).toBe(isLocal);
			expect(seen[0]?.delta).toMatchObject({
				added: [],
				removed: [],
				changed: [],
				moved: [{ from: "old.md", to: "dir/new.md", meta: { id: "X" } }],
			});
		}
	});

	it("an unrelated add and delete in one transaction are not a move", () => {
		const a = new Device("a");
		a.index.set("one.md", a.meta("ONE"));
		const seen = record(a);
		a.doc.transact(() => {
			a.index.delete("one.md");
			a.index.set("two.md", a.meta("TWO"));
		});
		expect(seen[0]?.delta.moved).toEqual([]);
		expect(seen[0]?.delta.added.map((e) => e.path)).toEqual(["two.md"]);
		expect(seen[0]?.delta.removed.map((e) => e.path)).toEqual(["one.md"]);
	});

	it("concurrent rename vs meta edit converges to one path per id and goes quiet", async () => {
		const [a, b] = (await online("a", "b")) as [Device, Device];
		await a.reconciler.localCreate("note.md"); // not on disk yet: ignored
		a.files.files.add("note.md");
		await a.reconciler.localCreate("note.md");
		const id = a.index.get("note.md")?.id as string;
		await settle([a, b]);
		expect(b.files.list()).toEqual(["note.md"]);

		// Offline from each other: a renames (later), b edits the old entry's meta (earlier).
		clock.t = 2000;
		a.files.files.delete("note.md");
		a.files.files.add("renamed.md");
		await a.reconciler.localRename("note.md", "renamed.md");
		clock.t = 1500;
		b.index.set("note.md", { ...(b.index.get("note.md") as object), mtime: 7 } as never);

		await settle([a, b]);
		for (const d of [a, b]) {
			expect(snapshot(d), d.name).toEqual({ "renamed.md": id });
			expect(d.files.list(), d.name).toEqual(["renamed.md"]);
		}
		expect(b.files.ops).toContain("rename note.md → renamed.md");
		const writes = a.writes + b.writes;
		await settle([a, b]);
		expect(a.writes + b.writes).toBe(writes);
	});

	it("two ids on one path: the lower id keeps it, the other device moves to name (2)", async () => {
		const [a, b, c] = (await online("a", "b", "c")) as [Device, Device, Device];
		// a and b create shared.md at the same moment; ids "a1" < "b1".
		a.files.files.add("shared.md");
		b.files.files.add("shared.md");
		await a.reconciler.localCreate("shared.md");
		await b.reconciler.localCreate("shared.md");

		const rounds = await settle([a, b, c]);
		for (const d of [a, b, c]) {
			expect(snapshot(d), d.name).toEqual({ "shared.md": "a1", "shared (2).md": "b1" });
			expect(d.files.list(), d.name).toEqual(["shared (2).md", "shared.md"]);
		}
		expect(b.files.ops).toContain("rename shared.md → shared (2).md");
		expect(a.files.ops).not.toContain("rename shared.md → shared (2).md");
		expect(rounds).toBeLessThanOrEqual(4);
	});
});
