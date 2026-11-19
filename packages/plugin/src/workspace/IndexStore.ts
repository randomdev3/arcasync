import { FileMeta, INDEX_FILES } from "@arcasync/shared";
import type * as Y from "yjs";

export interface IndexEntry {
	path: string;
	meta: FileMeta;
}

export interface IndexMove {
	from: string;
	to: string;
	meta: FileMeta;
}

export interface IndexChange {
	path: string;
	meta: FileMeta;
	old: FileMeta;
}

/** One transaction's effect on the file map. Paths are workspace paths. */
export interface IndexDelta {
	added: IndexEntry[];
	removed: IndexEntry[];
	/** A delete plus an add (or overwrite) with the same id in one transaction. */
	moved: IndexMove[];
	/** Same path, new value: a meta edit, or a different id taking over the path. */
	changed: IndexChange[];
}

export type IndexListener = (delta: IndexDelta, local: boolean) => void;

function parse(value: unknown): FileMeta | null {
	const r = FileMeta.safeParse(value);
	return r.success ? r.data : null;
}

function sameMeta(a: FileMeta, b: FileMeta): boolean {
	const keys = new Set([...Object.keys(a), ...Object.keys(b)]) as Set<keyof FileMeta>;
	for (const k of keys) {
		if (JSON.stringify(a[k]) !== JSON.stringify(b[k])) return false;
	}
	return true;
}

/**
 * The index doc's `files` map: workspace path → `FileMeta`, whole-value last-writer-wins per
 * key. Writes that would not change a value are skipped, so callers can re-assert state freely
 * without producing updates (each update is a relay row).
 */
export class IndexStore {
	private readonly map: Y.Map<unknown>;

	constructor(private readonly doc: Y.Doc) {
		this.map = doc.getMap(INDEX_FILES);
	}

	get(path: string): FileMeta | null {
		return parse(this.map.get(path));
	}

	has(path: string): boolean {
		return this.get(path) !== null;
	}

	entries(): IndexEntry[] {
		const out: IndexEntry[] = [];
		for (const [path, value] of this.map.entries()) {
			const meta = parse(value);
			if (meta) out.push({ path, meta });
		}
		return out;
	}

	/** Paths currently holding `id` (more than one only after a concurrent edit). */
	pathsOf(id: string): string[] {
		return this.entries()
			.filter((e) => e.meta.id === id)
			.map((e) => e.path);
	}

	set(path: string, meta: FileMeta): void {
		const current = this.get(path);
		if (current && sameMeta(current, meta)) return;
		this.map.set(path, meta);
	}

	delete(path: string): void {
		if (this.map.has(path)) this.map.delete(path);
	}

	/** Delete `from` and set `to` in one transaction; observers see a `moved`. */
	move(from: string, to: string, meta: FileMeta): void {
		this.doc.transact(() => {
			if (from !== to) this.delete(from);
			this.set(to, meta);
		});
	}

	/** Subscribe to per-transaction deltas; returns the unsubscribe function. */
	observe(listener: IndexListener): () => void {
		const handler = (event: Y.YMapEvent<unknown>, transaction: Y.Transaction) => {
			const delta = toDelta(event, this.map);
			if (
				delta.added.length + delta.removed.length + delta.moved.length + delta.changed.length >
				0
			) {
				listener(delta, transaction.local);
			}
		};
		this.map.observe(handler);
		return () => this.map.unobserve(handler);
	}
}

function toDelta(event: Y.YMapEvent<unknown>, map: Y.Map<unknown>): IndexDelta {
	const added: IndexEntry[] = [];
	const removed: IndexEntry[] = [];
	const changed: IndexChange[] = [];
	for (const [path, change] of event.changes.keys) {
		const old = parse(change.oldValue);
		const meta = parse(map.get(path));
		if (change.action === "delete" || !meta) {
			if (old) removed.push({ path, meta: old });
		} else if (change.action === "add" || !old) {
			added.push({ path, meta });
		} else {
			changed.push({ path, meta, old });
		}
	}

	// Pair each removal with an add (or an overwrite) of the same id elsewhere: that is a move.
	const moved: IndexMove[] = [];
	const unpaired: IndexEntry[] = [];
	for (const r of removed) {
		const a = added.findIndex((e) => e.meta.id === r.meta.id);
		const c = changed.findIndex((e) => e.meta.id === r.meta.id && e.old.id !== r.meta.id);
		const [to] = a >= 0 ? added.splice(a, 1) : c >= 0 ? changed.splice(c, 1) : [];
		if (to) moved.push({ from: r.path, to: to.path, meta: to.meta });
		else unpaired.push(r);
	}
	return { added, removed: unpaired, moved, changed };
}
