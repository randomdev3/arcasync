import type { HocuspocusProvider } from "@hocuspocus/provider";
import { docName } from "@teamsync/shared";
import type { App } from "obsidian";
import { Awareness } from "y-protocols/awareness";
import * as Y from "yjs";
import type { ConnectionManager, OpenDocHandle } from "../net/ConnectionManager";
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
}

/**
 * Everything one connected workspace owns. The session owns the index doc; the subsystems in
 * the `docs`, `presence` and `navigator` slots hang off it.
 *
 * Lifetime: `start()` creates a fresh index Y.Doc and Awareness and attaches them; `stop()`
 * detaches and destroys both (the provider destroys the awareness). Anything holding
 * `indexDoc` or `awareness` must drop it on `stop()` and re-read it after `start()`.
 */
export class WorkspaceSession {
	readonly app: App;
	readonly connections: ConnectionManager;
	readonly workspaceId: string;
	readonly root: string | null;
	readonly user: SessionUser;
	readonly vaultId: string;
	readonly indexName: string;
	readonly selfWrites = new SelfWriteRegistry();

	docs: IDocManager | null = null;
	presence: IPresence | null = null;
	navigator: INavigator | null = null;

	private doc: Y.Doc | null = null;
	private docAwareness: Awareness | null = null;
	private handle: OpenDocHandle | null = null;

	constructor(options: WorkspaceSessionOptions) {
		this.app = options.app;
		this.connections = options.connections;
		this.workspaceId = options.workspaceId;
		this.root = options.root;
		this.user = options.user;
		this.vaultId = options.vaultId;
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

	start(): void {
		if (this.handle) return;
		const doc = new Y.Doc();
		const awareness = new Awareness(doc);
		this.doc = doc;
		this.docAwareness = awareness;
		this.handle = this.connections.openDoc(this.indexName, doc, awareness);
	}

	stop(): void {
		this.selfWrites.clear();
		this.handle?.close();
		this.handle = null;
		this.docAwareness?.destroy();
		this.docAwareness = null;
		this.doc?.destroy();
		this.doc = null;
	}
}
