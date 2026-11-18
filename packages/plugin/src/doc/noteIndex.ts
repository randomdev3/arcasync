import type { IndexDelta } from "../workspace/IndexStore";
import { toVault } from "../workspace/paths";
import type { WorkspaceSession } from "../workspace/WorkspaceSession";

export interface IndexedNote {
	fileId: string;
	/** Vault-relative path. */
	path: string;
}

/** The index lookups the doc layer needs: which markdown notes exist, and where. */
export interface NoteIndex {
	notes(): IndexedNote[];
	pathOf(fileId: string): string | null;
	idOf(path: string): string | null;
	/** Calls `listener` with notes added, moved or re-pointed by any transaction; returns unsubscribe. */
	observe(listener: (changed: IndexedNote[]) => void): () => void;
}

/** `NoteIndex` over the session's IndexStore and its path lookups (index sync owns both). */
export class SessionNoteIndex implements NoteIndex {
	constructor(
		private readonly session: WorkspaceSession,
		private readonly root: string,
	) {}

	notes(): IndexedNote[] {
		const out: IndexedNote[] = [];
		for (const { path, meta } of this.session.index?.entries() ?? []) {
			const note = this.toNote(path, meta.id, meta.kind);
			if (note) out.push(note);
		}
		return out;
	}

	pathOf(fileId: string): string | null {
		return this.session.vaultPathOf(fileId);
	}

	idOf(path: string): string | null {
		return this.session.fileIdOf(path);
	}

	observe(listener: (changed: IndexedNote[]) => void): () => void {
		return this.session.onIndexChange((delta: IndexDelta) => {
			const changed: IndexedNote[] = [];
			for (const { path, meta } of delta.added) this.push(changed, path, meta.id, meta.kind);
			for (const { to, meta } of delta.moved) this.push(changed, to, meta.id, meta.kind);
			for (const { path, meta } of delta.changed) this.push(changed, path, meta.id, meta.kind);
			if (changed.length > 0) listener(changed);
		});
	}

	private push(out: IndexedNote[], wsPath: string, fileId: string, kind: string): void {
		const note = this.toNote(wsPath, fileId, kind);
		if (note) out.push(note);
	}

	private toNote(wsPath: string, fileId: string, kind: string): IndexedNote | null {
		if (kind !== "md") return null;
		const path = toVault(this.root, wsPath);
		return path ? { fileId, path } : null;
	}
}
