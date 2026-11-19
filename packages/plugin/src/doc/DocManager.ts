import * as Y from "yjs";
import type { IDocManager, NoteDocHandle } from "../workspace/types";
import { diskText, textHash, utf8Bytes } from "./diskText";
import {
	CLONE_ORIGIN,
	DISK_ORIGIN,
	ENROLL_ORIGIN,
	type ReconcileDeps,
	type ReconcileResult,
	reconcileNote,
} from "./enroll";
import { LocalNote, NoteDoc, type NoteDocDeps } from "./NoteDoc";

export interface DocManagerOptions {
	note: NoteDocDeps;
	reconcile: ReconcileDeps;
	/** Watches an attached note for docRevs bumps; returns the unwatch function. */
	track(note: NoteDoc): () => void;
	/** Current vault path of a note, from the index; null when it is no longer indexed. */
	pathOf(fileId: string): string | null;
	/** Released docs kept attached (`limits().warmDocs`). */
	warmDocs: number;
	/**
	 * Notes larger than this, on disk or in the doc, are not synced on this device
	 * (`limits().maxMdBytes`; unlimited by default).
	 */
	maxBytes?: number;
	/** Size in bytes of the vault file at `path` (its stat; no read), or null when there is none. */
	sizeOf?(path: string): number | null;
	/** Debounce between a doc change and its write to disk while no editor is bound. */
	flushDelayMs?: number;
	/** How long a closed editor still owns the disk (its last save may be in flight). */
	editorGraceMs?: number;
	/** Opens a note doc; tests inject a fake. */
	openNote?: (fileId: string, path: string, deps: NoteDocDeps) => Promise<NoteDoc>;
}

/** Counters for tests and e2e: provider attaches and provider-less hydrates (bulk clone). */
export interface DocStats {
	attaches: number;
	hydrates: number;
}

interface Entry {
	note: Promise<NoteDoc>;
	refs: number;
	/** Serialises reconciles of this note. */
	lock: Promise<unknown>;
	flushTimer: ReturnType<typeof setTimeout> | null;
	dispose: Array<() => void>;
	evicting: boolean;
	/** Re-checks a waiting eviction (it stops once the doc is acquired again). */
	wake: (() => void) | null;
	/** The note once opened, so closing need not wait a microtask. */
	resolved: NoteDoc | null;
	/** Editors bound to the note (split panes share one doc). */
	editors: number;
	/** Hashes of texts a bound editor held and may still be writing to disk; newest last. */
	editorHashes: string[];
	/** Runs out the editor's ownership of the disk after the last editor let go. */
	graceTimer: ReturnType<typeof setTimeout> | null;
}

const RECONCILE_ATTEMPTS = 3;
const EDITOR_HASHES = 8;
/** Obsidian finishes the save it started for a closing editor well within this. */
const EDITOR_GRACE_MS = 2000;

/**
 * Refcounted, lazily attached note docs. `acquire` opens the doc (IndexedDB, then provider) and
 * its `whenReady` resolves only after the first reconcile of disk and doc, so whoever binds the
 * doc to an editor never sees a doc that has not yet absorbed (or saved aside) the disk text.
 *
 * Released docs stay attached in an LRU of `warmDocs`; an evicted doc is detached once the relay
 * has acked its changes (or the socket is down, the changes then wait in IndexedDB).
 * While no editor is bound, doc changes reach the disk through a debounced reconcile.
 */
export class DocManager implements IDocManager {
	private readonly entries = new Map<string, Entry>();
	/** Released file ids, least recently used first. */
	private readonly warm: string[] = [];
	/** Notes already reported as over `maxBytes`. */
	private readonly warned = new Set<string>();
	/** Hydrates in flight; an `acquire` of the same note waits for its hydrate. */
	private readonly hydrating = new Map<string, Promise<void>>();
	private destroyed = false;
	readonly stats: DocStats = { attaches: 0, hydrates: 0 };

	constructor(private readonly options: DocManagerOptions) {}

	acquire(fileId: string, path: string): Promise<NoteDoc> {
		if (this.destroyed) return Promise.reject(new Error("doc manager is destroyed"));
		let entry = this.entries.get(fileId);
		if (!entry) {
			entry = this.open(fileId, path);
			this.entries.set(fileId, entry);
		}
		entry.refs++;
		entry.evicting = false;
		entry.wake?.();
		this.unwarm(fileId);
		const current = entry;
		return current.note.then(
			(note) => {
				note.path = path;
				return note;
			},
			(error) => {
				if (this.entries.get(fileId) === current) this.entries.delete(fileId);
				throw error;
			},
		);
	}

