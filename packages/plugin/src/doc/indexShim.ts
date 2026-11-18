import { sha256Hex } from "@teamsync/shared";
import { type App, TFile } from "obsidian";
import type { SelfWriteRegistry } from "../workspace/SelfWriteRegistry";
import type { BackgroundSync } from "./BackgroundSync";
import { ObsidianDisk } from "./DiskWriter";
import type { IndexedNote, NoteIndex } from "./noteIndex";

export interface IndexShimOptions {
	app: App;
	root: string;
	selfWrites: SelfWriteRegistry;
	index: NoteIndex;
	background: BackgroundSync;
}

/**
 * TEMPORARY stand-in for the two lane-A (`p1/index-sync`) hooks the doc layer depends on, so
 * P1-3 runs end to end before that lane merges. Delete it at the merge and wire instead:
 * - DiskWatcher: a non-self `modify` of an indexed `.md` → `background.onDiskModify(fileId)`;
 * - remote add: after `vault.create(path, "")` → `background.enqueue(fileId)`.
 * It adds nothing to the index; that stays lane A's (Reconciler).
 */
export function startIndexShim({
	app,
	root,
	selfWrites,
	index,
	background,
}: IndexShimOptions): () => void {
	const vault = app.vault;
	const disk = new ObsidianDisk(vault);

	const modifyRef = vault.on("modify", (file) => {
		if (!(file instanceof TFile) || file.extension !== "md" || !file.path.startsWith(`${root}/`)) {
			return;
		}
		void (async () => {
			const hash = await sha256Hex(await vault.read(file));
			if (selfWrites.consume(file.path, "modify", hash)) return;
			const fileId = index.idOf(file.path);
			if (fileId) await background.onDiskModify(fileId);
		})().catch((error) => console.error(`[TeamSync] ${file.path}: modify failed`, error));
	});

	const createMissing = async (notes: IndexedNote[]) => {
		for (const { fileId, path } of notes) {
			if (disk.exists(path)) continue;
			selfWrites.expect(path, { kind: "create" });
			await disk.create(path, "");
			background.enqueue(fileId);
		}
	};
	const unobserve = index.observe((notes) => {
		createMissing(notes).catch((error) => console.error("[TeamSync] create failed", error));
	});
	createMissing(index.notes()).catch((error) => console.error("[TeamSync] create failed", error));

	return () => {
		vault.offref(modifyRef);
		unobserve();
	};
}
