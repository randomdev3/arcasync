import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { DocStore } from "../src/store";
import { memorySql } from "./sqlite";

const DOC = "ws:w1:index";

function editor() {
	const doc = new Y.Doc();
	const updates: Uint8Array[] = [];
	doc.on("update", (u: Uint8Array) => updates.push(u));
	return { doc, updates };
}

function rebuild(update: Uint8Array): Y.Doc {
	const doc = new Y.Doc();
	Y.applyUpdate(doc, update);
	return doc;
}

describe("DocStore", () => {
	it("answers SyncStep1 for an unknown doc with an empty state vector and empty diff", () => {
		const { sql, transaction } = memorySql();
		const store = new DocStore(sql, transaction);
		const { stateVector, diff } = store.syncReply(DOC, Y.encodeStateVector(new Y.Doc()));
		expect([...stateVector]).toEqual([0]);
		expect([...diff]).toEqual([0, 0]);
		expect(store.rowsWritten).toBe(0);
	});

	it("stores one row per update and replies with only what the client lacks", () => {
		const { sql, transaction } = memorySql();
		const store = new DocStore(sql, transaction);
		const a = editor();
		a.doc.getMap("m").set("x", 1);
		const known = Y.encodeStateVector(a.doc);
		a.doc.getMap("m").set("y", 2);
		for (const u of a.updates) store.append(DOC, u);
		expect(store.rowsWritten).toBe(2);

		const full = rebuild(store.syncReply(DOC, new Uint8Array([0])).diff);
		expect(full.getMap("m").toJSON()).toEqual({ x: 1, y: 2 });

		const { diff, stateVector } = store.syncReply(DOC, known);
		const client = rebuild(a.updates[0] as Uint8Array);
		expect(client.getMap("m").get("y")).toBeUndefined();
		Y.applyUpdate(client, diff);
		expect(client.getMap("m").toJSON()).toEqual({ x: 1, y: 2 });
		expect(diff.length).toBeLessThan(Y.encodeStateAsUpdate(a.doc).length);
		expect([...stateVector]).toEqual([...Y.encodeStateVector(a.doc)]);
	});

	it("compacts the tail into parts and a fresh instance (a woken object) reads the same state", () => {
		const { sql, transaction } = memorySql();
		const store = new DocStore(sql, transaction, { compactAfterRows: 10, partBytes: 64 });
		const a = editor();
		const text = a.doc.getText("t");
		for (let i = 0; i < 25; i++) text.insert(text.length, `line ${i} `.repeat(3));
		for (const u of a.updates) store.append(DOC, u);
		expect(store.compactions).toBe(2);

		const parts = sql.exec("SELECT COUNT(*) AS n FROM doc_state WHERE doc = ?", DOC).toArray();
		expect(Number(parts[0]?.n)).toBeGreaterThan(1);
		const tail = sql.exec("SELECT COUNT(*) AS n FROM doc_updates WHERE doc = ?", DOC).toArray();
		expect(Number(tail[0]?.n)).toBe(5);

		const woken = new DocStore(sql, transaction, { compactAfterRows: 10, partBytes: 64 });
		const restored = rebuild(woken.syncReply(DOC, new Uint8Array([0])).diff);
		expect(restored.getText("t").toString()).toBe(text.toString());

		// Appends after the wake continue the log without clobbering surviving tail rows.
		text.insert(0, "head ");
		woken.append(DOC, a.updates[a.updates.length - 1] as Uint8Array);
		const again = new DocStore(sql, transaction);
		expect(rebuild(again.state(DOC)).getText("t").toString()).toBe(text.toString());
	});

	it("rejects an undecodable update without storing it", () => {
		const { sql, transaction } = memorySql();
		const store = new DocStore(sql, transaction);
		expect(() => store.append(DOC, new Uint8Array([5, 200, 1]))).toThrow();
		expect(store.rowsWritten).toBe(0);
	});

	it("keeps docs isolated", () => {
		const { sql, transaction } = memorySql();
		const store = new DocStore(sql, transaction);
		const a = editor();
		a.doc.getMap("m").set("only", "a");
		for (const u of a.updates) store.append(DOC, u);
		const other = store.syncReply("ws:w1:md:f1", new Uint8Array([0]));
		expect([...other.diff]).toEqual([0, 0]);
	});

	it("bounds the doc cache and reloads evicted docs with an identical state", () => {
		const { sql, transaction } = memorySql();
		const store = new DocStore(sql, transaction);
		const vectors = new Map<string, number[]>();
		for (let i = 0; i < 100; i++) {
			const name = `ws:w1:md:f${i}`;
			const a = editor();
			a.doc.getText("t").insert(0, `doc ${i}`);
			a.doc.getText("t").insert(0, "> ");
			for (const u of a.updates) store.append(name, u);
			vectors.set(name, [...Y.encodeStateVector(a.doc)]);
			expect(store.cachedDocs).toBeLessThanOrEqual(64);
		}
		expect(store.cachedDocs).toBe(64);
		// f0..f35 were evicted; the reload from SQL must not lose anything.
		for (const [name, vector] of vectors) {
			expect([...Y.encodeStateVectorFromUpdate(store.state(name))]).toEqual(vector);
			expect(rebuild(store.state(name)).getText("t").toString()).toMatch(/^> doc \d+$/);
		}
		expect(store.cachedDocs).toBe(64);
	});

	it("evicts by bytes and never the doc being written", () => {
		const { sql, transaction } = memorySql();
		const store = new DocStore(sql, transaction, { maxCachedBytes: 4096 });
		const big = "x".repeat(3000);
		for (let i = 0; i < 3; i++) {
			const a = editor();
			a.doc.getText("t").insert(0, big);
			for (const u of a.updates) store.append(`ws:w1:md:big${i}`, u);
			expect(store.cachedDocs).toBe(1);
		}
		expect(rebuild(store.state("ws:w1:md:big0")).getText("t").toString()).toBe(big);
	});

	it("keeps deleted content through compaction (non-GC), so snapshots still restore it", () => {
		const { sql, transaction } = memorySql();
		const store = new DocStore(sql, transaction, { compactAfterRows: 20 });
		const doc = new Y.Doc({ gc: false });
		const updates: Uint8Array[] = [];
		doc.on("update", (u: Uint8Array) => updates.push(u));
		const text = doc.getText("t");
		for (let i = 0; i < 30; i++) text.insert(text.length, `word${i} `);
		const before = text.toString();
		const snapshot = Y.snapshot(doc);
		// Delete-heavy edits in separate transactions, after the snapshot.
		for (let i = 0; i < 25; i++) text.delete(0, 3);
		text.insert(0, "new ");
		for (const u of updates) store.append(DOC, u);
		expect(store.compactions).toBeGreaterThan(0);

		const state = new DocStore(sql, transaction, { compactAfterRows: 20 }).state(DOC);
		const restored = new Y.Doc({ gc: false });
		Y.applyUpdate(restored, state);
		expect(restored.getText("t").toString()).toBe(text.toString());
		expect(Y.createDocFromSnapshot(restored, snapshot).getText("t").toString()).toBe(before);

		// Control: a GC'ing round-trip loses the deleted text, so the check above is meaningful.
		const collected = new Y.Doc();
		Y.applyUpdate(collected, state);
		const lossy = new Y.Doc({ gc: false });
		Y.applyUpdate(lossy, Y.encodeStateAsUpdate(collected));
		expect(Y.createDocFromSnapshot(lossy, snapshot).getText("t").toString()).not.toBe(before);
	});
});