	release(handle: NoteDocHandle): void {
		const entry = this.entries.get(handle.fileId);
		if (!entry || entry.refs === 0) return;
		entry.refs--;
		if (entry.refs > 0) return;
		this.warm.push(handle.fileId);
		while (this.warm.length > this.options.warmDocs) {
			const oldest = this.warm.shift() as string;
			void this.evict(oldest);
		}
	}

	attachedCount(): number {
		return this.entries.size;
	}

	exceedsLimit(fileId: string, path: string): boolean {
		const max = this.options.maxBytes ?? Number.POSITIVE_INFINITY;
		if (!Number.isFinite(max)) return false;
		const size = this.options.sizeOf?.(path) ?? null;
		if (size === null || size <= max) return false;
		this.warnTooLarge(fileId, path, max);
		return true;
	}

	/** An attached note, if any (no refcount taken). */
	peek(fileId: string): Promise<NoteDoc> | null {
		return this.entries.get(fileId)?.note ?? null;
	}

	/**
	 * Reconciles a note's disk file and doc; serialised per note. With `unlessBound` it defers
	 * when an editor has bound the note by the time it runs (a flush queued just before the bind).
	 */
	reconcile(note: NoteDoc, { unlessBound = false } = {}): Promise<ReconcileResult> {
		const entry = this.entries.get(note.fileId);
		const run = async (): Promise<ReconcileResult> => {
			if (unlessBound && note.editorBound) return { action: "defer" };
			let result: ReconcileResult = { action: "missing" };
			for (let i = 0; i < RECONCILE_ATTEMPTS && note.state !== "closed"; i++) {
				const path = this.options.pathOf(note.fileId) ?? note.path;
				note.path = path;
				// Neither side is touched: no enroll of a large file, no write of a large doc.
				note.tooLarge = this.overLimit(note, path);
				if (note.tooLarge) return { action: "too-large" };
				if (entry) await this.adoptEditorSave(note, entry);
				result = await reconcileNote(note, path, this.options.reconcile);
				if (!result.retry) break;
			}
			return result;
		};
		if (!entry) return run();
		const result = entry.lock.then(run, run);
		entry.lock = result.catch(() => undefined);
		return result;
	}

	/**
	 * An editor shows the note and owns its buffer and disk saves from now on (P1-4). `attach`
	 * runs once no reconcile of the note is running (none can start while it runs) and returns
	 * false when the editor gave up meanwhile; only then is the editor counted as bound.
	 */
	editorAttached(handle: NoteDocHandle, attach: () => boolean): Promise<boolean> {
		const entry = this.entries.get(handle.fileId);
		const note = entry?.resolved;
		if (!entry || !note || note !== handle) return Promise.resolve(false);
		const run = () => {
			if (note.state === "closed" || !attach()) return false;
			entry.editors++;
			note.editorBound = true;
			if (entry.flushTimer) clearTimeout(entry.flushTimer);
			entry.flushTimer = null;
			if (entry.graceTimer) clearTimeout(entry.graceTimer);
			entry.graceTimer = null;
			return true;
		};
		const result = entry.lock.then(run, run);
		entry.lock = result.catch(() => undefined);
		return result;
	}

	/**
	 * An editor bound by `editorAttached` let go of the note. Its buffer mirrored the doc, so the
	 * text it may still save is remembered as synced, and the editor keeps owning the disk for a
	 * short grace period: a save Obsidian started before the switch lands as an editor save, not
	 * as an offline edit. After that, doc changes reach the disk again.
	 */
	editorDetached(handle: NoteDocHandle): void {
		const entry = this.entries.get(handle.fileId);
		const note = entry?.resolved;
		if (!entry || !note || note !== handle || entry.editors === 0) return;
		this.rememberEditorText(entry, note.ytext.toString());
		entry.editors--;
		if (entry.editors > 0) return;
		if (entry.graceTimer) clearTimeout(entry.graceTimer);
		entry.graceTimer = setTimeout(() => {
			entry.graceTimer = null;
			if (entry.editors > 0 || note.state === "closed") return;
			note.editorBound = false;
			this.scheduleFlush(entry, note);
		}, this.options.editorGraceMs ?? EDITOR_GRACE_MS);
	}

	/** An open editor saved its buffer, a mirror of the doc: remember it as synced text. */
	noteEditorSave(note: NoteDoc): Promise<void> {
		const run = async () => {
			const raw = await this.options.reconcile.writer.read(note.path);
			if (raw === null) return;
			const text = diskText(raw);
			const hash = await textHash(text);
			if (entry) remember(entry, hash);
			if (text === note.ytext.toString()) await note.setLastSynced(hash, text);
		};
		const entry = this.entries.get(note.fileId);
		if (!entry) return run();
		const result = entry.lock.then(run, run);
		entry.lock = result.catch(() => undefined);
		return result;
	}

