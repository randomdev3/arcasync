import type { FileMeta } from "@arcasync/shared";
import type { BinaryOutcome } from "../files/FileSyncer";
import type { IndexDelta, IndexStore } from "./IndexStore";
import { newFileId } from "./ids";
import type { KnownStore, LocalFiles } from "./LocalFiles";
import { syncKind } from "./paths";

/** Content sync of binary files (`FileSyncer`); paths stay with the Reconciler. */
export interface BinarySync {
	/** Upload or download so the file at `path` and `meta` (null: not indexed yet, new id `id`) agree. */
	sync(path: string, id: string, meta: FileMeta | null): Promise<BinaryOutcome>;
	/** `meta`, returned by an upload, is now in the index. */
	indexed(path: string, meta: FileMeta): void;
	/** Paths whose download waits for a chunk; retried on every remote index change. */
	waiting(): string[];
	/** Forget local state of files that are no longer indexed. */
	prune(ids: Set<string>): void;
}

export interface ReconcilerOptions {
	index: IndexStore;
	files: LocalFiles;
	known: KnownStore;
	userId: string;
	/** The index provider finished its sync handshake: a missing index entry really is missing. */
	isSynced(): boolean;
	/** The relay has acknowledged every local index change. */
	isAcked(): boolean;
	/** Binary content sync; without it (no chunk storage) binaries are ignored as in P1. */
	binaries?: BinarySync | null;
	now?: () => number;
	newId?: () => string;
}

/**
 * Keeps the shared folder's notes and the index `files` map in step.
 *
 * - `run()` (after every index sync) settles disk vs index using `known`, the last index state
 *   the relay acknowledged intersected with disk:
 *
 *   | disk | index | known | action                                     |
 *   |------|-------|-------|--------------------------------------------|
 *   | yes  | no    | no    | add to index                               |
 *   | yes  | no    | yes   | removed remotely: trash locally            |
 *   | no   | yes   | yes   | deleted locally while offline: drop index  |
 *   | no   | yes   | no    | created remotely: create locally           |
 *
 *   A known id now indexed under another path is a remote rename and is renamed locally.
 * - `applyRemote()` mirrors remote index transactions onto disk once the first run is done.
 * - `local*()` mirror vault events into the index once the first run is done; before that the
 *   run itself picks the changes up from disk.
 *
 * Conflict rules, each a pure function of the merged map so every device reaches the same state:
 * - Two ids on one path: the lexicographically lower id keeps the path; the device holding the
 *   other id renames its file to `name (2).md` and re-adds it there.
 * - One id on two paths: the entry with the newer `updatedAt` (then the lower path) wins.
 *
 * Everything runs on one serial queue, and every index write is skipped when it would not
 * change the stored value, so a settled state produces no updates.
 *
 * Binaries (with `binaries`) follow the same path rules; their content goes through `BinarySync`
 * off the queue. A new or changed binary is indexed only once its upload returns, and a remote
 * binary is downloaded instead of created empty. A changed `hash` on the same id downloads.
 */
export class Reconciler {
	private readonly index: IndexStore;
	private readonly files: LocalFiles;
	private readonly known: KnownStore;
	private readonly options: ReconcilerOptions;
	private readonly binaries: BinarySync | null;
	private readonly now: () => number;
	private readonly newId: () => string;
	private tail: Promise<void> = Promise.resolve();
	private disposed = false;
	private settled = false;

	constructor(options: ReconcilerOptions) {
		this.options = options;
		this.index = options.index;
		this.files = options.files;
		this.known = options.known;
		this.binaries = options.binaries ?? null;
		this.now = options.now ?? Date.now;
		this.newId = options.newId ?? newFileId;
	}

	/** True after the first `run()` against a synced index. */
	get ready(): boolean {
		return this.settled;
	}

	run(): Promise<void> {
		return this.enqueue("reconcile", () => this.reconcile());
	}

	applyRemote(delta: IndexDelta): Promise<void> {
		return this.enqueue("remote apply", () => this.apply(delta));
	}

	localCreate(path: string): Promise<void> {
		return this.enqueue("local create", async () => {
			if (!this.settled || !this.files.exists(path)) return;
			const meta = this.index.get(path);
			if (!meta) this.addLocal(path, this.newId());
			else if (this.isBinary(meta)) this.syncBinary(path, meta.id, meta);
			this.remember();
		});
	}

	/** A user changed a binary's bytes: upload (notes change through their doc instead). */
	localModify(path: string): Promise<void> {
		return this.enqueue("local modify", async () => {
			if (!this.settled || this.kindOf(path) !== "binary" || !this.files.exists(path)) return;
			const meta = this.index.get(path);
			if (meta && !this.isBinary(meta)) return;
			this.syncBinary(path, meta?.id ?? this.newId(), meta);
		});
	}

	localDelete(path: string): Promise<void> {
		return this.enqueue("local delete", async () => {
			if (!this.settled || this.files.exists(path)) return;
			this.index.delete(path);
			this.remember();
		});
	}

