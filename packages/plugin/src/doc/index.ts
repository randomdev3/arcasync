import { docName, INDEX_REVS, parseDocName } from "@arcasync/shared";
import { Notice } from "obsidian";
import { limits } from "../platform";
import type { WorkspaceSession } from "../workspace/WorkspaceSession";
import { BackgroundSync, type CloneSource } from "./BackgroundSync";
import { DiskWriter, ObsidianDisk } from "./DiskWriter";
import { DocManager } from "./DocManager";
import { SessionNoteIndex } from "./noteIndex";
import { RevTracker } from "./RevTracker";

/**
 * Starts the note-doc layer of a started session: DocManager in `session.docs`, docRevs
 * tracking and BackgroundSync, fed by the session's index-sync hooks (`onIndexChange`,
 * `onDiskModify`, `settled`). Returns the function that stops it (before the session's index
 * doc is destroyed). Does nothing for a session without a mapped folder.
 */
export function startNoteDocs(session: WorkspaceSession): () => void {
	const root = session.root;
	if (!root) return () => {};
	const { app, connections } = session;
	const indexProvider = session.indexProvider;
	const revs = session.indexDoc.getMap<unknown>(INDEX_REVS);
	const index = new SessionNoteIndex(session, root);
	const writer = new DiskWriter(new ObsidianDisk(app.vault), session.selfWrites);
	const isOffline = () => {
		const { status } = connections.currentState;
		return status === "disconnected" || status === "error";
	};
	const revTracker = new RevTracker({
		revs,
		userId: session.user.id,
		storage: window.localStorage,
		keyPrefix: `arcasync:${session.vaultId}:${session.workspaceId}`,
	});
	const { warmDocs, bgConcurrency, maxMdBytes, maxBaseBytes } = limits();
	const docs = new DocManager({
		note: {
			vaultId: session.vaultId,
			workspaceId: session.workspaceId,
			open: (name, ydoc, awareness) => connections.openDoc(name, ydoc, awareness),
			isOffline,
			onConnectionChange: (listener) => connections.onStateChange(() => listener()),
			maxBaseBytes,
		},
		reconcile: {
			writer,
			device: app.vault.getName(),
			notify: (message) => new Notice(message, 15000),
		},
		track: (note) => revTracker.track(note),
		pathOf: (fileId) => index.pathOf(fileId),
		warmDocs,
		maxBytes: maxMdBytes,
		sizeOf: (path) => app.vault.getFileByPath(path)?.stat.size ?? null,
	});
	const background = new BackgroundSync({
		docs,
		revTracker,
		revs,
		index,
		readDisk: (path) => writer.read(path),
		concurrency: bgConcurrency,
		isOnline: () => connections.currentState.status === "connected" && indexProvider.synced,
		settled: () => session.settled(),
		clone: cloneSource(session),
	});
	session.docs = docs;
	background.start();

	const onIndexSynced = () => {
		background.catchUp();
		background.pump();
	};
	indexProvider.on("synced", onIndexSynced);
	if (indexProvider.synced) onIndexSynced();
	const offModify = session.onDiskModify((vaultPath) => {
		const fileId = session.fileIdOf(vaultPath);
		if (!fileId) return;
		background
			.onDiskModify(fileId)
			.catch((error) => console.error(`[ArcaSync] ${vaultPath}: applying the edit failed`, error));
	});

	return () => {
		indexProvider.off("synced", onIndexSynced);
		offModify();
		background.dispose();
		revTracker.dispose();
		docs.destroy();
		if (session.docs === docs) session.docs = null;
	};
}

/** The session's bulk clone client by file id, or null without `features.bulkClone`. */
function cloneSource(session: WorkspaceSession): CloneSource | null {
	const client = session.clone;
	if (!client) return null;
	const { workspaceId } = session;
	const idOf = (doc: string) => parseDocName(doc)?.fileId ?? doc;
	return {
		async clone(docs) {
			const result = await client.clone(
				docs.map(({ fileId, sv }) => ({ doc: docName({ workspaceId, kind: "md", fileId }), sv })),
			);
			return {
				entries: result.entries.map(({ doc, update }) => ({ fileId: idOf(doc), update })),
				remaining: result.remaining.map(idOf),
			};
		},
	};
}