	/**
	 * Bulk clone (P2-12): applies `update` (server state) to the note's IndexedDB copy without a
	 * provider and reconciles the disk to it. Returns null, doing nothing, when the note is
	 * attached (its provider owns it). A reconcile that would change the doc returns `defer`
	 * untouched: only an attached note can send that change.
	 */
	async hydrate(fileId: string, path: string, update: Uint8Array): Promise<ReconcileResult | null> {
		if (this.destroyed || this.entries.has(fileId) || this.hydrating.has(fileId)) return null;
		const run = async (): Promise<ReconcileResult> => {
			const note = await LocalNote.open(fileId, this.options.note);
			try {
				Y.applyUpdate(note.ydoc, update, CLONE_ORIGIN);
				if (this.overLimit({ fileId, ytext: note.ytext }, path)) return { action: "too-large" };
				return await reconcileNote(note, path, this.options.reconcile, { docWrites: false });
			} finally {
				note.close();
			}
		};
		const result = run();
		const done = result.then(
			() => undefined,
			() => undefined,
		);
		this.hydrating.set(fileId, done);
		try {
			const outcome = await result;
			this.stats.hydrates++;
			return outcome;
		} finally {
			if (this.hydrating.get(fileId) === done) this.hydrating.delete(fileId);
		}
	}

	/** State vector of the note's IndexedDB copy (opened and closed again, no provider). */
	async stateVector(fileId: string): Promise<Uint8Array> {
		const note = await LocalNote.open(fileId, this.options.note);
		try {
			return Y.encodeStateVector(note.ydoc);
		} finally {
			note.close();
		}
	}

	/** Detaches everything now. Unacked changes stay in IndexedDB and sync on the next attach. */
	destroy(): void {
		this.destroyed = true;
		this.warm.length = 0;
		for (const [fileId, entry] of this.entries) this.closeEntry(fileId, entry);
		this.entries.clear();
	}

	private open(fileId: string, path: string): Entry {
		const openNote = this.options.openNote ?? NoteDoc.open;
		const entry: Entry = {
			note: Promise.resolve(null as unknown as NoteDoc),
			refs: 0,
			lock: Promise.resolve(),
			flushTimer: null,
			dispose: [],
			evicting: false,
			wake: null,
			resolved: null,
			editors: 0,
			editorHashes: [],
			graceTimer: null,
		};
		const opened = (this.hydrating.get(fileId) ?? Promise.resolve()).then(() => {
			this.stats.attaches++;
			return openNote(fileId, path, this.options.note);
		});
		entry.note = opened.then((note) => {
			entry.resolved = note;
			if (this.entries.get(fileId) !== entry) {
				note.close();
				throw new Error(`note ${fileId} was closed while opening`);
			}
			entry.dispose.push(this.options.track(note));
			const onUpdate = (_update: Uint8Array, origin: unknown) => {
				// Reconcile itself wrote these, and the disk already holds them.
				if (origin === DISK_ORIGIN || origin === ENROLL_ORIGIN) return;
				if (note.editorBound) return;
				this.scheduleFlush(entry, note);
			};
			note.ydoc.on("update", onUpdate);
			entry.dispose.push(() => note.ydoc.off("update", onUpdate));
			note.ready = note.whenSynced().then(async () => {
				await this.reconcile(note);
				if (note.state === "loading") note.state = "ready";
			});
			// `whenReady` is awaited by callers; an unawaited rejection must not surface as unhandled.
			note.ready.catch(() => undefined);
			return note;
		});
		return entry;
	}

	private scheduleFlush(entry: Entry, note: NoteDoc): void {
		if (entry.flushTimer) clearTimeout(entry.flushTimer);
		entry.flushTimer = setTimeout(() => {
			entry.flushTimer = null;
			if (note.state !== "ready" || note.editorBound) return;
			// An editor may bind while this waits for the note's lock; it owns the disk then.
			this.reconcile(note, { unlessBound: true }).catch((error) =>
				console.error(`[ArcaSync] writing ${note.path} failed`, error),
			);
		}, this.options.flushDelayMs ?? 1000);
	}

	private async evict(fileId: string): Promise<void> {
		const entry = this.entries.get(fileId);
		if (!entry || entry.refs > 0) return;
		entry.evicting = true;
		let note: NoteDoc;
		try {
			note = await entry.note;
		} catch {
			return;
		}
		if (entry.flushTimer) {
			clearTimeout(entry.flushTimer);
			entry.flushTimer = null;
			await this.reconcile(note).catch(() => undefined);
		}
		await entry.lock;
		await this.untilAcked(note, entry);
		if (!entry.evicting || entry.refs > 0 || this.entries.get(fileId) !== entry) return;
		if (entry.flushTimer) {
			// A remote change arrived while waiting: write it before detaching.
			clearTimeout(entry.flushTimer);
			entry.flushTimer = null;
			await this.reconcile(note).catch(() => undefined);
			if (!entry.evicting || entry.refs > 0 || this.entries.get(fileId) !== entry) return;
		}
		this.entries.delete(fileId);
		this.closeEntry(fileId, entry);
	}

