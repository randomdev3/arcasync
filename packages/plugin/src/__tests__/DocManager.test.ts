import "fake-indexeddb/auto";
import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { enrollmentUpdate } from "../doc/enroll";
import { device, FakeDisk, FakeRelay, noteName, sleep, waitUntil } from "./helpers/noteFakes";

let seq = 0;
const newId = () => `dm${++seq}x${Date.now().toString(36)}`;

function seeded(relay: FakeRelay, fileId: string, text: string) {
	relay.remoteEdit(noteName(fileId), (doc) => Y.applyUpdate(doc, enrollmentUpdate(text)));
}

describe("DocManager", () => {
	it("refcounts: one attached doc per note, kept warm after the last release", async () => {
		const relay = new FakeRelay();
		const d = device({ relay, disk: new FakeDisk({ "Shared/a.md": "" }) });
		const id = newId();
		d.paths[id] = "Shared/a.md";
		const one = await d.docs.acquire(id, "Shared/a.md");
		const two = await d.docs.acquire(id, "Shared/a.md");
		expect(two).toBe(one);
		expect(relay.frames.attaches).toBe(1);
		d.docs.release(one);
		d.docs.release(two);
		expect(d.docs.attachedCount()).toBe(1);
		expect(one.state).not.toBe("closed");
		// Re-acquiring a warm doc does not attach again.
		expect(await d.docs.acquire(id, "Shared/a.md")).toBe(one);
		expect(relay.frames.attaches).toBe(1);
	});

	it("a background open publishes no awareness state", async () => {
		const relay = new FakeRelay();
		const d = device({ relay, disk: new FakeDisk({ "Shared/a.md": "" }) });
		const id = newId();
		d.paths[id] = "Shared/a.md";
		const note = await d.docs.acquire(id, "Shared/a.md");
		expect(note.awareness.getLocalState()).toBeNull();
	});

	it("caps released docs at warmDocs, detaching the least recently used", async () => {
		const relay = new FakeRelay();
		const d = device({ relay, warmDocs: 2 });
		const ids = [newId(), newId(), newId()];
		const notes = [];
		for (const id of ids) {
			d.paths[id] = `Shared/${id}.md`;
			d.disk.files.set(`Shared/${id}.md`, "");
			const note = await d.docs.acquire(id, d.paths[id] as string);
			await note.whenReady();
			notes.push(note);
		}
		for (const note of notes) d.docs.release(note);
		await waitUntil(() => d.docs.attachedCount() === 2);
		expect(notes[0]?.state).toBe("closed");
		expect(notes[1]?.state).toBe("ready");
		expect(notes[2]?.state).toBe("ready");
	});

	it("eviction waits until the relay acked the doc's changes", async () => {
		const relay = new FakeRelay();
		const d = device({ relay, warmDocs: 0 });
		const id = newId();
		d.paths[id] = "Shared/a.md";
		d.disk.files.set("Shared/a.md", "");
		const note = await d.docs.acquire(id, "Shared/a.md");
		await note.whenReady();
		await waitUntil(() => !note.provider.hasUnsyncedChanges);
		relay.autoAck = false;
		note.ytext.insert(0, "unacked");
		d.docs.release(note);
		await sleep(30);
		expect(note.state).toBe("ready");
		expect(d.docs.attachedCount()).toBe(1);
		relay.flushAcks();
		await waitUntil(() => note.state === "closed");
		expect(d.docs.attachedCount()).toBe(0);
	});

	it("re-acquiring a doc while its eviction waits keeps it attached", async () => {
		const relay = new FakeRelay();
		const d = device({ relay, warmDocs: 0 });
		const id = newId();
		d.paths[id] = "Shared/a.md";
		d.disk.files.set("Shared/a.md", "");
		const note = await d.docs.acquire(id, "Shared/a.md");
		await note.whenReady();
		relay.autoAck = false;
		note.ytext.insert(0, "x");
		d.docs.release(note);
		expect(await d.docs.acquire(id, "Shared/a.md")).toBe(note);
		relay.flushAcks();
		await sleep(30);
		expect(note.state).toBe("ready");
	});

	it("writes remote changes to disk (debounced) while no editor is bound", async () => {
		const relay = new FakeRelay();
		const id = newId();
		seeded(relay, id, "v1\n");
		const d = device({ relay, disk: new FakeDisk({ "Shared/a.md": "" }) });
		d.paths[id] = "Shared/a.md";
		const note = await d.docs.acquire(id, "Shared/a.md");
		await note.whenReady();
		expect(d.disk.files.get("Shared/a.md")).toBe("v1\n");
		relay.remoteEdit(noteName(id), (doc) => doc.getText("contents").insert(3, "v2\n"));
		await waitUntil(() => d.disk.files.get("Shared/a.md") === "v1\nv2\n");

		note.editorBound = true;
		relay.remoteEdit(noteName(id), (doc) => doc.getText("contents").insert(0, "bound "));
		await sleep(50);
		expect(d.disk.files.get("Shared/a.md")).toBe("v1\nv2\n");
	});

	it("follows the index when a note moved before its write", async () => {
		const relay = new FakeRelay();
		const id = newId();
		seeded(relay, id, "text\n");
		const d = device({ relay, disk: new FakeDisk({ "Shared/new.md": "" }) });
		d.paths[id] = "Shared/new.md";
		const note = await d.docs.acquire(id, "Shared/old.md");
		await note.whenReady();
		expect(d.disk.files.get("Shared/new.md")).toBe("text\n");
		expect(note.path).toBe("Shared/new.md");
	});

	it("leaves no connection listeners behind after ready and eviction", async () => {
		const relay = new FakeRelay();
		const d = device({ relay, warmDocs: 0 });
		for (let i = 0; i < 3; i++) {
			const id = newId();
			d.paths[id] = `Shared/${id}.md`;
			d.disk.files.set(`Shared/${id}.md`, "text\n");
			const note = await d.docs.acquire(id, `Shared/${id}.md`);
			await note.whenReady();
			d.docs.release(note);
			await waitUntil(() => note.state === "closed");
		}
		expect(relay.statusListenerCount).toBe(0);
	});

	it("destroy() detaches everything at once", async () => {
		const relay = new FakeRelay();
		const d = device({ relay, disk: new FakeDisk({ "Shared/a.md": "" }) });
		const id = newId();
		d.paths[id] = "Shared/a.md";
		const note = await d.docs.acquire(id, "Shared/a.md");
		d.docs.destroy();
		await waitUntil(() => note.state === "closed");
		await expect(d.docs.acquire(id, "Shared/a.md")).rejects.toThrow();
	});
});