	localRename(from: string, to: string): Promise<void> {
		return this.enqueue("local rename", async () => {
			if (!this.settled) return;
			const meta = this.index.get(from);
			const kind = this.kindOf(to);
			if (meta && meta.kind === kind) {
				const moved = this.touch(meta);
				this.index.move(from, to, moved);
				// Renaming costs no upload; a rename of a file edited offline still syncs its bytes.
				if (this.isBinary(moved)) this.syncBinary(to, moved.id, moved);
			} else {
				// A new kind (`a.md` → `a.png`) is a delete plus a new file.
				if (meta) this.index.delete(from);
				if (kind && !this.index.has(to)) this.addLocal(to, this.newId());
			}
			this.remember();
		});
	}

	/** Record `known` now if the relay has acked everything (call when unsynced changes hit 0). */
	checkpoint(): Promise<void> {
		return this.enqueue("checkpoint", async () => this.remember());
	}

	/** Resolves when every queued task has finished. */
	idle(): Promise<void> {
		return this.tail;
	}

	dispose(): void {
		this.disposed = true;
	}

	private enqueue(label: string, task: () => Promise<void>): Promise<void> {
		const next = this.tail.then(async () => {
			if (this.disposed) return;
			try {
				await task();
			} catch (error) {
				console.error(`[TeamSync] ${label} failed`, error);
			}
		});
		this.tail = next;
		return next;
	}

	private async reconcile(): Promise<void> {
		if (!this.options.isSynced()) return;
		const known = this.known.load();
		await this.dedupe();

		const indexed = new Map(this.index.entries().map((e) => [e.path, e.meta]));
		const knownPathOf = new Map(Object.entries(known).map(([path, id]) => [id, path]));

		// A known file whose id now lives at another path was renamed elsewhere.
		for (const [path, meta] of indexed) {
			if (!this.handles(meta) || this.files.exists(path)) continue;
			const from = knownPathOf.get(meta.id);
			if (from && from !== path && this.files.exists(from) && !indexed.has(from)) {
				await this.attempt(() => this.files.rename(from, path));
			}
		}

		for (const path of this.files.list()) {
			if (!this.kindOf(path)) continue;
			const meta = indexed.get(path);
			const knownId = known[path];
			if (meta) {
				if (knownId && knownId !== meta.id) await this.collide(path, meta, knownId);
				else if (this.isBinary(meta)) this.syncBinary(path, meta.id, meta);
			} else if (knownId) {
				await this.attempt(() => this.files.trash(path));
			} else {
				this.addLocal(path, this.newId());
			}
		}

		for (const [path, meta] of indexed) {
			if (!this.handles(meta)) continue;
			if (this.files.exists(path) || this.index.get(path)?.id !== meta.id) continue;
			if (known[path] === meta.id) this.index.delete(path);
			else await this.fetch(path, meta);
		}

		this.settled = true;
		this.remember();
		this.binaries?.prune(new Set(this.index.entries().map((e) => e.meta.id)));
	}

	private async apply(delta: IndexDelta): Promise<void> {
		// Until the first run, the run itself compares the whole index with disk.
		if (!this.settled) return;
		// First, so a duplicate created by this delta resolves as a local rename.
		await this.dedupe();
		for (const { from, to, meta } of delta.moved) {
			if (!this.handles(meta)) continue;
			if (this.index.get(to)?.id !== meta.id || this.files.exists(to)) continue;
			if (this.files.exists(from) && !this.index.has(from)) {
				await this.attempt(() => this.files.rename(from, to));
				if (this.isBinary(meta)) this.syncBinary(to, meta.id, meta);
			} else {
				await this.fetch(to, meta);
			}
		}
		for (const { path, meta } of delta.added) {
			if (!this.handles(meta) || this.index.get(path)?.id !== meta.id) continue;
			// A local binary already there (a racing create) is compared, and kept aside if it differs.
			if (this.files.exists(path)) {
				if (this.isBinary(meta)) this.syncBinary(path, meta.id, meta);
				continue;
			}
			await this.fetch(path, meta);
		}
		for (const { path, meta, old } of delta.changed) {
			if (!this.handles(meta) || this.index.get(path)?.id !== meta.id) continue;
			if (old.id === meta.id) {
				if (this.isBinary(meta) && old.hash !== meta.hash) this.syncBinary(path, meta.id, meta);
				continue;
			}
			if (this.files.exists(path)) await this.collide(path, meta, old.id);
		}
		for (const { path, meta } of delta.removed) {
			// A delete seen mid-handshake waits for the next run, which needs a synced index.
			if (!this.handles(meta) || !this.options.isSynced()) continue;
			if (this.index.has(path) || !this.files.exists(path)) continue;
			await this.attempt(() => this.files.trash(path));
		}
		for (const path of this.binaries?.waiting() ?? []) {
			const meta = this.index.get(path);
			if (meta && this.isBinary(meta)) this.syncBinary(path, meta.id, meta);
		}
		this.remember();
	}

