import { BULK_CLONE_MIN_DOCS, CLONE_MAX_DOCS, type DocRev } from "@teamsync/shared";
import type * as Y from "yjs";
import type { DocManager } from "./DocManager";
import { diskText } from "./diskText";
import type { NoteIndex } from "./noteIndex";
import type { RevTracker } from "./RevTracker";

/** Bulk clone of note docs by file id (`CloneClient` over `POST /api/workspaces/:id/docs`). */
export interface CloneSource {
	clone(docs: Array<{ fileId: string; sv?: Uint8Array }>): Promise<{
		entries: Array<{ fileId: string; update: Uint8Array }>;
		/** File ids that did not fit in the response. */
		remaining: string[];
	}>;
}

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
	/** Bulk clone (`features.bulkClone`); without it every note takes the attach path. */
	clone?: CloneSource | null;
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
 *
 * Bulk clone (P2-12): while at least `BULK_CLONE_MIN_DOCS` queued notes are only behind (a changed
 * rev, no local changes, not attached), up to `CLONE_MAX_DOCS` of them are fetched in one request
 * and hydrated without a provider (`DocManager.hydrate`). The rev read before the request is the
 * one recorded. A note the hydrate cannot finish (it would change the doc, the file is missing,
 * or it became attached) goes through the attach path instead.
 */
export class BackgroundSync {
	private readonly queue = new Set<string>();
	private readonly running = new Set<string>();
	private readonly again = new Set<string>();
	/** Queued notes that must take the attach path (not bulk clone). */
	private readonly attachOnly = new Set<string>();
	/** Notes in the bulk clone running now (also in `running`). */
	private readonly cloningIds = new Set<string>();
	private readonly idleWaiters: Array<() => void> = [];
	private readonly cleanup: Array<() => void> = [];
	private disposed = false;
	private cloning = false;
	private pumpScheduled = false;

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
		// After the current task: one index transaction enqueues many notes, and the bulk clone
		// threshold must see all of them.
		if (this.pumpScheduled) return;
		this.pumpScheduled = true;
		queueMicrotask(() => {
			this.pumpScheduled = false;
			this.pump();
		});
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
		this.startClone();
		let attaching = [...this.running].filter((id) => !this.cloningIds.has(id)).length;
		for (const fileId of this.queue) {
			if (attaching >= this.options.concurrency) return;
			attaching++;
			this.queue.delete(fileId);
			this.running.add(fileId);
			void this.run(fileId).finally(() => {
				this.running.delete(fileId);
				this.attachOnly.delete(fileId);
				if (this.again.delete(fileId)) this.queue.add(fileId);
				this.pump();
				this.checkIdle();
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

	private checkIdle(): void {
		if (this.queue.size > 0 || this.running.size > 0) return;
		for (const resolve of this.idleWaiters.splice(0)) resolve();
	}

	/** Starts a bulk clone when enough queued notes are only behind; one at a time. */
	private startClone(): void {
		const { clone, revTracker, docs } = this.options;
		if (!clone || this.cloning) return;
		const picked: string[] = [];
		for (const fileId of this.queue) {
			if (picked.length >= CLONE_MAX_DOCS) break;
			if (this.attachOnly.has(fileId) || docs.peek(fileId)) continue;
			if (!revTracker.isChanged(fileId) || revTracker.isDirty(fileId)) continue;
			picked.push(fileId);
		}
		if (picked.length < BULK_CLONE_MIN_DOCS) return;
		this.cloning = true;
		for (const fileId of picked) {
			this.queue.delete(fileId);
			this.running.add(fileId);
			this.cloningIds.add(fileId);
		}
		void this.runClone(clone, picked)
			.catch((error: unknown) => {
				if (!this.disposed) console.error("[TeamSync] bulk clone failed", error);
				for (const fileId of picked) this.attachOnly.add(fileId);
				return picked;
			})
			.then((requeue) => {
				this.cloning = false;
				for (const fileId of picked) {
					this.running.delete(fileId);
					this.cloningIds.delete(fileId);
					if (this.again.delete(fileId)) this.queue.add(fileId);
				}
				if (!this.disposed) for (const fileId of requeue) this.queue.add(fileId);
				this.pump();
				this.checkIdle();
			});
	}

	/** One bulk clone request and its hydrates; returns the notes to queue again. */
	private async runClone(clone: CloneSource, fileIds: string[]): Promise<string[]> {
		const { docs, revTracker, index } = this.options;
		await this.options.settled?.();
		const revs = new Map<string, DocRev | null>();
		const items: Array<{ fileId: string; sv?: Uint8Array }> = [];
		for (const fileId of fileIds) {
			const rev = revTracker.rev(fileId);
			const path = index.pathOf(fileId);
			if (!path) continue;
			if (docs.exceedsLimit(fileId, path)) {
				revTracker.markSynced(fileId, rev);
				continue;
			}
			// Read before the request: a bump that lands during it must stay "changed".
			revs.set(fileId, rev);
			// A device that never synced the note has nothing in IndexedDB to diff against.
			const sv = revTracker.isKnown(fileId) ? await docs.stateVector(fileId) : undefined;
			items.push(sv ? { fileId, sv } : { fileId });
		}
		if (items.length === 0) return [];
		let result: Awaited<ReturnType<CloneSource["clone"]>>;
		try {
			result = await clone.clone(items);
		} catch (error) {
			// Retrying would spend another rate-limit token; the attach path needs none.
			console.warn("[TeamSync] bulk clone request failed; catching up note by note", error);
			for (const { fileId } of items) this.attachOnly.add(fileId);
			return items.map((i) => i.fileId);
		}

		const requeue: string[] = [];
		const toAttach = (fileId: string) => {
			this.attachOnly.add(fileId);
			requeue.push(fileId);
		};
		const answered = new Set<string>(result.remaining);
		requeue.push(...result.remaining);
		for (const { fileId, update } of result.entries) {
			answered.add(fileId);
			const path = index.pathOf(fileId);
			if (this.disposed || !path || !revs.has(fileId)) continue;
			const outcome = await docs.hydrate(fileId, path, update).catch((error: unknown) => {
				console.error(`[TeamSync] hydrating ${path} failed`, error);
				return null;
			});
			if (!outcome || outcome.retry || outcome.action === "defer" || outcome.action === "missing") {
				toAttach(fileId);
				continue;
			}
			revTracker.markSynced(fileId, revs.get(fileId) ?? null);
			if (revTracker.isChanged(fileId)) requeue.push(fileId);
		}
		for (const { fileId } of items) if (!answered.has(fileId)) toAttach(fileId);
		return requeue;
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
