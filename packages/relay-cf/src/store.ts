/**
 * Durable Yjs storage without a live `Y.Doc`.
 *
 * Every accepted update (V1, as on the wire) is appended as ONE row. When a document's tail
 * grows past a threshold it is merged (`Y.mergeUpdates`) into a state blob stored as parts of
 * at most `partBytes`, and the tail rows are deleted, all in one transaction. Sync replies are
 * computed on the encoded state (`Y.diffUpdate`, `Y.encodeStateVectorFromUpdate`), so an object
 * woken from hibernation only has to read rows, never rebuild a document.
 *
 * Compaction keeps NON-GC merged state (decision R-6): `Y.mergeUpdates` never drops deleted
 * items, which P3 needs for Yjs snapshots (versions, diffs) and per-client attribution through
 * `doc_clients`. GC-compaction (a transient `Y.Doc` with gc, plus materialised text for older
 * versions) is deferred to P3 retention; a ring-slot tail (no delete rows) waits for the R-7
 * probe to show whether deletes count as rows written on Cloudflare.
 *
 * The merged states are cached in a bounded LRU (`maxCachedDocs`, `maxCachedBytes`). Eviction
 * is always safe: every accepted update is already in SQL, so an evicted doc just reloads.
 */
import * as Y from "yjs";

/** The subset of Cloudflare's `SqlStorage` the store needs (also satisfied by a node:sqlite shim). */
export interface SqlCursorLike {
	toArray(): Record<string, unknown>[];
	readonly rowsWritten: number;
}
export interface SqlLike {
	exec(query: string, ...bindings: unknown[]): SqlCursorLike;
}

export interface DocStoreOptions {
	/** Compact once a document has this many tail rows. */
	compactAfterRows?: number;
	/** ...or once its tail holds this many bytes. */
	compactAfterBytes?: number;
	/** Maximum size of one stored state part (CF caps a row at 8 MB). */
	partBytes?: number;
	/** LRU bound on cached documents. */
	maxCachedDocs?: number;
	/** LRU bound on cached bytes (merged state plus not yet merged updates). */
	maxCachedBytes?: number;
}

interface DocEntry {
	/** Merged state of everything known; `pending` still has to be folded in. */
	base: Uint8Array;
	pending: Uint8Array[];
	tailRows: number;
	tailBytes: number;
	nextSeq: number;
	/** `base` plus `pending`, for the cache byte bound. */
	bytes: number;
}

const MiB = 1024 * 1024;
/** A merged state this large is logged once per load: P3 retention should GC-compact it. */
export const LARGE_STATE_BYTES = 16 * MiB;
const EMPTY_UPDATE = new Uint8Array([0, 0]);

function bytes(value: unknown): Uint8Array {
	if (value instanceof Uint8Array) return value;
	if (value instanceof ArrayBuffer) return new Uint8Array(value);
	throw new Error(`expected a BLOB, got ${typeof value}`);
}

function concat(chunks: Uint8Array[]): Uint8Array {
	if (chunks.length === 1 && chunks[0]) return chunks[0];
	const out = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
	let offset = 0;
	for (const chunk of chunks) {
		out.set(chunk, offset);
		offset += chunk.length;
	}
	return out;
}

export class DocStore {
	private readonly docs = new Map<string, DocEntry>();
	private readonly compactAfterRows: number;
	private readonly compactAfterBytes: number;
	private readonly partBytes: number;
	private readonly maxCachedDocs: number;
	private readonly maxCachedBytes: number;
	private cachedBytes = 0;
	/** Docs already reported as large since they were (re)loaded. */
	private readonly warned = new Set<string>();
	/** Rows written by this store (inserts, deletes, compaction), from the SQL cursors. */
	rowsWritten = 0;
	compactions = 0;

	constructor(
		private readonly sql: SqlLike,
		private readonly transaction: <T>(fn: () => T) => T,
		options: DocStoreOptions = {},
	) {
		this.compactAfterRows = options.compactAfterRows ?? 500;
		this.compactAfterBytes = options.compactAfterBytes ?? MiB;
		this.partBytes = options.partBytes ?? MiB;
		this.maxCachedDocs = options.maxCachedDocs ?? 64;
		this.maxCachedBytes = options.maxCachedBytes ?? 64 * MiB;
		sql.exec(`CREATE TABLE IF NOT EXISTS doc_updates (
			doc TEXT NOT NULL, seq INTEGER NOT NULL, data BLOB NOT NULL,
			PRIMARY KEY (doc, seq)) WITHOUT ROWID`);
		sql.exec(`CREATE TABLE IF NOT EXISTS doc_state (
			doc TEXT NOT NULL, part INTEGER NOT NULL, data BLOB NOT NULL,
			PRIMARY KEY (doc, part)) WITHOUT ROWID`);
	}

