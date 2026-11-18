import type * as Y from "yjs";
import type { DocManager } from "./DocManager";
import { diskText } from "./diskText";
import type { NoteIndex } from "./noteIndex";
import type { RevTracker } from "./RevTracker";

export interface BackgroundSyncOptions {
	docs: DocManager;
	revTracker: RevTracker;
	/** The index doc's `docRevs` map. */
	revs: Y.Map<unknown>;
	index: NoteIndex;
	readDisk(path: string): Promise<string | null>;
	concurrency: number;
	/** Socket connected and the index synced; rev catch-up only runs then. */
	isOnline(): boolean;
	/**
	 * Resolves once index sync has applied queued index ↔ disk work (`session.settled()`), so a
	 * job never looks for a remotely created file before it exists.
	 */
	settled?: () => Promise<void>;
}

/**
 * Keeps closed notes current on disk and gets local notes into the CRDT:
 * - a changed `docRevs` entry (or one changed while this device was away) → attach the note,
 *   wait for the server state, reconcile it to disk, record the rev read before attaching;
 * - an indexed note that has text on disk but no rev and was never seen here → attach it so
 *   reconcile enrolls the disk text;
 * - a note with local changes not yet announced (`RevTracker.dirty()`) → attach it so the
 *   handshake sends them and the bump follows.
 * At most `concurrency` notes are processed at once. A rev that changes during its job is
 * queued again. A note over the device's size limit (`DocManager.exceedsLimit`, or found too
 * large once attached) is skipped and its rev recorded, so it is not attached again until the
 * next change.
 */
export class BackgroundSync {
	private readonly queue = new Set<string>();
	private readonly running = new Set<string>();
	private readonly again = new Set<string>();
	private readonly idleWaiters: Array<() => void> = [];
	private readonly cleanup: Array<() => void> = [];
	private disposed = false;

	constructor(private readonly options: BackgroundSyncOptions) {}

	start(): void {
		const { revs, index } = this.options;
		const onRevs = (event: Y.YMapEvent<unknown>) => {
			for (const fileId of event.keysChanged) {
				if (this.options.revTracker.isChanged(fileId)) this.enqueue(fileId);
			}
		};
		revs.observe(onRevs);
		this.cleanup.push(() => revs.unobserve(onRevs));
		// A note entering the index (local add, remote add, move): catch up if its rev is ahead
		// (the bump may have arrived before the entry), else enroll it if its file has text.
		this.cleanup.push(
			index.observe((notes) => {
				const enroll = notes.filter(({ fileId }) => {
					if (!this.options.revTracker.isChanged(fileId)) return true;
					this.enqueue(fileId);
					return false;
				});
				void this.queueEnrollments(enroll);
			}),
		);
	}

	/** Queues everything that may be behind; call when the index has (re)synced. */
	catchUp(): void {
		const { revTracker, index } = this.options;
		for (const fileId of revTracker.changed()) this.enqueue(fileId);
		for (const fileId of revTracker.dirty()) this.enqueue(fileId);
		void this.queueEnrollments(index.notes());
	}

	enqueue(fileId: string): void {
		if (this.disposed) return;
		if (this.running.has(fileId)) this.again.add(fileId);
		else this.queue.add(fileId);
		this.pump();
	}

	/**
	 * A user (not TeamSync) changed a note's file. An open editor owns the buffer and its saves,
	 * so only a closed note is reconciled. Not gated on the socket: reconcile is safe offline.
	 */
	async onDiskModify(fileId: string): Promise<void> {
		const { docs, index } = this.options;
		const attached = await docs.peek(fileId)?.catch(() => null);
		if (attached?.editorBound) {
			// The editor saved its buffer: record that disk and doc agree, so a later reconcile
			// does not mistake the save for an offline edit.
			await docs.noteEditorSave(attached);
			return;
		}
		const path = index.pathOf(fileId);
		if (!path || docs.exceedsLimit(fileId, path)) return;
		const note = await docs.acquire(fileId, path);
		try {
			await note.whenReady();
			if (!note.editorBound) await docs.reconcile(note);
		} finally {
			docs.release(note);
		}
	}

	/** Resolves once nothing is queued or running. */
	idle(): Promise<void> {
		if (this.queue.size === 0 && this.running.size === 0) return Promise.resolve();
		return new Promise((resolve) => this.idleWaiters.push(resolve));
	}

	/** Re-checks the queue, e.g. after the socket came back. */
	pump(): void {
		if (this.disposed || !this.options.isOnline()) return;
		for (const fileId of this.queue) {
			if (this.running.size >= this.options.concurrency) return;
			this.queue.delete(fileId);
			this.running.add(fileId);
			void this.run(fileId).finally(() => {
				this.running.delete(fileId);
				if (this.again.delete(fileId)) this.queue.add(fileId);
				this.pump();
				if (this.queue.size === 0 && this.running.size === 0) {
					for (const resolve of this.idleWaiters.splice(0)) resolve();
				}
			});
		}
	}

	dispose(): void {
		this.disposed = true;
		for (const fn of this.cleanup.splice(0)) fn();
		this.queue.clear();
		this.again.clear();
		for (const resolve of this.idleWaiters.splice(0)) resolve();
	}

	private async run(fileId: string): Promise<void> {
		const { docs, revTracker, index } = this.options;
		await this.options.settled?.();
		const rev = revTracker.rev(fileId);
		const path = index.pathOf(fileId);
		if (!path) return;
		if (docs.exceedsLimit(fileId, path)) {
			revTracker.markSynced(fileId, rev);
			return;
		}
		try {
			const note = await docs.acquire(fileId, path);
			try {
				await note.whenReady();
				// A warm note's first-open readiness says nothing about now: after a reconnect it may
				// not have the server state yet, and marking the rev synced would skip it for good.
				await note.whenSynced();
				if (!note.synced) return;
				if (!note.editorBound) {
					const result = await docs.reconcile(note);
					if (result.action === "defer" || result.action === "missing" || result.retry) return;
				}
				revTracker.markSynced(fileId, rev);
			} finally {
				docs.release(note);
			}
		} catch (error) {
			if (!this.disposed) console.error(`[TeamSync] background sync of ${path} failed`, error);
			return;
		}
		const now = revTracker.rev(fileId);
		if (now && (now.at !== rev?.at || now.by !== rev?.by)) this.again.add(fileId);
	}

	/** Notes with text on disk that the CRDT has never seen: no rev anywhere, unknown here. */
	private async queueEnrollments(notes: Array<{ fileId: string; path: string }>): Promise<void> {
		const { revTracker, readDisk } = this.options;
		for (const { fileId, path } of notes) {
			if (revTracker.rev(fileId) || revTracker.isKnown(fileId)) continue;
			if (this.options.docs.exceedsLimit(fileId, path)) continue;
			const raw = await readDisk(path);
			if (raw !== null && diskText(raw) !== "") this.enqueue(fileId);
		}
	}
}
