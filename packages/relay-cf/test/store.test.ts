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
});
