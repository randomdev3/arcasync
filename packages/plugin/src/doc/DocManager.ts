import type { IDocManager, NoteDocHandle } from "../workspace/types";
import {
	DISK_ORIGIN,
	ENROLL_ORIGIN,
	type ReconcileDeps,
	type ReconcileResult,
	reconcileNote,
} from "./enroll";
import { NoteDoc, type NoteDocDeps } from "./NoteDoc";

export interface DocManagerOptions {
	note: NoteDocDeps;
	reconcile: ReconcileDeps;
	/** Watches an attached note for docRevs bumps; returns the unwatch function. */
	track(note: NoteDoc): () => void;
	/** Current vault path of a note, from the index; null when it is no longer indexed. */
	pathOf(fileId: string): string | null;
	/** Released docs kept attached (`limits().warmDocs`). */
	warmDocs: number;
	/** Debounce between a doc change and its write to disk while no editor is bound. */
	flushDelayMs?: number;
	/** Opens a note doc; tests inject a fake. */
	openNote?: (fileId: string, path: string, deps: NoteDocDeps) => Promise<NoteDoc>;
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
}

const RECONCILE_ATTEMPTS = 3;

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
	private destroyed = false;

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

	/** An attached note, if any (no refcount taken). */
	peek(fileId: string): Promise<NoteDoc> | null {
		return this.entries.get(fileId)?.note ?? null;
	}

	/** Reconciles a note's disk file and doc; serialised per note. */
	reconcile(note: NoteDoc): Promise<ReconcileResult> {
		const entry = this.entries.get(note.fileId);
		const run = async (): Promise<ReconcileResult> => {
			let result: ReconcileResult = { action: "missing" };
			for (let i = 0; i < RECONCILE_ATTEMPTS && note.state !== "closed"; i++) {
				const path = this.options.pathOf(note.fileId) ?? note.path;
				note.path = path;
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
		};
		entry.note = openNote(fileId, path, this.options.note).then((note) => {
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
			this.reconcile(note).catch((error) =>
				console.error(`[TeamSync] writing ${note.path} failed`, error),
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
		this.unwarm(fileId);
		entry.note.then(
			(note) => {
				for (const fn of entry.dispose) fn();
				entry.dispose.length = 0;
				note.close();
			},
			() => undefined,
		);
	}

	private unwarm(fileId: string): void {
		const i = this.warm.indexOf(fileId);
		if (i >= 0) this.warm.splice(i, 1);
	}
}
