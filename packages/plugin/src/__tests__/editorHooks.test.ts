import "fake-indexeddb/auto";
import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { enrollmentUpdate } from "../doc/enroll";
import { minimalChange } from "../editor/EditorBinding";
import { device, FakeDisk, FakeRelay, noteName, sleep, waitUntil } from "./helpers/noteFakes";

let seq = 0;
const newId = () => `eh${++seq}x${Date.now().toString(36)}`;
const PATH = "Shared/a.md";

async function boundNote(text: string) {
	const relay = new FakeRelay();
	const id = newId();
	relay.remoteEdit(noteName(id), (doc) => Y.applyUpdate(doc, enrollmentUpdate(text)));
	const d = device({ relay, disk: new FakeDisk({ [PATH]: text }) });
	d.paths[id] = PATH;
	const note = await d.docs.acquire(id, PATH);
	await note.whenReady();
	const remote = (fn: (t: Y.Text) => void) =>
		relay.remoteEdit(noteName(id), (doc) => fn(doc.getText("contents")));
	return { relay, d, id, note, remote };
}

describe("minimalChange", () => {
	const apply = (from: string, to: string) => {
		const c = minimalChange(from, to) as { from: number; to: number; insert: string } | null;
		return c ? from.slice(0, c.from) + c.insert + from.slice(c.to) : from;
	};

	it("returns null for equal texts", () => {
		expect(minimalChange("same", "same")).toBeNull();
	});

	it("keeps the common prefix and suffix", () => {
		expect(minimalChange("Line one\nLine two\n", "Line one alpha\nLine two\n")).toEqual({
			from: 8,
			to: 8,
			insert: " alpha",
		});
		expect(minimalChange("abcdef", "abef")).toEqual({ from: 2, to: 4, insert: "" });
	});

	it("turns any text into any other", () => {
		const pairs = [
			["", "x"],
			["x", ""],
			["aaa", "aa"],
			["abcabc", "abc"],
			["hello world", "help word"],
			["\n\n", "\n"],
		];
		for (const [from, to] of pairs) expect(apply(from as string, to as string)).toBe(to);
	});
});

describe("DocManager editor hooks", () => {
	it("attach waits for a running reconcile; a bound note's doc changes stay off the disk", async () => {
		const { d, note, remote } = await boundNote("v1\n");
		const order: string[] = [];
		const reconciling = d.docs.reconcile(note).then(() => order.push("reconcile"));
		const attached = await d.docs.editorAttached(note, () => {
			order.push("attach");
			return true;
		});
		await reconciling;
		expect(attached).toBe(true);
		expect(order).toEqual(["reconcile", "attach"]);
		expect(note.editorBound).toBe(true);
		remote((t) => t.insert(3, "remote\n"));
		await sleep(50);
		expect(d.disk.files.get(PATH)).toBe("v1\n");
	});

	it("an attach that gave up does not bind", async () => {
		const { d, note } = await boundNote("v1\n");
		expect(await d.docs.editorAttached(note, () => false)).toBe(false);
		expect(note.editorBound).toBe(false);
	});

	it("split panes: the note stays bound until its last editor detaches, then reaches the disk", async () => {
		const { d, note, remote } = await boundNote("v1\n");
		await d.docs.editorAttached(note, () => true);
		await d.docs.editorAttached(note, () => true);
		d.docs.editorDetached(note);
		await sleep(50);
		expect(note.editorBound).toBe(true);
		d.docs.editorDetached(note);
		// The grace period: a save of the closing editor may still be in flight.
		expect(note.editorBound).toBe(true);
		remote((t) => t.insert(3, "after\n"));
		await waitUntil(() => d.disk.files.get(PATH) === "v1\nafter\n");
		expect(note.editorBound).toBe(false);
	});

	it("an editor save landing after detach is not an offline edit", async () => {
		const { d, note, remote } = await boundNote("v1\n");
		await d.docs.editorAttached(note, () => true);
		// The user types in the editor (the buffer mirrors the doc), then switches files.
		note.ytext.insert(3, "typed\n");
		d.docs.editorDetached(note);
		// A peer keeps typing; then Obsidian's save of the closed buffer lands.
		remote((t) => t.insert(t.length, "peer\n"));
		d.disk.files.set(PATH, "v1\ntyped\n");
		await d.docs.reconcile(note);
		await waitUntil(() => d.disk.files.get(PATH) === "v1\ntyped\npeer\n");
		expect(note.ytext.toString()).toBe("v1\ntyped\npeer\n");
		expect(d.notices).toEqual([]);
		expect([...d.disk.files.keys()]).toEqual([PATH]);
	});

	it("a save started while bound that lands after detach is not an offline edit", async () => {
		const { d, note, remote } = await boundNote("v1\n");
		await d.docs.editorAttached(note, () => true);
		note.ytext.insert(3, "one\n");
		// Obsidian saves "v1\none\n" while the user keeps typing, so by the time the save is
		// seen the buffer (and doc) already moved on...
		d.disk.files.set(PATH, "v1\none\n");
		note.ytext.insert(7, "two\n");
		await d.docs.noteEditorSave(note);
		// ...and after the switch the disk still holds that older save.
		d.docs.editorDetached(note);
		remote((t) => t.insert(t.length, "peer\n"));
		d.disk.files.set(PATH, "v1\none\n");
		await d.docs.reconcile(note);
		await waitUntil(() => d.disk.files.get(PATH) === "v1\none\ntwo\npeer\n");
		expect(d.notices).toEqual([]);
		expect([...d.disk.files.keys()]).toEqual([PATH]);
	});

	it("after the grace period, a revert to a text the editor once held is a real edit", async () => {
		const { d, note, remote } = await boundNote("v1\n");
		await d.docs.editorAttached(note, () => true);
		note.ytext.insert(3, "typed\n");
		d.docs.editorDetached(note);
		await waitUntil(() => d.disk.files.get(PATH) === "v1\ntyped\n");
		remote((t) => t.insert(t.length, "peer\n"));
		await waitUntil(() => d.disk.files.get(PATH) === "v1\ntyped\npeer\n");
		d.disk.files.set(PATH, "v1\ntyped\n");
		await d.docs.reconcile(note);
		expect(note.ytext.toString()).toBe("v1\ntyped\n");
	});

	it("a real offline edit after detach is still merged", async () => {
		const { d, note } = await boundNote("v1\n");
		await d.docs.editorAttached(note, () => true);
		d.docs.editorDetached(note);
		await sleep(50);
		d.disk.files.set(PATH, "v1\nedited elsewhere\n");
		await d.docs.reconcile(note);
		expect(note.ytext.toString()).toBe("v1\nedited elsewhere\n");
	});
});
