import "fake-indexeddb/auto";
import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { BackgroundSync } from "../doc/BackgroundSync";
import { textHash } from "../doc/diskText";
import { FilesMapIndex } from "../doc/noteIndex";
import { device, FakeDisk, FakeRelay, waitUntil } from "./helpers/noteFakes";

const PATH = "Shared/closed-note/seed.md";
const KEY = "closed-note/seed.md";

/** Two index docs kept in sync directly, standing in for the index provider. */
function linkedIndexes() {
	const a = new Y.Doc();
	const b = new Y.Doc();
	a.on("update", (u: Uint8Array, origin: unknown) => {
		if (origin !== "link") Y.applyUpdate(b, u, "link");
	});
	b.on("update", (u: Uint8Array, origin: unknown) => {
		if (origin !== "link") Y.applyUpdate(a, u, "link");
	});
	return [a, b] as const;
}

function vault(relay: FakeRelay, indexDoc: Y.Doc, disk: FakeDisk, name: string, vaultId?: string) {
	const revs = indexDoc.getMap<unknown>("docRevs");
	const index = new FilesMapIndex(indexDoc.getMap<unknown>("files"), "Shared");
	const d = device({
		relay,
		disk,
		name,
		revs,
		vaultId,
		pathOf: (id) => index.pathOf(id),
		revThrottleMs: 50,
	});
	const bg = new BackgroundSync({
		docs: d.docs,
		revTracker: d.revTracker,
		revs,
		index,
		readDisk: (p) => d.writer.read(p),
		concurrency: 3,
		isOnline: () => relay.online,
	});
	bg.start();
	bg.catchUp();
	return { ...d, bg, index };
}

