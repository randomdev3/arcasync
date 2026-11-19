import {
	type ChangeSpec,
	Compartment,
	EditorState,
	type Extension,
	Prec,
	Transaction,
} from "@codemirror/state";
import {
	EditorView,
	keymap,
	type PluginValue,
	ViewPlugin,
	type ViewUpdate,
} from "@codemirror/view";
import { editorInfoField, MarkdownView, type TFile } from "obsidian";
import { yCollab, ySyncAnnotation, yUndoManagerKeymap } from "y-codemirror.next";
import * as Y from "yjs";
import { presenceUser } from "../presence/PresenceService";
import type { IDocManager, NoteDocHandle } from "../workspace/types";
import type { WorkspaceSession } from "../workspace/WorkspaceSession";
import { caretLabels } from "./caretLabels";

/** Marks an editor whose buffer is bound to its note's CRDT. */
export const LIVE_CLASS = "teamsync-live";
/** Embeds, table cells and hover popovers edit through their own editors; never bind those. */
const SUB_EDITOR = ".markdown-embed, .table-cell-wrapper, .popover";

/** What the bindings need from the plugin; `TeamSyncPlugin` provides it. */
export interface BindingHost {
	/** Every connected workspace session. */
	readonly sessions: readonly WorkspaceSession[];
	/** The session whose mapped folder contains `vaultPath`, or null. */
	sessionFor(vaultPath: string): WorkspaceSession | null;
	/** The view in the active leaf, if it is a Markdown view. */
	activeView(): MarkdownView | null;
}

interface Target {
	docs: IDocManager;
	fileId: string;
	file: TFile;
}

interface Bound {
	docs: IDocManager;
	fileId: string;
	file: TFile;
	note: NoteDocHandle;
	undoManager: Y.UndoManager;
	offClose: () => void;
}

/**
 * The smallest single change that turns `from` into `to` (common prefix and suffix kept), so
 * replacing a buffer keeps folds, scroll and the cursor where the text did not change.
 */
export function minimalChange(from: string, to: string): ChangeSpec | null {
	if (from === to) return null;
	const max = Math.min(from.length, to.length);
	let start = 0;
	while (start < max && from.charCodeAt(start) === to.charCodeAt(start)) start++;
	let endFrom = from.length;
	let endTo = to.length;
	while (
		endFrom > start &&
		endTo > start &&
		from.charCodeAt(endFrom - 1) === to.charCodeAt(endTo - 1)
	) {
		endFrom--;
		endTo--;
	}
	return { from: start, to: endFrom, insert: to.slice(start, endTo) };
}

/**
 * Binds every Markdown editor showing a synced note to that note's CRDT with y-codemirror.next.
 *
 * One `EditorBinding` per CodeMirror view; Obsidian replaces the editor state on every file load,
 * which recreates the binding, so a file switch is an unbind plus a fresh bind. Each note binds to
 * the session whose mapped folder contains it. Bindings are re-evaluated whenever the sessions
 * change (connect, disconnect, stop/start, a mapping added or removed) and on every index change
 * of any session (a note just created or renamed gains its file id later than its editor opens).
 *
 * Budget rule: only the note of the active leaf publishes an awareness state; every other bound
 * note's local state is null, which also stops its presence renewals.
 */
export class EditorBindings {
	/** Holds `yCollab` (and read-only facets) for bound editors; empty otherwise. */
	readonly collab = new Compartment();
	private readonly views = new Set<EditorBinding>();
	/** Index-change subscriptions, one per session the host had at the last `sessionChanged`. */
	private readonly watched = new Map<WorkspaceSession, () => void>();

	constructor(readonly host: BindingHost) {}

	/** The extension to register once with `registerEditorExtension`. */
	extension(): Extension {
		return [this.collab.of([]), ViewPlugin.define((view) => new EditorBinding(view, this))];
	}

	add(binding: EditorBinding): void {
		this.views.add(binding);
	}

	delete(binding: EditorBinding): void {
		this.views.delete(binding);
	}

	/** Re-reads the host's sessions; call when they may have changed. */
	sessionChanged(): void {
		const sessions = new Set(this.host.sessions);
		for (const [session, off] of this.watched) {
			if (sessions.has(session)) continue;
			off();
			this.watched.delete(session);
		}
		for (const session of sessions) {
			if (!this.watched.has(session))
				this.watched.set(
					session,
					session.onIndexChange(() => this.refresh()),
				);
		}
		this.refresh();
	}

	/** Re-evaluates every editor's target note. */
	refresh(): void {
		for (const binding of this.views) binding.sync();
	}