	/** The local file at `path` holds `ownId`, but the index says `meta.id`. Lower id wins. */
	private async collide(path: string, meta: FileMeta, ownId: string): Promise<void> {
		if (ownId < meta.id) {
			if (this.isBinary(meta)) this.syncBinary(path, ownId, null);
			else this.index.set(path, this.meta(ownId));
			return;
		}
		const to = this.freePath(path);
		await this.attempt(async () => {
			await this.files.rename(path, to);
			this.addLocal(to, ownId);
			await this.fetch(path, meta);
		});
	}

	/** A local file not in the index: a note is indexed now, a binary once it is uploaded. */
	private addLocal(path: string, id: string): void {
		const kind = this.kindOf(path);
		if (kind === "binary") this.syncBinary(path, id, null);
		else if (kind === "md") this.index.set(path, this.meta(id));
	}

	/** An indexed file missing here: an empty note (its text comes from the doc), or a download. */
	private async fetch(path: string, meta: FileMeta): Promise<void> {
		if (this.isBinary(meta)) this.syncBinary(path, meta.id, meta);
		else await this.attempt(() => this.files.create(path));
	}

	/** Runs a binary sync off the queue; what it asks of the index comes back onto the queue. */
	private syncBinary(path: string, id: string, meta: FileMeta | null): void {
		const binaries = this.binaries;
		if (!binaries) return;
		void binaries.sync(path, id, meta).then((outcome) => {
			if (!outcome.index && !outcome.aside) return;
			return this.enqueue("binary sync", async () => {
				if (outcome.aside) this.addLocal(outcome.aside, this.newId());
				if (outcome.index) this.indexUpload(path, id, outcome.index);
			});
		});
	}

	/** Indexes an upload, unless the file moved or another id took its path meanwhile. */
	private indexUpload(path: string, id: string, meta: FileMeta): void {
		if (!this.settled || !this.files.exists(path)) return;
		const current = this.index.get(path);
		if (current && current.id !== id) return;
		this.index.set(path, meta);
		this.binaries?.indexed(path, meta);
		this.remember();
	}

	/** Which sync a local path gets on this device; null when it is not synced here. */
	private kindOf(path: string): "md" | "binary" | null {
		const kind = syncKind(path);
		return kind === "binary" && !this.binaries ? null : kind;
	}

	/** True for index entries this device syncs. */
	private handles(meta: FileMeta): boolean {
		return meta.kind === "md" || this.isBinary(meta);
	}

	private isBinary(meta: FileMeta): boolean {
		return meta.kind === "binary" && this.binaries !== null;
	}

	/** One id under several paths (a rename raced another write): keep one, fold the others. */
	private async dedupe(): Promise<void> {
		const byId = new Map<string, { path: string; meta: FileMeta }[]>();
		for (const e of this.index.entries()) {
			const list = byId.get(e.meta.id) ?? [];
			list.push(e);
			byId.set(e.meta.id, list);
		}
		for (const list of byId.values()) {
			if (list.length < 2) continue;
			list.sort(
				(a, b) =>
					b.meta.updatedAt - a.meta.updatedAt || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0),
			);
			const [first, ...losers] = list;
			if (!first) continue;
			const winner = first.path;
			for (const { path } of losers) {
				this.index.delete(path);
				if (!this.files.exists(path)) continue;
				if (this.files.exists(winner)) await this.attempt(() => this.files.trash(path));
				else await this.attempt(() => this.files.rename(path, winner));
			}
		}
	}

	/** `name (2).md`, `name (3).md`, … : the first free on disk and in the index. */
	private freePath(path: string): string {
		const dot = path.lastIndexOf(".");
		const slash = path.lastIndexOf("/");
		const [stem, ext] = dot > slash ? [path.slice(0, dot), path.slice(dot)] : [path, ""];
		for (let n = 2; ; n++) {
			const candidate = `${stem} (${n})${ext}`;
			if (!this.files.exists(candidate) && !this.index.has(candidate)) return candidate;
		}
	}

	private meta(id: string): FileMeta {
		return { id, kind: "md", updatedBy: this.options.userId, updatedAt: this.now() };
	}

	/** `meta` re-asserted by this user now; a binary keeps its content fields. */
	private touch(meta: FileMeta): FileMeta {
		if (meta.kind !== "binary") return this.meta(meta.id);
		return { ...meta, updatedBy: this.options.userId, updatedAt: this.now() };
	}

	/** Snapshot `known` = index ∩ disk, but only when the relay holds everything we wrote. */
	private remember(): void {
		if (!this.options.isSynced() || !this.options.isAcked()) return;
		const known: Record<string, string> = {};
		for (const { path, meta } of this.index.entries()) {
			if (this.files.exists(path)) known[path] = meta.id;
		}
		this.known.save(known);
	}

	/** A failed file operation must not stop the rest of a run; the next run retries it. */
	private async attempt(op: () => Promise<void>): Promise<void> {
		try {
			await op();
		} catch (error) {
			console.error("[TeamSync] vault operation failed", error);
		}
	}
}