describe("BackgroundSync: closed notes converge through docRevs", () => {
	it("enrolls a local note once, catches up a closed copy, and keeps offline divergence", async () => {
		const relay = new FakeRelay();
		const [ia, ib] = linkedIndexes();
		const alice = vault(relay, ia, new FakeDisk({ [PATH]: "Seed text\n" }), "alice");
		const bobDisk = new FakeDisk({ [PATH]: "" });
		let bob = vault(relay, ib, bobDisk, "bob");

		// Lane A's Reconciler would add alice's file to the index.
		ia.getMap("files").set(KEY, { id: "seed1", kind: "md", updatedBy: "alice", updatedAt: 1 });
		await waitUntil(() => bobDisk.files.get(PATH) === "Seed text\n");
		await alice.bg.idle();
		expect(alice.disk.files.get(PATH)).toBe("Seed text\n");
		expect(relay.text("ws:ws1:md:seed1")).toBe("Seed text\n");

		// A closed-note edit on alice reaches bob's disk.
		alice.disk.files.set(PATH, "Seed text\nline2\n");
		await alice.bg.onDiskModify("seed1");
		await waitUntil(() => bobDisk.files.get(PATH) === "Seed text\nline2\n");

		// bob is away while alice edits; bob catches up on start.
		await bob.bg.idle();
		bob.bg.dispose();
		bob.docs.destroy();
		alice.disk.files.set(PATH, "Seed text\nline2\nline3\n");
		await alice.bg.onDiskModify("seed1");
		await waitUntil(() => relay.text("ws:ws1:md:seed1") === "Seed text\nline2\nline3\n");
		await waitUntil(() => alice.revTracker.dirty().length === 0, 7000);
		bob = vault(relay, ib, bobDisk, "bob", bob.vaultId);
		await waitUntil(() => bobDisk.files.get(PATH) === "Seed text\nline2\nline3\n", 7000);

		// Divergence: both change it while bob is away.
		await bob.bg.idle();
		bob.bg.dispose();
		bob.docs.destroy();
		alice.disk.files.set(PATH, "A-wins\n");
		await alice.bg.onDiskModify("seed1");
		await waitUntil(() => relay.text("ws:ws1:md:seed1") === "A-wins\n");
		await waitUntil(() => alice.revTracker.dirty().length === 0, 7000);
		bobDisk.files.set(PATH, "B-offline\n");
		bob = vault(relay, ib, bobDisk, "bob", bob.vaultId);
		await waitUntil(() => bobDisk.files.get(PATH) === "A-wins\n", 7000);
		await bob.bg.idle();
		const copies = [...bobDisk.files.keys()].filter((p) => p.includes("(local copy"));
		expect(copies).toHaveLength(1);
		expect(bobDisk.files.get(copies[0] as string)).toBe("B-offline\n");
		expect(relay.text("ws:ws1:md:seed1")).toBe("A-wins\n");
	}, 30_000);

	it("does not re-attach known notes on every catch-up", async () => {
		const relay = new FakeRelay();
		const [ia] = linkedIndexes();
		const a = vault(relay, ia, new FakeDisk({ [PATH]: "text\n" }), "a");
		ia.getMap("files").set(KEY, { id: "k1", kind: "md", updatedBy: "a", updatedAt: 1 });
		await waitUntil(() => relay.text("ws:ws1:md:k1") === "text\n");
		await a.bg.idle();
		await waitUntil(() => a.revTracker.rev("k1") !== null);
		const attaches = relay.frames.attaches;
		a.bg.catchUp();
		await a.bg.idle();
		expect(relay.frames.attaches).toBe(attaches);
	});

	it("does not mark a warm note caught up before it has re-synced after a reconnect", async () => {
		const relay = new FakeRelay();
		const [ia, ib] = linkedIndexes();
		const alice = vault(relay, ia, new FakeDisk({ [PATH]: "v1\n" }), "alice");
		const bobDisk = new FakeDisk({ [PATH]: "" });
		const bob = vault(relay, ib, bobDisk, "bob");
		ia.getMap("files").set(KEY, { id: "w1", kind: "md", updatedBy: "alice", updatedAt: 1 });
		await waitUntil(() => bobDisk.files.get(PATH) === "v1\n");
		await bob.bg.idle();
		const warm = await bob.docs.peek("w1");
		expect(warm).not.toBeNull();
		// bob's socket came back but the note's handshake has not finished yet.
		const provider = warm?.provider as unknown as { synced: boolean };
		provider.synced = false;
		relay.remoteEdit("ws:ws1:md:w1", (doc) => doc.getText("contents").insert(3, "v2\n"));
		const rev = { at: 42, by: "alice" };
		ib.getMap("docRevs").set("w1", rev);
		bob.bg.catchUp();
		await new Promise((r) => setTimeout(r, 50));
		expect(bob.revTracker.syncedRev("w1")).not.toEqual(rev);
		expect(bobDisk.files.get(PATH)).toBe("v1\n");
		relay.setOnline(true); // finishes the handshake
		await waitUntil(() => bobDisk.files.get(PATH) === "v1\nv2\n");
		await waitUntil(() => JSON.stringify(bob.revTracker.syncedRev("w1")) === JSON.stringify(rev));
		alice.bg.dispose();
	});

	it("an editor save records that disk and doc agree", async () => {
		const relay = new FakeRelay();
		const [ia] = linkedIndexes();
		const a = vault(relay, ia, new FakeDisk({ [PATH]: "start\n" }), "a");
		ia.getMap("files").set(KEY, { id: "e1", kind: "md", updatedBy: "a", updatedAt: 1 });
		await waitUntil(() => relay.text("ws:ws1:md:e1") === "start\n");
		await a.bg.idle();
		const note = await a.docs.acquire("e1", PATH);
		note.editorBound = true;
		note.ytext.insert(6, "typed\n");
		a.disk.files.set(PATH, "start\ntyped\n"); // Obsidian saved the buffer
		await a.bg.onDiskModify("e1");
		expect(await note.getLastSyncedHash()).toBe(await textHash("start\ntyped\n"));
		a.docs.release(note);
	});
});