	/** Resolves when the relay has acked the note's changes, the socket is down, or eviction is off. */
	private untilAcked(note: NoteDoc, entry: Entry): Promise<void> {
		return new Promise((resolve) => {
			let settled = false;
			let offConnection: (() => void) | null = null;
			const check = () => {
				if (settled) return;
				settled =
					!note.provider.hasUnsyncedChanges ||
					note.readonly ||
					this.options.note.isOffline() ||
					note.state === "closed" ||
					!entry.evicting ||
					entry.refs > 0;
				if (!settled) return;
				offConnection?.();
				note.provider.off("unsyncedChanges", check);
				entry.wake = null;
				resolve();
			};
			note.provider.on("unsyncedChanges", check);
			entry.wake = check;
			// `onStateChange` calls the listener right away, possibly settling before it returns.
			offConnection = this.options.note.onConnectionChange(check);
			if (settled) offConnection();
			check();
		});
	}

	private closeEntry(fileId: string, entry: Entry): void {
		if (entry.flushTimer) clearTimeout(entry.flushTimer);
		entry.flushTimer = null;
		if (entry.graceTimer) clearTimeout(entry.graceTimer);
		entry.graceTimer = null;
		this.unwarm(fileId);
		const close = (note: NoteDoc) => {
			for (const fn of entry.dispose) fn();
			entry.dispose.length = 0;
			note.close();
		};
		// Synchronously when possible: the session stops its notes before the socket goes away.
		if (entry.resolved) close(entry.resolved);
		else entry.note.then(close, () => undefined);
	}

	/** The note's file or doc is over `maxBytes`; a UTF-8 count only when the length allows it. */
	private overLimit(note: { fileId: string; ytext: Y.Text }, path: string): boolean {
		const max = this.options.maxBytes ?? Number.POSITIVE_INFINITY;
		if (!Number.isFinite(max)) return false;
		if (this.exceedsLimit(note.fileId, path)) return true;
		// A UTF-16 code unit is at most 3 UTF-8 bytes.
		if (note.ytext.length * 3 <= max || utf8Bytes(note.ytext.toString()) <= max) return false;
		this.warnTooLarge(note.fileId, path, max);
		return true;
	}

	private warnTooLarge(fileId: string, path: string, max: number): void {
		if (this.warned.has(fileId)) return;
		this.warned.add(fileId);
		const limit = `${Math.round((max / 1048576) * 10) / 10} MiB`;
		console.warn(`[ArcaSync] ${path} is over ${limit}; it is not synced on this device`);
		this.options.reconcile.notify?.(
			`ArcaSync: ${path} is larger than ${limit} and is not synced on this device.`,
		);
	}

	/** Hashed on the entry's lock, so a reconcile queued after this call sees it. */
	private rememberEditorText(entry: Entry, text: string): void {
		const run = async () => remember(entry, await textHash(text));
		entry.lock = entry.lock.then(run, run).catch(() => undefined);
	}

	/**
	 * A disk text a bound editor wrote is a snapshot of the doc, so the doc's later changes win
	 * over it: record it as synced before reconciling, or a save that lands after the editor
	 * let go would look like an offline edit (a local copy, or a revert of newer remote text).
	 */
	private async adoptEditorSave(note: NoteDoc, entry: Entry): Promise<void> {
		if (entry.editorHashes.length === 0) return;
		const raw = await this.options.reconcile.writer.read(note.path);
		if (raw === null) return;
		const text = diskText(raw);
		const hash = await textHash(text);
		if (entry.editorHashes.includes(hash) && (await note.getLastSyncedHash()) !== hash) {
			await note.setLastSynced(hash, text);
		}
		// Past the grace period every late editor save has landed; a later match is a real edit.
		if (entry.editors === 0 && !entry.graceTimer) entry.editorHashes.length = 0;
	}

	private unwarm(fileId: string): void {
		const i = this.warm.indexOf(fileId);
		if (i >= 0) this.warm.splice(i, 1);
	}
}

function remember(entry: Entry, hash: string): void {
	const i = entry.editorHashes.indexOf(hash);
	if (i >= 0) entry.editorHashes.splice(i, 1);
	entry.editorHashes.push(hash);
	if (entry.editorHashes.length > EDITOR_HASHES) entry.editorHashes.shift();
}
