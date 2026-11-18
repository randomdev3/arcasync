import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { DocStore, SCHEMA_VERSION, type SqlLike } from "../src/store";
import { memorySql } from "./sqlite";

const DOC = "ws:w1:index";
const ALICE = "user-alice";
const BOB = "user-bob";

function editor() {
	const doc = new Y.Doc();
	const updates: Uint8Array[] = [];
	doc.on("update", (u: Uint8Array) => updates.push(u));
	return { doc, updates };
}

/** Small seeded PRNG, so the random-edit test is reproducible. */
function mulberry32(seed: number): () => number {
	let t = seed;
	return () => {
		t = (t + 0x6d2b79f5) | 0;
		let r = Math.imul(t ^ (t >>> 15), 1 | t);
		r = (r + Math.imul(r ^ (r >>> 7), 61 | r)) ^ r;
		return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
	};
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
		for (const u of a.updates) store.append(DOC, u, ALICE);
		// Two log rows plus one doc_clients row for the (single) client on first sight.
		expect(store.rowsWritten).toBe(3);

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
		for (const u of a.updates) store.append(DOC, u, ALICE);
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
		woken.append(DOC, a.updates[a.updates.length - 1] as Uint8Array, ALICE);
		const again = new DocStore(sql, transaction);
		expect(rebuild(again.state(DOC)).getText("t").toString()).toBe(text.toString());
	});

	it("rejects an undecodable update without storing it", () => {
		const { sql, transaction } = memorySql();
		const store = new DocStore(sql, transaction);
		expect(() => store.append(DOC, new Uint8Array([5, 200, 1]), ALICE)).toThrow();
		expect(store.rowsWritten).toBe(0);
	});

	it("keeps docs isolated", () => {
		const { sql, transaction } = memorySql();
		const store = new DocStore(sql, transaction);
		const a = editor();
		a.doc.getMap("m").set("only", "a");
		for (const u of a.updates) store.append(DOC, u, ALICE);
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
			for (const u of a.updates) store.append(name, u, ALICE);
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
			for (const u of a.updates) store.append(`ws:w1:md:big${i}`, u, ALICE);
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
		for (const u of updates) store.append(DOC, u, ALICE);
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
	it("replays 1,000 random edits by two users and attributes every row and client", () => {
		const random = mulberry32(0x5eed);
		const a = new Y.Doc();
		const b = new Y.Doc();
		const log: { update: Uint8Array; user: string }[] = [];
		const outbox = new Map<Y.Doc, Uint8Array[]>([
			[a, []],
			[b, []],
		]);
		for (const [doc, user] of [
			[a, ALICE],
			[b, BOB],
		] as const) {
			doc.on("update", (update: Uint8Array, origin: unknown) => {
				if (origin === "remote") return;
				log.push({ update, user });
				outbox.get(doc)?.push(update);
			});
		}
		const deliver = (from: Y.Doc, to: Y.Doc) => {
			for (const u of outbox.get(from)?.splice(0) ?? []) Y.applyUpdate(to, u, "remote");
		};
		for (let i = 0; i < 1000; i++) {
			const doc = random() < 0.5 ? a : b;
			const text = doc.getText("t");
			if (text.length > 0 && random() < 0.4) {
				const at = Math.floor(random() * text.length);
				text.delete(at, 1 + Math.floor(random() * Math.min(5, text.length - at)));
			} else {
				text.insert(Math.floor(random() * (text.length + 1)), String.fromCharCode(97 + (i % 26)));
			}
			// Exchange only now and then, so many edits are concurrent.
			if (random() < 0.3) {
				deliver(a, b);
				deliver(b, a);
			}
		}
		deliver(a, b);
		deliver(b, a);
		expect(a.getText("t").toString()).toBe(b.getText("t").toString());
		expect(log).toHaveLength(1000);

		// Default threshold: compaction runs twice; a fresh store (a woken object) agrees.
		const compacting = memorySql();
		const store = new DocStore(compacting.sql, compacting.transaction);
		for (const { update, user } of log) store.append(DOC, update, user);
		expect(store.compactions).toBe(2);
		const state = new DocStore(compacting.sql, compacting.transaction).state(DOC);
		expect([...Y.encodeStateVectorFromUpdate(state)]).toEqual([...Y.encodeStateVector(a)]);
		expect(rebuild(state).getText("t").toString()).toBe(a.getText("t").toString());

		// No compaction: every log row is still there to count.
		const plain = memorySql();
		const counted = new DocStore(plain.sql, plain.transaction, { compactAfterRows: 10_000 });
		for (const { update, user } of log) counted.append(DOC, update, user);
		const debug = new DocStore(plain.sql, plain.transaction).debug(DOC);
		expect(debug.rowsByUser).toEqual({
			[ALICE]: log.filter((e) => e.user === ALICE).length,
			[BOB]: log.filter((e) => e.user === BOB).length,
		});
		expect(debug.tailRows).toBe(1000);
		expect(debug.clients).toHaveLength(2);
		expect(new Map(debug.clients.map((c) => [c.clientId, c.userId]))).toEqual(
			new Map([
				[a.clientID, ALICE],
				[b.clientID, BOB],
			]),
		);
		// 1,000 log rows plus one doc_clients row per client.
		expect(counted.rowsWritten).toBe(1002);
	});

	it("writes a doc_clients row only on a client's first sight, also after a wake", () => {
		const { sql, transaction } = memorySql();
		const store = new DocStore(sql, transaction);
		const a = editor();
		const text = a.doc.getText("t");
		text.insert(0, "a");
		store.append(DOC, a.updates[0] as Uint8Array, ALICE);
		expect(store.rowsWritten).toBe(2);

		text.insert(1, "b");
		store.append(DOC, a.updates[1] as Uint8Array, ALICE);
		expect(store.rowsWritten).toBe(3);

		const woken = new DocStore(sql, transaction);
		text.insert(2, "c");
		woken.append(DOC, a.updates[2] as Uint8Array, ALICE);
		expect(woken.rowsWritten).toBe(1);

		const b = editor();
		b.doc.getText("t").insert(0, "z");
		woken.append(DOC, b.updates[0] as Uint8Array, BOB);
		expect(woken.rowsWritten).toBe(3);
		expect(new Map(woken.debug(DOC).clients.map((c) => [c.clientId, c.userId]))).toEqual(
			new Map([
				[a.doc.clientID, ALICE],
				[b.doc.clientID, BOB],
			]),
		);
	});

	it("records the author and time of every log row", () => {
		const { sql, transaction } = memorySql();
		const store = new DocStore(sql, transaction, { now: () => 1234 });
		const a = editor();
		a.doc.getText("t").insert(0, "x");
		store.append(DOC, a.updates[0] as Uint8Array, BOB);
		expect(sql.exec("SELECT user_id, codec, at FROM doc_updates").toArray()).toEqual([
			{ user_id: BOB, codec: 1, at: 1234 },
		]);
		expect(sql.exec("SELECT client_id, user_id, first_seen FROM doc_clients").toArray()).toEqual([
			{ client_id: a.doc.clientID, user_id: BOB, first_seen: 1234 },
		]);
	});

	it("compacts without touching doc_clients and stores parts as codec 1", () => {
		const { sql, transaction } = memorySql();
		const store = new DocStore(sql, transaction, { compactAfterRows: 10, partBytes: 64 });
		const a = editor();
		const b = editor();
		for (let i = 0; i < 6; i++) a.doc.getText("t").insert(0, `alice ${i} `);
		for (let i = 0; i < 6; i++) b.doc.getText("u").insert(0, `bob ${i} `);
		for (const u of a.updates) store.append(DOC, u, ALICE);
		for (const u of b.updates) store.append(DOC, u, BOB);
		expect(store.compactions).toBe(1);

		const clients = sql
			.exec("SELECT client_id, user_id FROM doc_clients ORDER BY user_id")
			.toArray();
		expect(clients).toEqual([
			{ client_id: a.doc.clientID, user_id: ALICE },
			{ client_id: b.doc.clientID, user_id: BOB },
		]);
		const codecs = sql.exec("SELECT DISTINCT codec FROM doc_state").toArray();
		expect(codecs).toEqual([{ codec: 1 }]);
		expect(Number(sql.exec("SELECT COUNT(*) AS n FROM doc_state").toArray()[0]?.n)).toBeGreaterThan(
			1,
		);
		expect(store.debug(DOC).tailRows).toBe(2);
	});

	it("refuses to merge rows of another codec and deletes nothing", () => {
		const { sql, transaction } = memorySql();
		const store = new DocStore(sql, transaction, { compactAfterRows: 3 });
		const a = editor();
		a.doc.getText("t").insert(0, "plain");
		store.append(DOC, a.updates[0] as Uint8Array, ALICE);
		sql.exec(
			"INSERT INTO doc_updates (doc, seq, data, user_id, codec, at) VALUES (?, 2, ?, ?, 2, 0)",
			DOC,
			new Uint8Array([1, 2, 3]),
			ALICE,
		);
		const fresh = new DocStore(sql, transaction, { compactAfterRows: 3 });
		expect(() => fresh.state(DOC)).toThrow(/codec 2/);
		expect(() => fresh.compact(DOC)).toThrow(/codec 2/);
		const tail = sql.exec("SELECT COUNT(*) AS n FROM doc_updates WHERE doc = ?", DOC).toArray();
		expect(Number(tail[0]?.n)).toBe(2);
	});

	it("creates the schema once and writes nothing when it reopens it", () => {
		const { sql, transaction } = memorySql();
		new DocStore(sql, transaction);
		const statements: string[] = [];
		const spy: SqlLike = {
			exec(query, ...bindings) {
				statements.push(query.trim().split(/\s+/).slice(0, 3).join(" "));
				return sql.exec(query, ...bindings);
			},
		};
		const reopened = new DocStore(spy, transaction);
		expect(reopened.rowsWritten).toBe(0);
		expect(statements).toEqual(["CREATE TABLE IF", "SELECT value FROM"]);
		expect(sql.exec("SELECT key, value FROM _meta").toArray()).toEqual([
			{ key: "schema", value: SCHEMA_VERSION },
		]);
	});

	it("refuses state that predates schema 2", () => {
		const old = memorySql();
		old.sql.exec(`CREATE TABLE doc_updates (
			doc TEXT NOT NULL, seq INTEGER NOT NULL, data BLOB NOT NULL,
			PRIMARY KEY (doc, seq)) WITHOUT ROWID`);
		expect(() => new DocStore(old.sql, old.transaction)).toThrow(
			"relay state predates schema 2; delete packages/relay-cf/.wrangler/state",
		);

		const other = memorySql();
		other.sql.exec("CREATE TABLE _meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
		other.sql.exec("INSERT INTO _meta (key, value) VALUES ('schema', '1')");
		expect(() => new DocStore(other.sql, other.transaction)).toThrow(/predates schema 2/);
	});
});
