import type { HocuspocusProvider } from "@hocuspocus/provider";
import { docName } from "@teamsync/shared";
import { type App, Notice } from "obsidian";
import { Awareness } from "y-protocols/awareness";
import * as Y from "yjs";
import { startNoteDocs } from "../doc";
import { type ChunkTransfer, FileSyncer } from "../files/FileSyncer";
import type { ConnectionManager, OpenDocHandle } from "../net/ConnectionManager";
import { startPresence } from "../presence";
import { DiskWatcher } from "./DiskWatcher";
import { type IndexListener, IndexStore } from "./IndexStore";
import { LocalStorageKnown, ObsidianLocalFiles } from "./LocalFiles";
import { syncKind, toVault, toWs } from "./paths";
import { Reconciler } from "./Reconciler";
import { SelfWriteRegistry } from "./SelfWriteRegistry";
import type { IDocManager, INavigator, IPresence } from "./types";

export interface SessionUser {
	id: string;
	name: string;
	color: string;
}

export interface WorkspaceSessionOptions {
	app: App;
	connections: ConnectionManager;
	workspaceId: string;
	/** Vault folder mapped to this workspace, or null when the vault maps none. */
	root: string | null;
	user: SessionUser;
	/** `app.appId`; keys per-vault local state (IndexedDB names, localStorage). */
	vaultId: string;
	/** Binary sync through R2 chunks (`features.chunks`); without it binaries are ignored. */
	binaries?: BinaryOptions | null;
}

export interface BinaryOptions {
	chunks: ChunkTransfer;
	/** `limits().maxBinaryBytes`, capped by the server's `maxFileBytes`. */
	maxBytes: number;
}

/**
 * Everything one connected workspace owns. The session owns the index doc; the subsystems in
 * the `docs`, `presence` and `navigator` slots hang off it.
 *
 * Lifetime: `start()` creates a fresh index Y.Doc and Awareness and attaches them; `stop()`
 * detaches and destroys both (the provider destroys the awareness). Anything holding
 * `indexDoc`, `awareness` or `index` must drop it on `stop()` and re-read it after `start()`;
 * the `on*` subscriptions survive a restart.
 *
 * With a mapped `root`, `start()` also keeps the folder's notes (and, with `binaries`, its other
 * files through FileSyncer) and the index `files` map in step (DiskWatcher → Reconciler →
 * IndexStore, and back on remote changes).
 */
export class WorkspaceSession {
	readonly app: App;
	readonly connections: ConnectionManager;
	readonly workspaceId: string;
	readonly root: string | null;
	readonly user: SessionUser;
	readonly vaultId: string;
	readonly binaries: BinaryOptions | null;
	readonly indexName: string;
	readonly selfWrites = new SelfWriteRegistry();

	docs: IDocManager | null = null;
	presence: IPresence | null = null;
	navigator: INavigator | null = null;

	private doc: Y.Doc | null = null;
	private docAwareness: Awareness | null = null;
	private handle: OpenDocHandle | null = null;
	private store: IndexStore | null = null;
	private reconciler: Reconciler | null = null;
	/** Binary content sync while started with a folder and `binaries`; e2e reads `idle()`. */
	fileSyncer: FileSyncer | null = null;
	private teardown: (() => void)[] = [];
	private readonly indexListeners = new Set<IndexListener>();
	private readonly modifyListeners = new Set<(vaultPath: string) => void>();
	private readonly onlineListeners = new Set<() => void>();
	private readonly emitOnline = () => {
		for (const listener of this.onlineListeners) listener();
	};

	constructor(options: WorkspaceSessionOptions) {
		this.app = options.app;
		this.connections = options.connections;
		this.workspaceId = options.workspaceId;
		this.root = options.root;
		this.user = options.user;
		this.vaultId = options.vaultId;
		this.binaries = options.binaries ?? null;
		this.indexName = docName({ workspaceId: options.workspaceId, kind: "index" });
	}

	get started(): boolean {
		return this.handle !== null;
	}

	get indexDoc(): Y.Doc {
		if (!this.doc) throw new Error("workspace session is not started");
		return this.doc;
	}

	get awareness(): Awareness {
		if (!this.docAwareness) throw new Error("workspace session is not started");
		return this.docAwareness;
	}

	get indexProvider(): HocuspocusProvider {
		if (!this.handle) throw new Error("workspace session is not started");
		return this.handle.provider;
	}

	/** The index `files` map; null while stopped. */
	get index(): IndexStore | null {
		return this.store;
	}

	/** File id of a synced note at `vaultPath`, or null (also for binaries). */
	fileIdOf(vaultPath: string): string | null {
		const ws = this.root === null ? null : toWs(this.root, vaultPath);
		const meta = ws ? this.store?.get(ws) : null;
		return meta?.kind === "md" ? meta.id : null;
	}

	/** Vault path of the note with `fileId`, or null when it is not indexed. */
	vaultPathOf(fileId: string): string | null {
		const ws = this.store?.pathsOf(fileId)[0];
		return ws && this.root !== null ? toVault(this.root, ws) : null;
	}