	/** The note the editor should be bound to, or null. */
	target(view: EditorView, current: Bound | null): Target | null {
		const info = view.state.field(editorInfoField, false);
		if (!(info instanceof MarkdownView)) return null;
		const file = info.file;
		if (file?.extension !== "md") return null;
		if (view.dom.closest(SUB_EDITOR)) return null;
		const session = this.host.sessionFor(file.path);
		const docs = session?.docs;
		if (!session || !docs) return null;
		const fileId = session.fileIdOf(file.path);
		// Over the device's size limit: the editor stays a plain local editor.
		if (fileId) return docs.exceedsLimit(fileId, file.path) ? null : { docs, fileId, file };
		// Mid-rename the editor's path and the index disagree for a moment; the note is the same.
		const sameNote = current?.docs === docs && current.file === file;
		return sameNote && session.vaultPathOf(current.fileId) !== null ? current : null;
	}

	/** Publishes awareness for the active leaf's note only. */
	updateFocus(): void {
		const active = this.host.activeView();
		const notes = new Set<NoteDocHandle>();
		let focused: NoteDocHandle | null = null;
		let focusedView: EditorView | null = null;
		for (const binding of this.views) {
			const note = binding.note;
			if (!note || note.state === "closed") continue;
			notes.add(note);
			if (active && binding.info === active) {
				focused = note;
				focusedView = binding.view;
			}
		}
		const user = this.host.sessions[0]?.user;
		for (const note of notes) {
			const state = note.awareness.getLocalState();
			if (note === focused && user) {
				if (state === null) {
					// Publish the caret in the same update: y-codemirror only publishes it on the next
					// view update, so a caret placed before binding would otherwise stay invisible.
					const cursor = focusedView ? currentCursor(focusedView, note) : null;
					note.awareness.setLocalState({ user: presenceUser(user), ...(cursor ? { cursor } : {}) });
				}
			} else if (state !== null) {
				note.awareness.setLocalState(null);
			}
		}
	}

	/** True when another editor is still bound to `note`. */
	sharedBy(note: NoteDocHandle, except: EditorBinding): boolean {
		for (const binding of this.views) if (binding !== except && binding.note === note) return true;
		return false;
	}

	destroy(): void {
		for (const off of this.watched.values()) off();
		this.watched.clear();
	}
}

/** The focused editor's selection in y-codemirror's awareness format, or null when unfocused. */
export function currentCursor(
	view: EditorView,
	note: NoteDocHandle,
): { anchor: Y.RelativePosition; head: Y.RelativePosition } | null {
	if (!(view.hasFocus && view.dom.ownerDocument.hasFocus())) return null;
	if (view.state.doc.length !== note.ytext.length) return null;
	const sel = view.state.selection.main;
	return {
		anchor: Y.createRelativePositionFromTypeIndex(note.ytext, sel.anchor),
		head: Y.createRelativePositionFromTypeIndex(note.ytext, sel.head),
	};
}

function fileOf(state: EditorState): TFile | null {
	return state.field(editorInfoField, false)?.file ?? null;
}

/** Collab extension for one bound editor. */
function collabExtension(note: NoteDocHandle, undoManager: Y.UndoManager): Extension {
	return [
		yCollab(note.ytext, note.awareness, { undoManager }),
		// Name labels for 2 s after a remote caret moves; remote carets hidden until the note is ready.
		caretLabels({ awareness: note.awareness, ready: note.whenReady() }),
		// CodeMirror owns the editor element's class list; a facet survives its rewrites.
		EditorView.editorAttributes.of({ class: LIVE_CLASS }),
		// Obsidian's own Mod-z runs CodeMirror's history, which would also undo remote edits.
		Prec.highest(keymap.of(yUndoManagerKeymap)),
		// Remote edits never enter CodeMirror's history (Obsidian's undo command, the menu).
		EditorState.transactionExtender.of((tr) =>
			tr.annotation(ySyncAnnotation) ? { annotations: Transaction.addToHistory.of(false) } : null,
		),
		note.readonly
			? [
					EditorState.readOnly.of(true),
					EditorView.editable.of(false),
					// Commands and widgets can still dispatch; a viewer's buffer only takes remote text.
					EditorState.transactionFilter.of((tr) =>
						tr.docChanged && !tr.annotation(ySyncAnnotation) && !tr.annotation(Transaction.remote)
							? []
							: tr,
					),
				]
			: [],
	];
}

export class EditorBinding implements PluginValue {
	private bound: Bound | null = null;
	/** Bumped by every unbind; a bind that finds it changed gives up. */
	private generation = 0;
	private pending: { fileId: string; docs: IDocManager; cancel: () => void } | null = null;
	private destroyed = false;
	private lastFile: TFile | null = null;