	private run(query: string, ...bindings: unknown[]): Record<string, unknown>[] {
		const cursor = this.sql.exec(query, ...bindings);
		const rows = cursor.toArray();
		this.rowsWritten += cursor.rowsWritten;
		return rows;
	}

	/** Number of documents currently held in the cache. */
	get cachedDocs(): number {
		return this.docs.size;
	}

	private load(doc: string): DocEntry {
		const cached = this.docs.get(doc);
		if (cached) {
			// Re-insert: Map iteration order is the LRU order (oldest first).
			this.docs.delete(doc);
			this.docs.set(doc, cached);
			return cached;
		}
		const parts = this.run("SELECT data FROM doc_state WHERE doc = ? ORDER BY part", doc).map((r) =>
			bytes(r.data),
		);
		const tail = this.run("SELECT seq, data FROM doc_updates WHERE doc = ? ORDER BY seq", doc);
		const updates = tail.map((r) => bytes(r.data));
		const tailBytes = updates.reduce((n, u) => n + u.length, 0);
		if (parts.length > 0) updates.unshift(concat(parts));
		const last = tail[tail.length - 1];
		const base = updates.length === 0 ? EMPTY_UPDATE : Y.mergeUpdates(updates);
		const entry: DocEntry = {
			base,
			pending: [],
			tailRows: tail.length,
			tailBytes,
			nextSeq: last ? Number(last.seq) + 1 : 1,
			bytes: base.length,
		};
		this.docs.set(doc, entry);
		this.cachedBytes += entry.bytes;
		this.warned.delete(doc);
		this.checkSize(doc, base);
		this.evict(doc);
		return entry;
	}

	private resize(entry: DocEntry, bytes: number): void {
		this.cachedBytes += bytes - entry.bytes;
		entry.bytes = bytes;
	}

	/** Drops least recently used docs until both bounds hold; `keep` is never evicted. */
	private evict(keep: string): void {
		for (const [doc, entry] of this.docs) {
			if (this.docs.size <= this.maxCachedDocs && this.cachedBytes <= this.maxCachedBytes) return;
			if (doc === keep) continue;
			this.docs.delete(doc);
			this.cachedBytes -= entry.bytes;
		}
	}

	private checkSize(doc: string, state: Uint8Array): void {
		if (state.length <= LARGE_STATE_BYTES || this.warned.has(doc)) return;
		this.warned.add(doc);
		console.warn(
			`relay: merged state of ${doc} is ${(state.length / MiB).toFixed(1)} MiB (> 16 MiB); ` +
				"it keeps deleted content until P3 retention GC-compacts it",
		);
	}

	/** Merged V1 state of the document (an empty update for an unknown document). */
	state(doc: string): Uint8Array {
		const entry = this.load(doc);
		if (entry.pending.length > 0) {
			entry.base = Y.mergeUpdates([entry.base, ...entry.pending]);
			entry.pending = [];
			this.resize(entry, entry.base.length);
			this.checkSize(doc, entry.base);
			this.evict(doc);
		}
		return entry.base;
	}

	/**
	 * Persists one update. Throws (and stores nothing) if it is not a decodable V1 update.
	 * Returns true when the append triggered a compaction.
	 */
	append(doc: string, update: Uint8Array): boolean {
		Y.parseUpdateMeta(update);
		const entry = this.load(doc);
		const seq = entry.nextSeq++;
		this.run("INSERT INTO doc_updates (doc, seq, data) VALUES (?, ?, ?)", doc, seq, update);
		entry.pending.push(update);
		entry.tailRows += 1;
		entry.tailBytes += update.length;
		this.resize(entry, entry.bytes + update.length);
		this.evict(doc);
		if (entry.tailRows >= this.compactAfterRows || entry.tailBytes >= this.compactAfterBytes) {
			this.compact(doc);
			return true;
		}
		return false;
	}

	/** Folds the tail into the state parts. */
	compact(doc: string): void {
		const merged = this.state(doc);
		const entry = this.load(doc);
		this.transaction(() => {
			this.run("DELETE FROM doc_state WHERE doc = ?", doc);
			for (let part = 0, offset = 0; offset < merged.length; part++, offset += this.partBytes) {
				this.run(
					"INSERT INTO doc_state (doc, part, data) VALUES (?, ?, ?)",
					doc,
					part,
					merged.subarray(offset, offset + this.partBytes),
				);
			}
			this.run("DELETE FROM doc_updates WHERE doc = ?", doc);
		});
		entry.tailRows = 0;
		entry.tailBytes = 0;
		this.compactions += 1;
	}

	/** Answers a client SyncStep1: the server's state vector and the diff the client lacks. */
	syncReply(
		doc: string,
		clientStateVector: Uint8Array,
	): { stateVector: Uint8Array; diff: Uint8Array } {
		const state = this.state(doc);
		return {
			stateVector: Y.encodeStateVectorFromUpdate(state),
			diff: Y.diffUpdate(state, clientStateVector),
		};
	}
}