	/** Index `files` deltas, local and remote; survives stop/start. Returns unsubscribe. */
	onIndexChange(listener: IndexListener): () => void {
		this.indexListeners.add(listener);
		return () => this.indexListeners.delete(listener);
	}

	/** User edits (not TeamSync's own writes) to synced notes, by vault path. */
	onDiskModify(listener: (vaultPath: string) => void): () => void {
		this.modifyListeners.add(listener);
		return () => this.modifyListeners.delete(listener);
	}

	/** Resolves once queued index ↔ disk work has finished (tests, shutdown). */
	settled(): Promise<void> {
		return this.reconciler?.idle() ?? Promise.resolve();
	}

	/** Users present on the index doc (this one included); 0 while stopped. */
	get online(): number {
		return this.presence?.users().size ?? this.docAwareness?.getStates().size ?? 0;
	}

	/** Fires when `online` may have changed; survives stop/start. Returns unsubscribe. */
	onOnlineChange(listener: () => void): () => void {
		this.onlineListeners.add(listener);
		return () => this.onlineListeners.delete(listener);
	}

	start(): void {
		if (this.handle) return;
		const doc = new Y.Doc();
		const awareness = new Awareness(doc);
		this.doc = doc;
		this.docAwareness = awareness;
		this.handle = this.connections.openDoc(this.indexName, doc, awareness);
		awareness.on("change", this.emitOnline);
		this.emitOnline();

		const store = new IndexStore(doc);
		this.store = store;
		this.teardown.push(
			store.observe((delta, local) => {
				for (const listener of this.indexListeners) listener(delta, local);
				if (!local) void this.reconciler?.applyRemote(delta);
			}),
		);
		if (this.root !== null) this.syncFolder(this.root, store, this.handle.provider);
		this.teardown.push(startNoteDocs(this));
		this.teardown.push(startPresence(this));
		this.emitOnline();
	}

	private syncFolder(root: string, index: IndexStore, provider: HocuspocusProvider): void {
		const binaries = this.binaries;
		const files = new ObsidianLocalFiles(this.app, root, this.selfWrites, binaries !== null);
		const fileSyncer = binaries
			? new FileSyncer({
					files,
					chunks: binaries.chunks,
					storage: window.localStorage,
					storageKey: `teamsync:${this.vaultId}:${this.workspaceId}:binhash`,
					userId: this.user.id,
					device: this.app.vault.getName(),
					maxBytes: binaries.maxBytes,
					isReadonly: () => provider.authorizedScope === "readonly",
					whenIndexAcked: () => untilAcked(provider),
					current: (path) => index.get(path),
					notify: (message) => new Notice(message, 15000),
				})
			: null;
		this.fileSyncer = fileSyncer;
		const reconciler = new Reconciler({
			index,
			files,
			known: new LocalStorageKnown(`teamsync:${this.vaultId}:${this.workspaceId}:known`, root),
			userId: this.user.id,
			isSynced: () => provider.synced,
			isAcked: () => !provider.hasUnsyncedChanges,
			binaries: fileSyncer,
		});
		this.reconciler = reconciler;
		const watcher = new DiskWatcher(
			this.app.vault,
			root,
			this.selfWrites,
			{
				create: (path) => void reconciler.localCreate(path),
				delete: (path) => void reconciler.localDelete(path),
				rename: (from, to) => void reconciler.localRename(from, to),
				modify: (path) => {
					if (syncKind(path) === "binary") {
						void reconciler.localModify(path);
						return;
					}
					const vaultPath = toVault(root, path);
					if (vaultPath) for (const listener of this.modifyListeners) listener(vaultPath);
				},
			},
			undefined,
			binaries !== null,
		);
		watcher.start();
		const onSynced = () => void reconciler.run();
		const onUnsynced = ({ number }: { number: number }) => {
			if (number === 0) void reconciler.checkpoint();
		};
		provider.on("synced", onSynced);
		provider.on("unsyncedChanges", onUnsynced);
		this.teardown.push(() => {
			provider.off("synced", onSynced);
			provider.off("unsyncedChanges", onUnsynced);
			watcher.stop();
			reconciler.dispose();
			fileSyncer?.dispose();
		});
		if (provider.synced) onSynced();
	}

	stop(): void {
		for (const fn of this.teardown.splice(0)) fn();
		this.reconciler = null;
		this.fileSyncer = null;
		this.store = null;
		this.selfWrites.clear();
		this.docAwareness?.off("change", this.emitOnline);
		this.handle?.close();
		this.handle = null;
		this.docAwareness?.destroy();
		this.docAwareness = null;
		this.doc?.destroy();
		this.doc = null;
		this.emitOnline();
	}
}

/** Resolves once the provider has no unacked local changes. */
function untilAcked(provider: HocuspocusProvider): Promise<void> {
	return new Promise((resolve) => {
		if (!provider.hasUnsyncedChanges) {
			resolve();
			return;
		}
		const onChange = ({ number }: { number: number }) => {
			if (number > 0) return;
			provider.off("unsyncedChanges", onChange);
			resolve();
		};
		provider.on("unsyncedChanges", onChange);
	});
}
