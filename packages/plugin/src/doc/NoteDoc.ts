import type { HocuspocusProvider } from "@hocuspocus/provider";
import { docName } from "@teamsync/shared";
import { IndexeddbPersistence } from "y-indexeddb";
import { Awareness } from "y-protocols/awareness";
import * as Y from "yjs";
import type { OpenDocHandle } from "../net/ConnectionManager";
import type { NoteDocHandle, NoteDocState } from "../workspace/types";
import { isEnrolled, type ReconcileNote } from "./enroll";

const LAST_SYNCED_HASH = "lastSyncedHash";

export interface NoteDocDeps {
	vaultId: string;
	workspaceId: string;
	/** `ConnectionManager.openDoc`. */
	open(name: string, ydoc: Y.Doc, awareness: Awareness): OpenDocHandle;
	/** True when the socket is known to be down (not merely still connecting). */
	isOffline(): boolean;
	/** Subscribe to connection status changes; returns the unsubscribe function. */
	onConnectionChange(listener: () => void): () => void;
}

export function noteDbName(vaultId: string, fileId: string): string {
	return `teamsync-${vaultId}-${fileId}`;
}

/**
 * One note's Y.Doc (`contents` text plus `meta.enrolled`), its IndexedDB copy and its provider.
 * Created only through `NoteDoc.open`, which loads IndexedDB before attaching, so the sync
 * handshake already carries the local state and an open costs no extra update (or relay row).
 */
export class NoteDoc implements NoteDocHandle, ReconcileNote {
	readonly ytext: Y.Text;
	readonly awareness: Awareness;
	readonly provider: HocuspocusProvider;
	state: NoteDocState = "loading";
	/** Set by the editor binding (P1-4): an open editor owns the buffer and its disk saves. */
	editorBound = false;
	/** Set by `DocManager` to the first reconcile after `whenSynced`. */
	ready: Promise<void> | null = null;

	private readonly attachment: OpenDocHandle;
	private readonly closeListeners = new Set<() => void>();
	private lastSyncedHash: string | undefined;

	private constructor(
		readonly fileId: string,
		public path: string,
		readonly ydoc: Y.Doc,
		private readonly idb: IndexeddbPersistence,
		lastSyncedHash: string | undefined,
		private readonly deps: NoteDocDeps,
	) {
		this.ytext = ydoc.getText("contents");
		this.lastSyncedHash = lastSyncedHash;
		// Background opens must not publish presence: the budget counts 4 frames per open, and only
		// the focused note's awareness carries a state (the editor binding sets it).
		this.awareness = new Awareness(ydoc);
		this.awareness.setLocalState(null);
		const name = docName({ workspaceId: deps.workspaceId, kind: "md", fileId });
		this.attachment = deps.open(name, ydoc, this.awareness);
		this.provider = this.attachment.provider;
	}

	static async open(fileId: string, path: string, deps: NoteDocDeps): Promise<NoteDoc> {
		const ydoc = new Y.Doc({ gc: true });
		const idb = new IndexeddbPersistence(noteDbName(deps.vaultId, fileId), ydoc);
		try {
			await idb.whenSynced;
			const hash = (await idb.get(LAST_SYNCED_HASH)) as string | undefined;
			return new NoteDoc(fileId, path, ydoc, idb, hash, deps);
		} catch (error) {
			await idb.destroy();
			ydoc.destroy();
			throw error;
		}
	}

	get synced(): boolean {
		return this.provider.synced;
	}

	get readonly(): boolean {
		return this.provider.authorizedScope === "readonly";
	}

	whenReady(): Promise<void> {
		return this.ready ?? this.whenSynced();
	}

	/** Server state loaded, or the socket is down and IndexedDB had this note. */
	whenSynced(): Promise<void> {
		return new Promise((resolve, reject) => {
			let settled = false;
			const cleanup: Array<() => void> = [];
			const done = (error?: Error) => {
				settled = true;
				for (const fn of cleanup.splice(0)) fn();
				if (error) reject(error);
				else resolve();
			};
			const check = () => {
				if (settled) return;
				if (this.state === "closed") done(new Error(`note ${this.fileId} closed`));
				else if (this.provider.synced) done();
				else if (this.deps.isOffline() && this.hasLocalData()) done();
			};
			this.provider.on("synced", check);
			cleanup.push(() => this.provider.off("synced", check));
			this.closeListeners.add(check);
			cleanup.push(() => this.closeListeners.delete(check));
			// `onStateChange` calls the listener right away, possibly settling before it returns.
			const offConnection = this.deps.onConnectionChange(check);
			if (settled) offConnection();
			else cleanup.push(offConnection);
			check();
		});
	}

	/** Runs once when the note is closed (evicted or its session stopped); returns unsubscribe. */
	onClose(listener: () => void): () => void {
		this.closeListeners.add(listener);
		return () => this.closeListeners.delete(listener);
	}

	hasLocalData(): boolean {
		return this.ytext.length > 0 || isEnrolled(this.ydoc);
	}

	async getLastSyncedHash(): Promise<string | undefined> {
		return this.lastSyncedHash;
	}

	async setLastSyncedHash(hash: string): Promise<void> {
		this.lastSyncedHash = hash;
		if (this.state !== "closed") await this.idb.set(LAST_SYNCED_HASH, hash);
	}

	/** Detaches the provider and closes IndexedDB (data kept). */
	close(): void {
		if (this.state === "closed") return;
		this.state = "closed";
		for (const listener of [...this.closeListeners]) listener();
		this.attachment.close();
		void this.idb.destroy();
		this.ydoc.destroy();
	}
}
