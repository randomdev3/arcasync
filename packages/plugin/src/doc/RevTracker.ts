import { DocRev } from "@teamsync/shared";
import type * as Y from "yjs";

/** The localStorage subset RevTracker uses. */
export interface KeyValueStore {
	getItem(key: string): string | null;
	setItem(key: string, value: string): void;
}

/** What RevTracker watches on an attached note. */
export interface TrackedNote {
	readonly fileId: string;
	readonly ydoc: Y.Doc;
	readonly provider: {
		readonly synced: boolean;
		readonly hasUnsyncedChanges: boolean;
		on(event: "unsyncedChanges", fn: (data: { number: number }) => void): unknown;
		off(event: "unsyncedChanges", fn: (data: { number: number }) => void): unknown;
	};
}

export interface RevTrackerOptions {
	/** The index doc's `docRevs` map (fileId → DocRev). */
	revs: Y.Map<unknown>;
	userId: string;
	storage: KeyValueStore;
	/** Key prefix for this vault and workspace, e.g. `teamsync:<vaultId>:<ws>`. */
	keyPrefix: string;
	throttleMs?: number;
	now?: () => number;
}

const DEFAULT_THROTTLE_MS = 5000;

function sameRev(a: DocRev | null | undefined, b: DocRev | null | undefined): boolean {
	if (!a || !b) return a === b;
	return a.at === b.at && a.by === b.by;
}

/**
 * Tells closed copies of a note elsewhere that it changed, through the index doc's `docRevs`.
 *
 * - Bump: once the relay has acked a note's local changes (`unsyncedChanges` back to 0), set
 *   `docRevs[fileId] = {at, by}`; at most one bump per `throttleMs` per note (leading, then one
 *   trailing). "Has local changes" is persisted, so an edit made offline, or acked only after the
 *   note was closed, still bumps the next time the note is attached.
 * - Read: `syncedRev[fileId]` (localStorage) holds the rev value seen before the last catch-up,
 *   and `changed()` lists notes whose current rev is not deep-equal to it. Revs are compared as
 *   values, never by time, so a peer's skewed clock cannot hide a change.
 */
export class RevTracker {
	private readonly revs: Y.Map<unknown>;
	private readonly userId: string;
	private readonly storage: KeyValueStore;
	private readonly syncedKey: string;
	private readonly dirtyKey: string;
	private readonly throttleMs: number;
	private readonly now: () => number;
	private readonly synced: Map<string, DocRev | null>;
	private readonly dirtySet: Set<string>;
	/** Dirty notes whose changes the relay has acked since they became dirty. */
	private readonly acked = new Set<string>();
	private readonly lastBump = new Map<string, number>();
	private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();

	constructor(options: RevTrackerOptions) {
		this.revs = options.revs;
		this.userId = options.userId;
		this.storage = options.storage;
		this.syncedKey = `${options.keyPrefix}:syncedRevs`;
		this.dirtyKey = `${options.keyPrefix}:dirtyRevs`;
		this.throttleMs = options.throttleMs ?? DEFAULT_THROTTLE_MS;
		this.now = options.now ?? Date.now;
		this.synced = new Map(
			Object.entries(this.load<Record<string, DocRev | null>>(this.syncedKey, {})),
		);
		this.dirtySet = new Set(this.load<string[]>(this.dirtyKey, []));
	}

	/** The current rev of a note, or null when it has none (or a malformed one). */
	rev(fileId: string): DocRev | null {
		return DocRev.safeParse(this.revs.get(fileId)).data ?? null;
	}

	/** True once this device has caught up with (or deliberately skipped) the note at least once. */
	isKnown(fileId: string): boolean {
		return this.synced.has(fileId);
	}

	syncedRev(fileId: string): DocRev | null | undefined {
		return this.synced.get(fileId);
	}

	/** Records the rev value read before the catch-up that just completed. */
	markSynced(fileId: string, rev: DocRev | null): void {
		if (this.isKnown(fileId) && sameRev(this.synced.get(fileId), rev)) return;
		this.synced.set(fileId, rev);
		this.save(this.syncedKey, Object.fromEntries(this.synced));
	}

	isChanged(fileId: string): boolean {
		const rev = this.rev(fileId);
		return rev !== null && !sameRev(rev, this.synced.get(fileId));
	}

	/** Notes whose rev differs from the one this device last caught up with. */
	changed(): string[] {
		return [...this.revs.keys()].filter((id) => this.isChanged(id));
	}

	/** Notes with local changes not yet announced through a bump. */
	dirty(): string[] {
		return [...this.dirtySet];
	}

	isDirty(fileId: string): boolean {
		return this.dirtySet.has(fileId);
	}

	/** Watches an attached note; returns the function that stops watching. */
	track(note: TrackedNote): () => void {
		const { fileId, ydoc, provider } = note;
		const onUpdate = (_update: Uint8Array, origin: unknown) => {
			// The provider applies remote updates with itself as origin; everything else is local.
			if (origin === provider) return;
			this.acked.delete(fileId);
			if (!this.dirtySet.has(fileId)) {
				this.dirtySet.add(fileId);
				this.save(this.dirtyKey, [...this.dirtySet]);
			}
		};
		const onUnsynced = ({ number }: { number: number }) => {
			if (number === 0 && provider.synced) this.onAcked(fileId);
		};
		ydoc.on("update", onUpdate);
		provider.on("unsyncedChanges", onUnsynced);
		if (provider.synced && !provider.hasUnsyncedChanges) this.onAcked(fileId);
		return () => {
			ydoc.off("update", onUpdate);
			provider.off("unsyncedChanges", onUnsynced);
		};
	}

	dispose(): void {
		for (const timer of this.timers.values()) clearTimeout(timer);
		this.timers.clear();
	}

	private onAcked(fileId: string): void {
		if (!this.dirtySet.has(fileId)) return;
		this.acked.add(fileId);
		if (this.timers.has(fileId)) return;
		const wait = (this.lastBump.get(fileId) ?? Number.NEGATIVE_INFINITY) + this.throttleMs;
		const delay = wait - this.now();
		if (delay <= 0) {
			this.bump(fileId);
			return;
		}
		this.timers.set(
			fileId,
			setTimeout(() => {
				this.timers.delete(fileId);
				this.bump(fileId);
			}, delay),
		);
	}

	private bump(fileId: string): void {
		const rev: DocRev = { at: this.now(), by: this.userId };
		this.lastBump.set(fileId, rev.at);
		// Our own bump needs no catch-up here; recorded first, so observers see it as caught up.
		this.markSynced(fileId, rev);
		this.revs.set(fileId, rev);
		if (this.acked.has(fileId)) {
			this.acked.delete(fileId);
			this.dirtySet.delete(fileId);
			this.save(this.dirtyKey, [...this.dirtySet]);
		}
	}

	private load<T>(key: string, fallback: T): T {
		try {
			const raw = this.storage.getItem(key);
			return raw ? (JSON.parse(raw) as T) : fallback;
		} catch {
			return fallback;
		}
	}

	private save(key: string, value: unknown): void {
		try {
			this.storage.setItem(key, JSON.stringify(value));
		} catch (error) {
			console.error("[TeamSync] could not persist rev state", error);
		}
	}
}
