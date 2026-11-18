import { beforeEach, describe, expect, it } from "vitest";
import { clock, Device, exchange, settle, snapshot } from "./indexHarness";

beforeEach(() => {
	clock.t = 1000;
});

/** A device whose index already holds `entries` (as if synced from the relay). */
function device(
	entries: Record<string, string>,
	opts: { disk?: string[]; known?: Record<string, string> },
): Device {
	const d = new Device("me", opts);
	for (const [path, id] of Object.entries(entries)) d.index.set(path, d.meta(id));
	d.writes = 0;
	return d;
}

describe("Reconciler.run", () => {
	it("applies the disk × index × known matrix", async () => {
		const d = device(
			{ "deleted.md": "D", "remote.md": "R", "kept.md": "K" },
			{
				disk: ["new.md", "gone.md", "kept.md"],
				known: { "gone.md": "G", "deleted.md": "D", "kept.md": "K" },
			},
		);
		await d.reconciler.run();

		// disk yes / index no / known no → add; disk yes / index no / known yes → trash;
		// disk no / index yes / known yes → drop from index; disk no / index yes / known no → create.
		expect(snapshot(d)).toEqual({ "new.md": "me1", "remote.md": "R", "kept.md": "K" });
		expect(d.files.ops.sort()).toEqual(["create remote.md", "trash gone.md"]);
		expect(d.files.list()).toEqual(["kept.md", "new.md", "remote.md"]);
		expect(d.known.value).toEqual({ "new.md": "me1", "remote.md": "R", "kept.md": "K" });
		expect(d.reconciler.ready).toBe(true);
	});

	it("does nothing at all before the index has synced", async () => {
		const d = device({}, { disk: ["a.md", "b.md"], known: { "a.md": "A", "b.md": "B" } });
		d.synced = false;
		await d.reconciler.run();
		expect(d.files.ops).toEqual([]);
		expect(d.writes).toBe(0);
		expect(d.known.value).toEqual({ "a.md": "A", "b.md": "B" });
		expect(d.reconciler.ready).toBe(false);
	});

	it("is a fixed point: a second run writes nothing", async () => {
		const d = device({ "r.md": "R" }, { disk: ["l.md"] });
		await d.reconciler.run();
		const writes = d.writes;
		const ops = d.files.ops.length;
		await d.reconciler.run();
		expect(d.writes).toBe(writes);
		expect(d.files.ops).toHaveLength(ops);
	});

	it("follows a remote rename of a known file instead of trash + create", async () => {
		const d = device({ "dir/b.md": "X" }, { disk: ["a.md"], known: { "a.md": "X" } });
		await d.reconciler.run();
		expect(d.files.ops).toEqual(["rename a.md → dir/b.md"]);
		expect(snapshot(d)).toEqual({ "dir/b.md": "X" });
	});

	it("adopts the index id for a file both sides have but this device never synced", async () => {
		const d = device({ "same.md": "S" }, { disk: ["same.md"] });
		await d.reconciler.run();
		expect(d.files.ops).toEqual([]);
		expect(d.writes).toBe(0);
		expect(d.known.value).toEqual({ "same.md": "S" });
	});

	it("resolves a known id displaced from its path by the lower-id rule", async () => {
		// Ours (K) is lower than the index's (Z): we keep the path.
		const keep = device({ "p.md": "Z" }, { disk: ["p.md"], known: { "p.md": "K" } });
		await keep.reconciler.run();
		expect(snapshot(keep)).toEqual({ "p.md": "K" });
		expect(keep.files.ops).toEqual([]);

		// Ours (Z) is higher than the index's (K): we move to `p (2).md` and fetch theirs.
		const yield_ = device({ "p.md": "K" }, { disk: ["p.md"], known: { "p.md": "Z" } });
		await yield_.reconciler.run();
		expect(snapshot(yield_)).toEqual({ "p.md": "K", "p (2).md": "Z" });
		expect(yield_.files.ops).toEqual(["rename p.md → p (2).md", "create p.md"]);
	});

	it("records `known` only once the relay has acked every local change", async () => {
		const d = device({}, { disk: ["n.md"] });
		d.acked = false;
		await d.reconciler.run();
		expect(d.known.value).toEqual({});
		d.acked = true;
		await d.reconciler.checkpoint();
		expect(d.known.value).toEqual({ "n.md": "me1" });
	});
});

describe("Reconciler local events", () => {
	it("are ignored until the first run, then mirrored into the index", async () => {
		const d = device({}, { disk: ["a.md"] });
		await d.reconciler.localCreate("a.md");
		expect(d.writes).toBe(0);

		await d.reconciler.run();
		const id = d.index.get("a.md")?.id;
		d.files.files.add("b.md");
		await d.reconciler.localCreate("b.md");
		expect(d.index.has("b.md")).toBe(true);

		d.files.files.delete("a.md");
		d.files.files.add("x/a2.md");
		await d.reconciler.localRename("a.md", "x/a2.md");
		expect(d.index.get("x/a2.md")?.id).toBe(id);
		expect(d.index.has("a.md")).toBe(false);

		d.files.files.delete("b.md");
		await d.reconciler.localDelete("b.md");
		expect(snapshot(d)).toEqual({ "x/a2.md": id });
		expect(d.files.ops).toEqual([]);
	});
});

describe("Reconciler remote apply", () => {
	it("mirrors remote creates, renames and deletes onto disk without echoing", async () => {
		const a = new Device("a");
		const b = new Device("b");
		await a.reconciler.run();
		await b.reconciler.run();

		a.files.files.add("n.md");
		await a.reconciler.localCreate("n.md");
		await settle([a, b]);
		expect(b.files.ops).toEqual(["create n.md"]);

		a.files.files.delete("n.md");
		a.files.files.add("sub/m.md");
		await a.reconciler.localRename("n.md", "sub/m.md");
		await settle([a, b]);
		expect(b.files.ops).toEqual(["create n.md", "rename n.md → sub/m.md"]);

		const writes = a.writes + b.writes;
		a.files.files.delete("sub/m.md");
		await a.reconciler.localDelete("sub/m.md");
		await settle([a, b]);
		expect(b.files.ops.at(-1)).toBe("trash sub/m.md");
		expect(b.files.list()).toEqual([]);
		// One write (a's delete); b only applies.
		expect(a.writes + b.writes).toBe(writes + 1);
	});

	it("defers a delete seen while the index is unsynced to the next run", async () => {
		const a = new Device("a");
		const b = new Device("b");
		await a.reconciler.run();
		await b.reconciler.run();
		a.files.files.add("d.md");
		await a.reconciler.localCreate("d.md");
		await settle([a, b]);
		expect(b.known.value).toEqual({ "d.md": "a1" });

		a.files.files.delete("d.md");
		await a.reconciler.localDelete("d.md");
		b.synced = false;
		exchange(a, b);
		await b.idle();
		expect(b.files.list()).toEqual(["d.md"]);

		b.synced = true;
		await b.reconciler.run();
		expect(b.files.ops.at(-1)).toBe("trash d.md");
	});
});
