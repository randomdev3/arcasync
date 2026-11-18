import "fake-indexeddb/auto";
import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { decide, enrollmentUpdate, isEnrolled, type ReconcileInput } from "../doc/enroll";
import { device, FakeDisk, FakeRelay, noteName, sleep, waitUntil } from "./helpers/noteFakes";

const PATH = "Shared/n.md";
const COPY = "Shared/n (local copy dev 202611180930).md";

/** Another device's enrollment of `text`, already on the server. */
function serverHas(relay: FakeRelay, fileId: string, text: string) {
	relay.remoteEdit(noteName(fileId), (doc) => {
		Y.applyUpdate(doc, enrollmentUpdate(text));
	});
}

function remoteReplace(relay: FakeRelay, fileId: string, text: string) {
	relay.remoteEdit(noteName(fileId), (doc) => {
		const t = doc.getText("contents");
		doc.transact(() => {
			t.delete(0, t.length);
			t.insert(0, text);
		});
	});
}

/** Opens the note on a device, waits for the first reconcile, releases it. */
async function openOnce(d: ReturnType<typeof device>, fileId: string) {
	d.paths[fileId] = PATH;
	const note = await d.docs.acquire(fileId, PATH);
	await note.whenReady();
	const text = note.ytext.toString();
	const enrolled = isEnrolled(note.ydoc);
	d.docs.release(note);
	return { note, text, enrolled };
}

/** A device that synced `text` for the note before (disk and IndexedDB agree), then quit. */
async function syncedBefore(relay: FakeRelay, fileId: string, text: string, name = "dev") {
	const disk = new FakeDisk({ [PATH]: text });
	const first = device({ relay, disk, name });
	const { text: docText } = await openOnce(first, fileId);
	expect(docText).toBe(text);
	await waitUntil(() => relay.text(noteName(fileId)) === text);
	first.docs.destroy();
	return { disk, vaultId: first.vaultId };
}

let seq = 0;
const newId = () => `note${++seq}x${Date.now().toString(36)}`;

describe("decide", () => {
	const base: ReconcileInput = {
		disk: "a",
		doc: "a",
		enrolled: true,
		diskHash: "ha",
		docHash: "ha",
		lastSyncedHash: "ha",
		canEnroll: true,
		writable: true,
	};
	it.each<[string, Partial<ReconcileInput>, string]>([
		["missing file", { disk: null, diskHash: null }, "missing"],
		["empty/empty", { disk: "", doc: "", enrolled: false, lastSyncedHash: undefined }, "in-sync"],
		["disk-only, synced", { doc: "", enrolled: false, docHash: "h0" }, "enroll"],
		["disk-only, not synced", { doc: "", enrolled: false, canEnroll: false }, "defer"],
		["doc-only", { disk: "", diskHash: "h0", doc: "b", docHash: "hb" }, "write-doc"],
		["equal", {}, "in-sync"],
		["differ + untouched", { doc: "b", docHash: "hb" }, "write-doc"],
		[
			"differ + touched, doc moved",
			{ disk: "c", diskHash: "hc", doc: "b", docHash: "hb" },
			"conflict",
		],
		["differ + touched, doc at last sync", { disk: "c", diskHash: "hc" }, "apply-disk"],
		["differ + touched, viewer", { disk: "c", diskHash: "hc", writable: false }, "conflict"],
		[
			"differ, never synced here",
			{ disk: "c", diskHash: "hc", lastSyncedHash: undefined },
			"conflict",
		],
		["empty disk never empties the note", { disk: "", diskHash: "h0" }, "write-doc"],
	])("%s", (_label, patch, expected) => {
		expect(decide({ ...base, ...patch })).toBe(expected);
	});
});

