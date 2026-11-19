import type { WorkspacePresence } from "@arcasync/shared";
import type { HocuspocusProvider } from "@hocuspocus/provider";
import type { Awareness } from "y-protocols/awareness";
import type * as Y from "yjs";

/** `loading` until `whenReady()` resolves; `closed` once the DocManager has detached it. */
export type NoteDocState = "loading" | "ready" | "closed";

/** One attached note: its Y.Doc, the `contents` text and the provider riding the shared socket. */
export interface NoteDocHandle {
	readonly fileId: string;
	/** Vault-relative path; updated in place when the note is renamed. */
	path: string;
	readonly ydoc: Y.Doc;
	readonly ytext: Y.Text;
	readonly provider: HocuspocusProvider;
	/**
	 * Per-note awareness. Only the focused note publishes a non-null local state; a background
	 * open must `setLocalState(null)` before attaching (the budget assumes 4 frames per open).
	 */
	readonly awareness: Awareness;
	readonly state: NoteDocState;
	/** The relay granted this user read-only access (a viewer). */
	readonly readonly: boolean;
	/** The last reconcile found the file or the doc over this device's `maxMdBytes`. */
	readonly tooLarge: boolean;
	/** Local persistence loaded AND (provider synced OR offline with local data). */
	whenReady(): Promise<void>;
	/** Runs once when the note is closed; returns unsubscribe. */
	onClose(listener: () => void): () => void;
}

/** Refcounted, lazily attached note docs (P1-3). */
export interface IDocManager {
	acquire(fileId: string, path: string): Promise<NoteDocHandle>;
	release(handle: NoteDocHandle): void;
	/** Docs whose provider is currently attached (in use plus warm LRU). */
	attachedCount(): number;
	/**
	 * True when the file at `path` is over this device's `maxMdBytes` (mobile): the note is not
	 * synced here. Warns once per note. Checked before attaching, so it costs no traffic.
	 */
	exceedsLimit(fileId: string, path: string): boolean;
	/**
	 * An acquired note gets an editor (P1-4): `attach` runs with no reconcile in flight and
	 * returns whether the editor still wants it. Resolves true when the editor counts as bound.
	 */
	editorAttached(handle: NoteDocHandle, attach: () => boolean): Promise<boolean>;
	/** The editor bound by `editorAttached` let go (its buffer mirrored the doc until now). */
	editorDetached(handle: NoteDocHandle): void;
}

/** Workspace presence read from the index-doc awareness (P1-5). */
export interface IPresence {
	/** Present users keyed by user id; one entry per device. */
	users(): Map<string, WorkspacePresence[]>;
	/** Subscribe to changes of `users()`; returns the unsubscribe function. */
	onChange(listener: () => void): () => void;
	/** True after `PRESENCE_IDLE_AFTER_MS` without input, or while the window is hidden. */
	readonly idle: boolean;
}

/** Jump to and follow another user (P1-7). */
export interface INavigator {
	/** Open the user's file and reveal their cursor (top of file when it is not visible). */
	jumpTo(userId: string): Promise<void>;
	follow(userId: string): void;
	unfollow(): void;
	/** User id being followed, or null. */
	readonly following: string | null;
}
