import type { HocuspocusProvider } from "@hocuspocus/provider";
import { FileMeta } from "@teamsync/shared";
import type { Awareness } from "y-protocols/awareness";
import * as Y from "yjs";
import { type DiskIO, DiskWriter } from "../../doc/DiskWriter";
import { DocManager, type DocManagerOptions } from "../../doc/DocManager";
import type { NoteDocDeps } from "../../doc/NoteDoc";
import type { IndexedNote, NoteIndex } from "../../doc/noteIndex";
import { RevTracker } from "../../doc/RevTracker";
import type { OpenDocHandle } from "../../net/ConnectionManager";
import { SelfWriteRegistry } from "../../workspace/SelfWriteRegistry";

/** In-memory vault files. */
export class FakeDisk implements DiskIO {
	readonly files = new Map<string, string>();
	writes = 0;
	/** Runs before `process` reads, to simulate an edit racing a write. */
	beforeProcess: ((path: string) => void) | null = null;

	constructor(initial: Record<string, string> = {}) {
		for (const [path, text] of Object.entries(initial)) this.files.set(path, text);
	}

	async read(path: string): Promise<string | null> {
		return this.files.get(path) ?? null;
	}

	async process(path: string, fn: (current: string) => string): Promise<boolean> {
		this.beforeProcess?.(path);
		const current = this.files.get(path);
		if (current === undefined) return false;
		const next = fn(current);
		if (next !== current) this.writes++;
		this.files.set(path, next);
		return true;
	}

	exists(path: string): boolean {
		return this.files.has(path);
	}

	async create(path: string, text: string): Promise<void> {
		if (this.files.has(path)) throw new Error(`exists: ${path}`);
		this.files.set(path, text);
	}
}

type Listener = (data: never) => void;

/** The provider surface the doc layer reads; driven by `FakeRelay`. */
export class FakeProvider {
	synced = false;
	authorizedScope: "read-write" | "readonly" | undefined = undefined;
	unsyncedChanges = 0;
	destroyed = false;
	private readonly listeners = new Map<string, Set<Listener>>();

	get hasUnsyncedChanges(): boolean {
		return this.unsyncedChanges > 0;
	}

	on(event: string, fn: Listener): this {
		let set = this.listeners.get(event);
		if (!set) {
			set = new Set();
			this.listeners.set(event, set);
		}
		set.add(fn);
		return this;
	}

	off(event: string, fn: Listener): this {
		this.listeners.get(event)?.delete(fn);
		return this;
	}

	emit(event: string, data?: unknown): void {
		for (const fn of [...(this.listeners.get(event) ?? [])]) (fn as (d: unknown) => void)(data);
	}

	setUnsynced(n: number): void {
		this.unsyncedChanges = n;
		this.emit("unsyncedChanges", { number: n });
	}
}

interface Client {
	ydoc: Y.Doc;
	provider: FakeProvider;
	readonly: boolean;
}

/**
 * A relay for unit tests: one server Y.Doc per name, updates relayed to every attached client,
 * sync on attach (async), acks after a tick unless `autoAck` is off. `online = false` keeps new
 * attaches unsynced and drops nothing (clients keep their state, as IndexedDB would).
 */
export class FakeRelay {
	online = true;
	autoAck = true;
	readonly servers = new Map<string, Y.Doc>();
	readonly clients = new Map<string, Set<Client>>();
	private readonly statusListeners = new Set<() => void>();
	/** Unacked counts per provider while `autoAck` is off. */
	private readonly pendingAcks = new Map<FakeProvider, number>();
	readonly frames = { attaches: 0, updates: 0 };

	server(name: string): Y.Doc {
		let doc = this.servers.get(name);
		if (!doc) {
			doc = new Y.Doc();
			this.servers.set(name, doc);
		}
		return doc;
	}

	isOffline = (): boolean => !this.online;

	/** Like `ConnectionManager.onStateChange`: the listener also runs right away. */
	onConnectionChange = (listener: () => void): (() => void) => {
		this.statusListeners.add(listener);
		listener();
		return () => this.statusListeners.delete(listener);
	};

	get statusListenerCount(): number {
		return this.statusListeners.size;
	}

	setOnline(online: boolean): void {
		this.online = online;
		for (const set of this.clients.values()) {
			for (const client of set) {
				if (online) this.sync(client, this.nameOf(client));
				else client.provider.synced = false;
			}
		}
		for (const listener of [...this.statusListeners]) listener();
	}

	open = (name: string, ydoc: Y.Doc, _awareness: Awareness, readonly = false): OpenDocHandle => {
		this.frames.attaches++;
		const provider = new FakeProvider();
		const client: Client = { ydoc, provider, readonly };
		let set = this.clients.get(name);
		if (!set) {
			set = new Set();
			this.clients.set(name, set);
		}
		set.add(client);
		const onUpdate = (update: Uint8Array, origin: unknown) => {
			if (origin === provider || !this.online || !provider.synced) return;
			this.frames.updates++;
			provider.setUnsynced(provider.unsyncedChanges + 1);
			if (!client.readonly) this.broadcast(name, client, update);
			this.ack(provider, client.readonly);
		};
		ydoc.on("update", onUpdate);
		setTimeout(() => this.sync(client, name), 0);
		return {
			provider: provider as unknown as HocuspocusProvider,
			presence: null,
			close: () => {
				provider.destroyed = true;
				ydoc.off("update", onUpdate);
				set.delete(client);
			},
		};
	};

	/** Acks every update held back while `autoAck` was off. */
	flushAcks(): void {
		for (const [provider, n] of this.pendingAcks) {
			this.pendingAcks.delete(provider);
			provider.setUnsynced(Math.max(0, provider.unsyncedChanges - n));
		}
	}