describe("enrollment and reconcile on open (fake-indexeddb)", () => {
	it("empty/empty: nothing is enrolled or written", async () => {
		const relay = new FakeRelay();
		const d = device({ relay, disk: new FakeDisk({ [PATH]: "" }), name: "dev" });
		const fileId = newId();
		const r = await openOnce(d, fileId);
		expect(r).toMatchObject({ text: "", enrolled: false });
		expect(d.disk.files.get(PATH)).toBe("");
		expect(d.disk.writes).toBe(0);
	});

	it("disk-only: the disk text is enrolled once and the disk is untouched", async () => {
		const relay = new FakeRelay();
		const d = device({ relay, disk: new FakeDisk({ [PATH]: "Seed text\n" }), name: "dev" });
		const fileId = newId();
		const r = await openOnce(d, fileId);
		expect(r).toMatchObject({ text: "Seed text\n", enrolled: true });
		await waitUntil(() => relay.text(noteName(fileId)) === "Seed text\n");
		expect(d.disk.writes).toBe(0);
		// Reopening (warm or after a relaunch) never enrolls again.
		expect((await openOnce(d, fileId)).text).toBe("Seed text\n");
		d.docs.destroy();
		const again = device({ relay, disk: d.disk, vaultId: d.vaultId, name: "dev" });
		expect((await openOnce(again, fileId)).text).toBe("Seed text\n");
		expect(relay.text(noteName(fileId))).toBe("Seed text\n");
	});

	it("disk-only with a CRLF + BOM file enrolls the LF text", async () => {
		const relay = new FakeRelay();
		const d = device({ relay, disk: new FakeDisk({ [PATH]: "﻿a\r\nb\r\n" }), name: "dev" });
		expect((await openOnce(d, newId())).text).toBe("a\nb\n");
	});

	it("doc-only: the doc is written to the (empty) file and registered as a self-write", async () => {
		const relay = new FakeRelay();
		const fileId = newId();
		serverHas(relay, fileId, "Hello\n");
		const d = device({ relay, disk: new FakeDisk({ [PATH]: "" }), name: "dev" });
		const r = await openOnce(d, fileId);
		expect(r.text).toBe("Hello\n");
		expect(d.disk.files.get(PATH)).toBe("Hello\n");
		expect(d.selfWrites.consume(PATH, "modify")).toBe(true);
	});

	it("equal: nothing is written", async () => {
		const relay = new FakeRelay();
		const fileId = newId();
		serverHas(relay, fileId, "same\n");
		const d = device({ relay, disk: new FakeDisk({ [PATH]: "same\n" }), name: "dev" });
		expect((await openOnce(d, fileId)).text).toBe("same\n");
		expect(d.disk.writes).toBe(0);
		expect(d.selfWrites.size).toBe(0);
	});

	it("differ + untouched: the newer doc replaces the disk, no local copy", async () => {
		const relay = new FakeRelay();
		const fileId = newId();
		const { disk, vaultId } = await syncedBefore(relay, fileId, "v1\n");
		remoteReplace(relay, fileId, "v2\n");
		const d = device({ relay, disk, vaultId, name: "dev" });
		expect((await openOnce(d, fileId)).text).toBe("v2\n");
		expect(disk.files.get(PATH)).toBe("v2\n");
		expect([...disk.files.keys()]).toEqual([PATH]);
		expect(d.notices).toEqual([]);
	});

	it("differ + touched while the doc moved: doc wins on disk, disk text saved in a local copy", async () => {
		const relay = new FakeRelay();
		const fileId = newId();
		const { disk, vaultId } = await syncedBefore(relay, fileId, "line3\n");
		remoteReplace(relay, fileId, "A-wins\n");
		disk.files.set(PATH, "B-offline\n");
		const d = device({ relay, disk, vaultId, name: "dev" });
		expect((await openOnce(d, fileId)).text).toBe("A-wins\n");
		expect(disk.files.get(PATH)).toBe("A-wins\n");
		expect(disk.files.get(COPY)).toBe("B-offline\n");
		expect(disk.files.size).toBe(2);
		expect(d.notices).toHaveLength(1);
		expect(relay.text(noteName(fileId))).toBe("A-wins\n");
		// The next open is quiet: no second copy.
		await openOnce(d, fileId);
		expect(disk.files.size).toBe(2);
	});

	it("differ + touched while the doc did not move: the disk edit goes into the doc", async () => {
		const relay = new FakeRelay();
		const fileId = newId();
		const { disk, vaultId } = await syncedBefore(relay, fileId, "v1\n");
		disk.files.set(PATH, "v1 edited offline\n");
		const d = device({ relay, disk, vaultId, name: "dev" });
		expect((await openOnce(d, fileId)).text).toBe("v1 edited offline\n");
		await waitUntil(() => relay.text(noteName(fileId)) === "v1 edited offline\n");
		expect(disk.files.size).toBe(1);
		expect(d.disk.writes).toBe(0);
	});

	it("waits for the server before deciding: a connecting socket is not offline", async () => {
		const relay = new FakeRelay();
		const fileId = newId();
		const { disk, vaultId } = await syncedBefore(relay, fileId, "line3\n");
		remoteReplace(relay, fileId, "A-wins\n");
		disk.files.set(PATH, "B-offline\n");
		relay.online = false; // attach stays unsynced, but the status is not "offline" yet
		const isOffline = relay.isOffline;
		relay.isOffline = () => false;
		const d = device({ relay, disk, vaultId, name: "dev" });
		d.paths[fileId] = PATH;
		const note = await d.docs.acquire(fileId, PATH);
		let ready = false;
		void note.whenReady().then(() => {
			ready = true;
		});
		await sleep(30);
		expect(ready).toBe(false);
		expect(note.ytext.toString()).toBe("line3\n");
		expect(disk.files.get(PATH)).toBe("B-offline\n");
		relay.isOffline = isOffline;
		relay.setOnline(true);
		await note.whenReady();
		expect(disk.files.get(PATH)).toBe("A-wins\n");
		expect(disk.files.get(COPY)).toBe("B-offline\n");
		d.docs.release(note);
	});

	it("offline with local data: reconciles locally but never enrolls", async () => {
		const relay = new FakeRelay();
		const fileId = newId();
		const { disk, vaultId } = await syncedBefore(relay, fileId, "v1\n");
		disk.files.set(PATH, "v1 offline\n");
		relay.setOnline(false);
		const d = device({ relay, disk, vaultId, name: "dev" });
		expect((await openOnce(d, fileId)).text).toBe("v1 offline\n");
		// Meanwhile a peer edits; on reconnect the CRDT merges both edits.
		relay.remoteEdit(noteName(fileId), (doc) => doc.getText("contents").insert(0, "peer "));
		relay.setOnline(true);
		await waitUntil(() => relay.text(noteName(fileId)) === "peer v1 offline\n");
	});

	it("offline without local data: does not become ready and never writes the empty doc", async () => {
		const relay = new FakeRelay();
		relay.setOnline(false);
		const d = device({ relay, disk: new FakeDisk({ [PATH]: "only on disk\n" }), name: "dev" });
		const fileId = newId();
		d.paths[fileId] = PATH;
		const note = await d.docs.acquire(fileId, PATH);
		let ready = false;
		void note.whenReady().then(() => {
			ready = true;
		});
		await sleep(30);
		expect(ready).toBe(false);
		expect(d.disk.files.get(PATH)).toBe("only on disk\n");
		relay.setOnline(true);
		await note.whenReady();
		expect(note.ytext.toString()).toBe("only on disk\n");
		d.docs.release(note);
	});

	it("a viewer never enrolls and never overwrites disk text it cannot sync", async () => {
		const relay = new FakeRelay();
		const fileId = newId();
		const d = device({ relay, disk: new FakeDisk({ [PATH]: "viewer text\n" }), readonly: true });
		const r = await openOnce(d, fileId);
		expect(r).toMatchObject({ text: "", enrolled: false });
		expect(d.disk.files.get(PATH)).toBe("viewer text\n");
		expect(relay.text(noteName(fileId))).toBe("");
	});

	it("a viewer's own disk edit is kept as a local copy, not applied", async () => {
		const relay = new FakeRelay();
		const fileId = newId();
		serverHas(relay, fileId, "shared\n");
		const disk = new FakeDisk({ [PATH]: "shared\n" });
		const first = device({ relay, disk, readonly: true, name: "dev" });
		await openOnce(first, fileId);
		first.docs.destroy();
		disk.files.set(PATH, "viewer edit\n");
		const d = device({ relay, disk, vaultId: first.vaultId, readonly: true, name: "dev" });
		expect((await openOnce(d, fileId)).text).toBe("shared\n");
		expect(disk.files.get(PATH)).toBe("shared\n");
		expect(disk.files.get(COPY)).toBe("viewer edit\n");
	});

	it("an edit racing the write is not overwritten (compare-and-swap)", async () => {
		const relay = new FakeRelay();
		const fileId = newId();
		const { disk, vaultId } = await syncedBefore(relay, fileId, "v1\n");
		remoteReplace(relay, fileId, "v2\n");
		let raced = false;
		disk.beforeProcess = (path) => {
			if (raced) return;
			raced = true;
			disk.files.set(path, "user typed meanwhile\n");
		};
		const d = device({ relay, disk, vaultId, name: "dev" });
		await openOnce(d, fileId);
		// The racing text survives: either in the file or in a local copy.
		const all = [...disk.files.values()];
		expect(all).toContain("user typed meanwhile\n");
		expect(disk.files.get(PATH)).toBe("v2\n");
	});
});

