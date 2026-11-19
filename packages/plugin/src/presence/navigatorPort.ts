import { FLUSH_DELAY_MS } from "@arcasync/shared";
import { EditorView } from "@codemirror/view";
import { type App, MarkdownView, Notice, type TFile } from "obsidian";
import * as Y from "yjs";
import { LIVE_CLASS } from "../editor/EditorBinding";
import { toVault, toWs } from "../workspace/paths";
import type { IDocManager, NoteDocHandle } from "../workspace/types";
import type { NavigatorPort } from "./Navigator";

/** How long `reveal` waits for the editor to bind and for the target's awareness to arrive. */
const REVEAL_TIMEOUT_MS = 3000;
const POLL_MS = 50;
/**
 * A peer's state may arrive before its caret: focusing a note publishes `{user}` at once and the
 * caret follows in a later batch (the provider flushes awareness every FLUSH_DELAY_MS).
 */
const CARET_GRACE_MS = FLUSH_DELAY_MS + 500;
/** Caret moves of a followed user scroll at most this often. */
const TRACK_THROTTLE_MS = 100;
const RETURN_NOTICE_MS = 10_000;
/** A held modifier (Shift from a shift-click auto-repeats) is not typing. */
const MODIFIER_KEYS = new Set(["Shift", "Control", "Alt", "Meta", "CapsLock", "Fn"]);

/** What the port needs from the workspace session. */
export interface NavigatorSession {
	readonly app: App;
	readonly docs: IDocManager | null;
	fileIdOf(vaultPath: string): string | null;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function cmOf(view: MarkdownView | null): EditorView | null {
	const cm = (view?.editor as { cm?: unknown } | undefined)?.cm;
	return cm instanceof EditorView ? cm : null;
}

/**
 * Where `userId`'s caret is in the note: `present` once their awareness state arrived, `index`
 * null when they show no caret (a blurred peer that never focused the note).
 */
function caretOf(note: NoteDocHandle, userId: string): { present: boolean; index: number | null } {
	let present = false;
	for (const [clientId, state] of note.awareness.getStates()) {
		if (clientId === note.awareness.clientID || state?.user?.id !== userId) continue;
		present = true;
		const head = state.cursor?.head;
		if (head == null) continue;
		const pos = Y.createAbsolutePositionFromRelativePosition(
			Y.createRelativePositionFromJSON(head),
			note.ydoc,
		);
		if (pos && pos.type === note.ytext) {
			return { present, index: Math.min(pos.index, note.ytext.length) };
		}
	}
	return { present, index: null };
}

/** The Obsidian side of the Navigator: opens notes, scrolls their editors, reports input. */
export class ObsidianNavigatorPort implements NavigatorPort {
	private readonly app: App;

	constructor(
		private readonly session: NavigatorSession,
		private readonly root: string,
	) {
		this.app = session.app;
	}

	async open(file: string): Promise<boolean> {
		const path = toVault(this.root, file);
		const target = path === null ? null : this.app.vault.getFileByPath(path);
		if (!target) return false;
		const active = this.app.workspace.getActiveViewOfType(MarkdownView);
		if (active?.file?.path === target.path) return true;
		await this.app.workspace.getLeaf(false).openFile(target, { active: true });
		return true;
	}

	async reveal(file: string, userId: string): Promise<boolean> {
		const opened = await this.acquire(file);
		if (!opened) return false;
		const { docs, note, path } = opened;
		try {
			await note.whenReady();
			const deadline = Date.now() + REVEAL_TIMEOUT_MS;
			let caretDeadline = deadline;
			for (;;) {
				const cm = this.boundEditor(path, note);
				const caret = caretOf(note, userId);
				const now = Date.now();
				if (caret.present) caretDeadline = Math.min(caretDeadline, now + CARET_GRACE_MS);
				if (cm && (caret.index !== null || now >= caretDeadline)) {
					const at = caret.index ?? 0;
					cm.dispatch({
						effects: EditorView.scrollIntoView(at, {
							y: caret.index === null ? "start" : "center",
						}),
					});
					return caret.index !== null;
				}
				if (now >= deadline || note.state === "closed") return false;
				await sleep(POLL_MS);
			}
		} catch {
			// The note closed (session stopped) before it was ready.
			return false;
		} finally {
			docs.release(note);
		}
	}