	/** Server-side text of a note doc. */
	text(name: string): string {
		return this.server(name).getText("contents").toString();
	}

	/** Writes to the server doc as another (closed) device would, relaying to attached clients. */
	remoteEdit(name: string, fn: (doc: Y.Doc) => void): void {
		const scratch = new Y.Doc();
		Y.applyUpdate(scratch, Y.encodeStateAsUpdate(this.server(name)));
		const before = Y.encodeStateVector(scratch);
		fn(scratch);
		this.broadcast(name, null, Y.encodeStateAsUpdate(scratch, before));
	}

	private nameOf(client: Client): string {
		for (const [name, set] of this.clients) if (set.has(client)) return name;
		throw new Error("unknown client");
	}

	private sync(client: Client, name: string): void {
		const { ydoc, provider } = client;
		if (!this.online || provider.destroyed || provider.synced) return;
		provider.authorizedScope = client.readonly ? "readonly" : "read-write";
		const server = this.server(name);
		Y.applyUpdate(ydoc, Y.encodeStateAsUpdate(server, Y.encodeStateVector(ydoc)), provider);
		const missing = Y.encodeStateAsUpdate(ydoc, Y.encodeStateVector(server));
		provider.setUnsynced(1);
		provider.synced = true;
		provider.emit("synced", { state: true });
		if (!client.readonly) this.broadcast(name, client, missing);
		this.ack(provider, client.readonly);
	}

	private ack(provider: FakeProvider, readonly: boolean): void {
		if (readonly) return;
		if (!this.autoAck) {
			this.pendingAcks.set(provider, (this.pendingAcks.get(provider) ?? 0) + 1);
			return;
		}
		setTimeout(() => provider.setUnsynced(Math.max(0, provider.unsyncedChanges - 1)), 0);
	}

	private broadcast(name: string, from: Client | null, update: Uint8Array): void {
		Y.applyUpdate(this.server(name), update);
		for (const other of this.clients.get(name) ?? []) {
			if (other !== from && other.provider.synced)
				Y.applyUpdate(other.ydoc, update, other.provider);
		}
	}
}

export class MemoryStorage {
	readonly map = new Map<string, string>();
	getItem(key: string): string | null {
		return this.map.get(key) ?? null;
	}
	setItem(key: string, value: string): void {
		this.map.set(key, value);
	}
}

let deviceSeq = 0;

export interface DeviceOptions {
	relay: FakeRelay;
	disk?: FakeDisk;
	name?: string;
	/** Keep IndexedDB from an earlier device with this vault id (a relaunch). */
	vaultId?: string;
	readonly?: boolean;
	warmDocs?: number;
	flushDelayMs?: number;
	paths?: Record<string, string>;
	/** Resolves note paths; default: the `paths` table. */
	pathOf?: (fileId: string) => string | null;
	revs?: Y.Map<unknown>;
	storage?: MemoryStorage;
	revThrottleMs?: number;
	notices?: string[];
}

/** One vault: its disk, DocManager and RevTracker against a shared FakeRelay. */
export function device(options: DeviceOptions) {
	const name = options.name ?? `dev${++deviceSeq}`;
	const vaultId = options.vaultId ?? `${name}-${deviceSeq}-${Math.random().toString(36).slice(2)}`;
	const disk = options.disk ?? new FakeDisk();
	const selfWrites = new SelfWriteRegistry();
	const writer = new DiskWriter(disk, selfWrites);
	const notices = options.notices ?? [];
	const paths = options.paths ?? {};
	const storage = options.storage ?? new MemoryStorage();
	const revs = options.revs ?? new Y.Doc().getMap<unknown>("docRevs");
	const revTracker = new RevTracker({
		revs,
		userId: name,
		storage,
		keyPrefix: `teamsync:${vaultId}:ws1`,
		throttleMs: options.revThrottleMs,
	});
	const note: NoteDocDeps = {
		vaultId,
		workspaceId: "ws1",
		open: (docNameValue, ydoc, awareness) =>
			options.relay.open(docNameValue, ydoc, awareness, options.readonly),
		isOffline: options.relay.isOffline,
		onConnectionChange: options.relay.onConnectionChange,
	};
	const managerOptions: DocManagerOptions = {
		note,
		reconcile: {
			writer,
			device: name,
			now: () => new Date(2026, 10, 18, 9, 30),
			notify: (m) => notices.push(m),
		},
		track: (n) => revTracker.track(n),
		pathOf: options.pathOf ?? ((fileId) => paths[fileId] ?? null),
		warmDocs: options.warmDocs ?? 20,
		flushDelayMs: options.flushDelayMs ?? 10,
	};
	const docs = new DocManager(managerOptions);
	return {
		name,
		vaultId,
		disk,
		selfWrites,
		writer,
		docs,
		revTracker,
		revs,
		storage,
		notices,
		paths,
	};
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function waitUntil(fn: () => boolean, timeoutMs = 2000): Promise<void> {
	const start = Date.now();
	while (!fn()) {
		if (Date.now() - start > timeoutMs) throw new Error("waitUntil timed out");
		await sleep(5);
	}
}

export const noteName = (fileId: string) => `ws:ws1:md:${fileId}`;

/** `NoteIndex` read straight from a `files` Y.Map whose keys are relative to `root`. */
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
		return this.notes().find((n) => n.fileId === fileId)?.path ?? null;
	}

	idOf(path: string): string | null {
		const key = path.slice(this.root.length + 1);
		return this.toNote(key, this.files.get(key))?.fileId ?? null;
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