describe("concurrent enrollment of one note on two devices", () => {
	it("the same disk text lands in the CRDT exactly once", () => {
		const a = new Y.Doc();
		const b = new Y.Doc();
		Y.applyUpdate(a, enrollmentUpdate("Seed text\n"));
		Y.applyUpdate(b, enrollmentUpdate("Seed text\n"));
		Y.applyUpdate(a, Y.encodeStateAsUpdate(b));
		Y.applyUpdate(b, Y.encodeStateAsUpdate(a));
		expect(a.getText("contents").toString()).toBe("Seed text\n");
		expect(b.getText("contents").toString()).toBe("Seed text\n");
		expect(Y.encodeStateVector(a)).toEqual(Y.encodeStateVector(b));
		expect(isEnrolled(a)).toBe(true);
	});

	it("different disk texts both survive", () => {
		const a = new Y.Doc();
		const b = new Y.Doc();
		Y.applyUpdate(a, enrollmentUpdate("from A\n"));
		Y.applyUpdate(b, enrollmentUpdate("from B\n"));
		Y.applyUpdate(a, Y.encodeStateAsUpdate(b));
		Y.applyUpdate(b, Y.encodeStateAsUpdate(a));
		const text = a.getText("contents").toString();
		expect(text).toBe(b.getText("contents").toString());
		expect(text).toContain("from A\n");
		expect(text).toContain("from B\n");
	});

	it("two devices opening the same seeded note at once agree on one copy of the text", async () => {
		const relay = new FakeRelay();
		const fileId = newId();
		const a = device({ relay, disk: new FakeDisk({ [PATH]: "Seed text\n" }), name: "a" });
		const b = device({ relay, disk: new FakeDisk({ [PATH]: "Seed text\n" }), name: "b" });
		const [ra, rb] = await Promise.all([openOnce(a, fileId), openOnce(b, fileId)]);
		await sleep(20);
		expect(ra.text).toBe("Seed text\n");
		expect(rb.text).toBe("Seed text\n");
		expect(relay.text(noteName(fileId))).toBe("Seed text\n");
		expect(a.disk.files.get(PATH)).toBe("Seed text\n");
		expect(b.disk.files.get(PATH)).toBe("Seed text\n");
	});
});