	trackCursor(file: string, userId: string): () => void {
		let stopped = false;
		let timer: ReturnType<typeof setTimeout> | null = null;
		let off = () => {};
		void this.acquire(file).then((opened) => {
			if (!opened) return;
			const { docs, note, path } = opened;
			if (stopped) {
				docs.release(note);
				return;
			}
			type Changes = { added: number[]; updated: number[] };
			const onChange = ({ added, updated }: Changes) => {
				const states = note.awareness.getStates();
				const moved = [...added, ...updated].some((id) => states.get(id)?.user?.id === userId);
				if (!moved || timer !== null) return;
				timer = setTimeout(() => {
					timer = null;
					const cm = this.boundEditor(path, note);
					const { index } = caretOf(note, userId);
					if (!cm || index === null) return;
					cm.dispatch({
						effects: EditorView.scrollIntoView(index, { y: "nearest", yMargin: 48 }),
					});
				}, TRACK_THROTTLE_MS);
			};
			note.awareness.on("change", onChange);
			off = () => {
				note.awareness.off("change", onChange);
				docs.release(note);
			};
		});
		return () => {
			stopped = true;
			if (timer !== null) clearTimeout(timer);
			timer = null;
			off();
			off = () => {};
		};
	}

	onFileOpen(listener: (file: string | null) => void): () => void {
		const { workspace } = this.app;
		const ref = workspace.on("file-open", (file: TFile | null) => {
			listener(file ? toWs(this.root, file.path) : null);
		});
		return () => workspace.offref(ref);
	}

	onEditorKeydown(listener: () => void): () => void {
		const doc = window.document;
		const onKeydown = (event: KeyboardEvent) => {
			if (!event.isTrusted || MODIFIER_KEYS.has(event.key)) return;
			const target = event.target;
			if (target instanceof Element && target.closest(".cm-editor")) listener();
		};
		doc.addEventListener("keydown", onKeydown, { capture: true, passive: true });
		return () => doc.removeEventListener("keydown", onKeydown, { capture: true });
	}

	bookmark(): (() => void) | null {
		const view = this.app.workspace.getActiveViewOfType(MarkdownView);
		const file = view?.file;
		const cm = cmOf(view);
		if (!file || !cm) return null;
		const snapshot = cm.scrollSnapshot();
		return () => {
			void (async () => {
				const active = this.app.workspace.getActiveViewOfType(MarkdownView);
				if (active?.file !== file) {
					await this.app.workspace.getLeaf(false).openFile(file, { active: true });
				}
				cmOf(this.app.workspace.getActiveViewOfType(MarkdownView))?.dispatch({
					effects: snapshot,
				});
			})();
		};
	}

	notify(message: string, action?: { label: string; run: () => void }): void {
		if (!action) {
			new Notice(message);
			return;
		}
		const fragment = window.document.createDocumentFragment();
		fragment.append(`${message} `);
		const button = window.document.createElement("button");
		button.className = "teamsync-notice-action";
		button.textContent = action.label;
		fragment.append(button);
		const notice = new Notice(fragment, RETURN_NOTICE_MS);
		button.addEventListener("click", (event) => {
			event.stopPropagation();
			notice.hide();
			action.run();
		});
	}

	/** The editor showing `path` once it is bound to `note` (its buffer then mirrors the doc). */
	private boundEditor(path: string, note: NoteDocHandle): EditorView | null {
		const active = this.app.workspace.getActiveViewOfType(MarkdownView);
		let cm = active?.file?.path === path ? cmOf(active) : null;
		if (!cm) {
			for (const leaf of this.app.workspace.getLeavesOfType("markdown")) {
				const view = leaf.view instanceof MarkdownView ? leaf.view : null;
				if (view?.file?.path === path) cm = cmOf(view);
				if (cm) break;
			}
		}
		if (!cm?.dom.classList.contains(LIVE_CLASS)) return null;
		return cm.state.doc.length === note.ytext.length ? cm : null;
	}

	private async acquire(
		file: string,
	): Promise<{ docs: IDocManager; note: NoteDocHandle; path: string } | null> {
		const path = toVault(this.root, file);
		const docs = this.session.docs;
		const fileId = path === null ? null : this.session.fileIdOf(path);
		if (path === null || !docs || !fileId) return null;
		try {
			return { docs, note: await docs.acquire(fileId, path), path };
		} catch {
			return null;
		}
	}
}
