import "fake-indexeddb/auto";
import { describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import { BackgroundSync } from "../doc/BackgroundSync";
import { utf8Bytes } from "../doc/diskText";
import { enrollmentUpdate, isEnrolled } from "../doc/enroll";
import {
	device,
	FakeDisk,
	FakeRelay,
	FilesMapIndex,
	noteName,
	waitUntil,
} from "./helpers/noteFakes";

let seq = 0;
const newId = () => `sz${++seq}x${Date.now().toString(36)}`;
const MAX = 64;
const BIG = `${"x".repeat(MAX)}\n`;

describe("utf8Bytes", () => {
	it("matches TextEncoder for ASCII, 2-, 3- and 4-byte characters and lone surrogates", () => {
		for (const text of ["", "abc", "é", "日本語", "a😀b", "\ud800", "x\udc00y", "😀\ud83d"]) {
			expect(utf8Bytes(text), JSON.stringify(text)).toBe(new TextEncoder().encode(text).length);
		}
	});
});

describe("maxBytes (mobile maxMdBytes)", () => {
	it("a local file over the limit is never attached, enrolled or written; one warning", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		const relay = new FakeRelay();
		const index = new Y.Doc();
		const files = index.getMap<unknown>("files");
		const revs = index.getMap<unknown>("docRevs");
		const notes = new FilesMapIndex(files, "Shared");
		const d = device({
			relay,
			disk: new FakeDisk({ "Shared/big.md": BIG, "Shared/small.md": "small\n" }),
			maxBytes: MAX,
			revs,
			pathOf: (id) => notes.pathOf(id),
		});
		const bg = new BackgroundSync({
			docs: d.docs,
			revTracker: d.revTracker,
			revs,
			index: notes,
			readDisk: (p) => d.writer.read(p),
			concurrency: 1,
			isOnline: () => true,
		});
		bg.start();
		const big = newId();
		const small = newId();
		files.set("big.md", { id: big, kind: "md", updatedBy: "x", updatedAt: 1 });
		files.set("small.md", { id: small, kind: "md", updatedBy: "x", updatedAt: 1 });
		bg.catchUp();
		await waitUntil(() => relay.text(noteName(small)) === "small\n");
		await bg.idle();
		expect(relay.clients.has(noteName(big))).toBe(false);

		// A user edit of the large file and a remote rev bump attach nothing either.
		await bg.onDiskModify(big);
		revs.set(big, { at: 5, by: "alice" });
		await bg.idle();
		expect(relay.clients.has(noteName(big))).toBe(false);
		expect(d.revTracker.isChanged(big)).toBe(false);
		expect(d.disk.files.get("Shared/big.md")).toBe(BIG);

		// An editor asking first gets the same answer.
		expect(d.docs.exceedsLimit(big, "Shared/big.md")).toBe(true);
		expect(d.docs.exceedsLimit(small, "Shared/small.md")).toBe(false);
		expect(d.notices).toHaveLength(1);
		expect(d.notices[0]).toMatch(
			/^TeamSync: Shared\/big\.md is larger than .* not synced on this device/,
		);
		expect(warn).toHaveBeenCalledTimes(1);
		bg.dispose();
		warn.mockRestore();
	});

	it("a synced doc over the limit is not written to disk and marks the note tooLarge", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		const relay = new FakeRelay();
		const id = newId();
		relay.remoteEdit(noteName(id), (doc) => Y.applyUpdate(doc, enrollmentUpdate(BIG)));
		const d = device({ relay, disk: new FakeDisk({ "Shared/n.md": "" }), maxBytes: MAX });
		d.paths[id] = "Shared/n.md";
		const note = await d.docs.acquire(id, "Shared/n.md");
		await note.whenReady();
		expect(note.tooLarge).toBe(true);
		expect(note.ytext.toString()).toBe(BIG);
		expect(d.disk.files.get("Shared/n.md")).toBe("");
		expect(d.notices).toHaveLength(1);

		// Once the doc shrinks below the limit, it syncs again.
		relay.remoteEdit(noteName(id), (doc) => doc.getText("contents").delete(0, 10));
		expect((await d.docs.reconcile(note)).action).toBe("write-doc");
		expect(note.tooLarge).toBe(false);
		expect(d.disk.files.get("Shared/n.md")).toBe(BIG.slice(10));
		d.docs.release(note);
		warn.mockRestore();
	});

	it("an attached note whose file grows over the limit is neither enrolled nor overwritten", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		const relay = new FakeRelay();
		const id = newId();
		const d = device({ relay, disk: new FakeDisk({ "Shared/g.md": "" }), maxBytes: MAX });
		d.paths[id] = "Shared/g.md";
		const note = await d.docs.acquire(id, "Shared/g.md");
		await note.whenReady();
		d.disk.files.set("Shared/g.md", BIG);
		expect((await d.docs.reconcile(note)).action).toBe("too-large");
		expect(isEnrolled(note.ydoc)).toBe(false);
		expect(note.ytext.toString()).toBe("");
		expect(d.disk.files.get("Shared/g.md")).toBe(BIG);
		d.docs.release(note);
		warn.mockRestore();
	});

	it("desktop (no limit) syncs a large note as usual", async () => {
		const relay = new FakeRelay();
		const id = newId();
		const d = device({ relay, disk: new FakeDisk({ "Shared/d.md": BIG }) });
		d.paths[id] = "Shared/d.md";
		expect(d.docs.exceedsLimit(id, "Shared/d.md")).toBe(false);
		const note = await d.docs.acquire(id, "Shared/d.md");
		await note.whenReady();
		expect(note.tooLarge).toBe(false);
		expect(note.ytext.toString()).toBe(BIG);
		d.docs.release(note);
	});
});
