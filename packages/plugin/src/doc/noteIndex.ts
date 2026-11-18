import { FileMeta } from "@teamsync/shared";
import type * as Y from "yjs";

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
	/** Calls `listener` with notes added or moved by any transaction; returns unsubscribe. */
	observe(listener: (changed: IndexedNote[]) => void): () => void;
}

/**
 * `NoteIndex` read straight from the index doc's `files` map, whose keys are paths relative to
 * the mapped folder `root`. Lane A's IndexStore owns that map; this reader only parses it.
 */
export class FilesMapIndex implements NoteIndex {
	constructor(
		private readonly files: Y.Map<unknown>,
		private readonly root: string,
	) {}

	notes(): IndexedNote[] {
		const out: IndexedNote[] = [];
		for (const [key, value] of this.files) {
			const note = this.toNote(key, value);
			if (note) out.push(note);
		}
		return out;
	}

	pathOf(fileId: string): string | null {
		for (const [key, value] of this.files) {
			const note = this.toNote(key, value);
			if (note?.fileId === fileId) return note.path;
		}
		return null;
	}

	idOf(path: string): string | null {
		const prefix = `${this.root}/`;
		if (!path.startsWith(prefix)) return null;
		return (
			this.toNote(path.slice(prefix.length), this.files.get(path.slice(prefix.length)))?.fileId ??
			null
		);
	}

	observe(listener: (changed: IndexedNote[]) => void): () => void {
		const handler = (event: Y.YMapEvent<unknown>) => {
			const changed: IndexedNote[] = [];
			for (const key of event.keysChanged) {
				const note = this.toNote(key, this.files.get(key));
				if (note) changed.push(note);
			}
			if (changed.length > 0) listener(changed);
		};
		this.files.observe(handler);
		return () => this.files.unobserve(handler);
	}

	private toNote(key: string, value: unknown): IndexedNote | null {
		const meta = FileMeta.safeParse(value);
		if (!meta.success || meta.data.kind !== "md") return null;
		return { fileId: meta.data.id, path: `${this.root}/${key}` };
	}
}