	constructor(
		readonly view: EditorView,
		private readonly bindings: EditorBindings,
	) {
		bindings.add(this);
		// The editor may not be in the DOM yet (embeds are attached after creation).
		queueMicrotask(() => this.sync());
	}

	get note(): NoteDocHandle | null {
		return this.bound?.note ?? null;
	}

	get info(): unknown {
		return this.view.state.field(editorInfoField, false) ?? null;
	}

	update(update: ViewUpdate): void {
		if (fileOf(update.state) !== this.lastFile) queueMicrotask(() => this.sync());
	}

	destroy(): void {
		this.destroyed = true;
		this.bindings.delete(this);
		// The state is being replaced (file switch) or the view is gone: no dispatch here.
		this.unbind(false);
	}

	/** Binds, rebinds or unbinds to match the editor's current file and session. */
	sync(): void {
		if (this.destroyed) return;
		const target = this.bindings.target(this.view, this.bound);
		this.lastFile = target?.file ?? fileOf(this.view.state);
		const current = this.bound ?? this.pending;
		if (target && current && current.docs === target.docs && current.fileId === target.fileId) {
			if (this.bound) this.bound.file = target.file;
			return;
		}
		if (!target && !current) return;
		this.unbind(true);
		if (target) void this.bind(target);
	}

	private async bind({ docs, fileId, file }: Target): Promise<void> {
		const generation = this.generation;
		let cancel = () => {};
		const cancelled = new Promise<"cancelled">((resolve) => {
			cancel = () => resolve("cancelled");
		});
		this.pending = { docs, fileId, cancel };
		const stale = () => this.destroyed || generation !== this.generation;
		let note: NoteDocHandle;
		try {
			note = await docs.acquire(fileId, file.path);
		} catch (error) {
			if (!stale()) console.error(`[TeamSync] ${file.path}: opening the note failed`, error);
			return;
		}
		let attached = false;
		try {
			// Rejects when the note closes first (session stopped): nothing to bind then.
			const ready = note.whenReady().then(
				() => "ready" as const,
				() => "closed" as const,
			);
			if ((await Promise.race([ready, cancelled])) !== "ready" || stale()) return;
			// The synced doc turned out over the size limit; its reconcile already warned.
			if (note.tooLarge) return;
			attached = await docs.editorAttached(note, () => {
				if (stale() || note.state === "closed") return false;
				if (this.view.dom.closest(SUB_EDITOR)) return false;
				this.attach(note, docs, fileId, file);
				return true;
			});
		} catch (error) {
			if (!stale()) console.error(`[TeamSync] ${file.path}: binding the editor failed`, error);
		} finally {
			if (this.pending?.cancel === cancel) this.pending = null;
			if (!attached) {
				docs.release(note);
			}
		}
		if (attached) this.bindings.updateFocus();
	}

	/** Runs with no reconcile of the note in flight: buffer := doc, then collab on. */
	private attach(note: NoteDocHandle, docs: IDocManager, fileId: string, file: TFile): void {
		const undoManager = new Y.UndoManager(note.ytext);
		const changes = minimalChange(this.view.state.doc.toString(), note.ytext.toString());
		this.view.dispatch({
			...(changes ? { changes } : {}),
			effects: this.bindings.collab.reconfigure(collabExtension(note, undoManager)),
			annotations: [Transaction.addToHistory.of(false), Transaction.remote.of(true)],
		});
		const offClose = note.onClose(() => this.unbind(true));
		this.bound = { docs, fileId, file, note, undoManager, offClose };
	}

	/** `reconfigure` is false while CodeMirror is replacing the state (no dispatch allowed). */
	private unbind(reconfigure: boolean): void {
		this.generation++;
		this.pending?.cancel();
		this.pending = null;
		const bound = this.bound;
		if (!bound) return;
		this.bound = null;
		bound.offClose();
		if (reconfigure && !this.destroyed) {
			try {
				this.view.dispatch({ effects: this.bindings.collab.reconfigure([]) });
			} catch {
				// Inside a CodeMirror update: drop collab right after it.
				queueMicrotask(() => {
					if (!this.bound && !this.destroyed) {
						this.view.dispatch({ effects: this.bindings.collab.reconfigure([]) });
					}
				});
			}
		}
		bound.undoManager.destroy();
		const { note, docs } = bound;
		docs.editorDetached(note);
		if (note.state !== "closed" && !this.bindings.sharedBy(note, this)) {
			if (note.awareness.getLocalState() !== null) note.awareness.setLocalState(null);
		}
		docs.release(note);
		this.bindings.updateFocus();
	}
}
