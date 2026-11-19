import * as Y from "yjs";
import { ChunkNotFoundError } from "../files/ChunkClient";
import type { BinaryFiles, ChunkTransfer, FileStat } from "../files/FileSyncer";
import { FileSyncer } from "../files/FileSyncer";
import { IndexStore } from "../workspace/IndexStore";
import type { KnownStore, LocalFiles } from "../workspace/LocalFiles";
import { Reconciler } from "../workspace/Reconciler";

export const REMOTE = "remote";

/**
 * In-memory `LocalFiles` (and `BinaryFiles`); `ops` logs every write the reconciler or the
 * FileSyncer makes. A binary's bytes live in `bytes`; `edit` is a user write (new mtime).
 */
export class FakeFiles implements LocalFiles, BinaryFiles {
	readonly files = new Set<string>();
	readonly ops: string[] = [];
	readonly bytes = new Map<string, Uint8Array>();
	private readonly mtimes = new Map<string, number>();
	/** Reported sizes that differ from the bytes held (a large file without the memory). */
	readonly sizes = new Map<string, number>();
	private tick = 0;

	constructor(paths: string[] = []) {
		for (const p of paths) this.files.add(p);
	}
	list(): string[] {
		return [...this.files].sort();
	}
	exists(path: string): boolean {
		return this.files.has(path);
	}
	async create(path: string): Promise<void> {
		if (this.files.has(path)) throw new Error(`exists: ${path}`);
		this.ops.push(`create ${path}`);
		this.files.add(path);
	}
	async rename(from: string, to: string): Promise<void> {
		if (!this.files.has(from) || this.files.has(to)) throw new Error(`rename ${from} → ${to}`);
		this.ops.push(`rename ${from} → ${to}`);
		this.files.delete(from);
		this.files.add(to);
		for (const map of [this.bytes, this.mtimes, this.sizes] as Map<string, unknown>[]) {
			if (map.has(from)) map.set(to, map.get(from));
			map.delete(from);
		}
	}
	async trash(path: string): Promise<void> {
		this.ops.push(`trash ${path}`);
		this.files.delete(path);
		this.bytes.delete(path);
	}

	/** A user (not ArcaSync) writes `data` at `path`. */
	edit(path: string, data: Uint8Array): void {
		this.files.add(path);
		this.bytes.set(path, data);
		this.mtimes.set(path, ++this.tick);
	}
	stat(path: string): FileStat | null {
		if (!this.files.has(path)) return null;
		const size = this.sizes.get(path) ?? this.bytes.get(path)?.byteLength ?? 0;
		return { size, mtime: this.mtimes.get(path) ?? 0 };
	}
	async readBinary(path: string): Promise<ArrayBuffer | null> {
		const data = this.files.has(path) ? this.bytes.get(path) : undefined;
		return data ? (data.slice().buffer as ArrayBuffer) : null;
	}
	async writeBinary(path: string, data: ArrayBuffer): Promise<void> {
		this.ops.push(`write ${path}`);
		this.edit(path, new Uint8Array(data));
	}
}

/** The relay's R2 chunks in memory; `log` records every request in order. */
export class MemChunks implements ChunkTransfer {
	readonly store = new Map<string, Uint8Array>();
	readonly log: string[] = [];

	async missing(shas: string[]): Promise<string[]> {
		this.log.push(`missing ${shas.length}`);
		return shas.filter((sha) => !this.store.has(sha));
	}
	async put(sha: string, bytes: Uint8Array): Promise<void> {
		this.log.push(`put ${sha.slice(0, 8)}`);
		this.store.set(sha, bytes.slice());
	}
	async get(sha: string): Promise<Uint8Array> {
		this.log.push(`get ${sha.slice(0, 8)}`);
		const bytes = this.store.get(sha);
		if (!bytes) throw new ChunkNotFoundError(sha);
		return bytes.slice();
	}
	puts(): number {
		return this.log.filter((l) => l.startsWith("put")).length;
	}
}

/** A Storage-like map for FileSyncer's synced hashes. */
export class MemStorage {
	readonly items = new Map<string, string>();
	getItem(key: string): string | null {
		return this.items.get(key) ?? null;
	}
	setItem(key: string, value: string): void {
		this.items.set(key, value);
	}
}

export class MemKnown implements KnownStore {
	constructor(public value: Record<string, string> = {}) {}
	load(): Record<string, string> {
		return { ...this.value };
	}
	save(known: Record<string, string>): void {
		this.value = { ...known };
	}
}

export const clock = { t: 1000 };

/** One vault: an index doc, a fake disk, `known`, and a reconciler wired like the session. */
export class Device {
	readonly doc = new Y.Doc();
	readonly index = new IndexStore(this.doc);
	readonly files: FakeFiles;
	readonly known: MemKnown;
	readonly reconciler: Reconciler;
	synced = true;
	acked = true;
	/** Local (non-remote) doc updates: what would become relay rows. */
	writes = 0;
	private seq = 0;

	readonly syncer: FileSyncer | null;
	readonly storage = new MemStorage();
	readonly notices: string[] = [];
	readonly: boolean;
	private ackWaiters: Array<() => void> = [];

	constructor(
		readonly name: string,
		{
			disk = [],
			known = {},
			chunks,
			maxBytes = Number.POSITIVE_INFINITY,
			readonly = false,
		}: {
			disk?: string[];
			known?: Record<string, string>;
			/** Turns on binary sync against this chunk store. */
			chunks?: MemChunks;
			maxBytes?: number;
			readonly?: boolean;
		} = {},
	) {
		this.files = new FakeFiles(disk);
		this.known = new MemKnown(known);
		this.readonly = readonly;
		this.syncer = chunks
			? new FileSyncer({
					files: this.files,
					chunks,
					storage: this.storage,
					storageKey: "binhash",
					userId: name,
					device: name,
					maxBytes,
					isReadonly: () => this.readonly,
					whenIndexAcked: () =>
						this.acked ? Promise.resolve() : new Promise((r) => this.ackWaiters.push(r)),
					current: (path) => this.index.get(path),
					notify: (message) => this.notices.push(message),
					now: () => new Date(2026, 10, 19, 13, 5).getTime(),
				})
			: null;
		this.reconciler = new Reconciler({
			index: this.index,
			files: this.files,
			known: this.known,
			userId: name,
			isSynced: () => this.synced,
			isAcked: () => this.acked,
			binaries: this.syncer,
			now: () => clock.t,
			newId: () => `${name}${++this.seq}`,
		});
		this.index.observe((delta, local) => {
			if (!local) void this.reconciler.applyRemote(delta);
		});
		this.doc.on("update", (_u: Uint8Array, origin: unknown) => {
			if (origin !== REMOTE) this.writes++;
		});
	}

	meta(id: string, extra: Record<string, unknown> = {}) {
		return { id, kind: "md" as const, updatedBy: this.name, updatedAt: clock.t, ...extra };
	}

	/** The relay acks every index change so far. */
	ack(): void {
		this.acked = true;
		for (const resolve of this.ackWaiters.splice(0)) resolve();
	}

	/** Waits until the reconciler queue and the FileSyncer (whose results re-enter it) are idle. */
	async idle(): Promise<void> {
		for (let i = 0; i < 5; i++) {
			await this.reconciler.idle();
			await this.syncer?.idle();
			await new Promise((r) => setTimeout(r, 0));
			await this.reconciler.idle();
		}
	}
}

/** Sends each doc what the other lacks, as a remote transaction. */
export function exchange(a: Device, b: Device): void {
	Y.applyUpdate(b.doc, Y.encodeStateAsUpdate(a.doc, Y.encodeStateVector(b.doc)), REMOTE);
	Y.applyUpdate(a.doc, Y.encodeStateAsUpdate(b.doc, Y.encodeStateVector(a.doc)), REMOTE);
}

/**
 * Exchanges and drains until no device writes anything new; returns the rounds needed. Throws
 * if the devices keep writing (an echo loop).
 */
export async function settle(devices: Device[], maxRounds = 10): Promise<number> {
	for (let round = 1; round <= maxRounds; round++) {
		const before = devices.reduce((n, d) => n + d.writes, 0);
		for (const a of devices) for (const b of devices) if (a !== b) exchange(a, b);
		await Promise.all(devices.map((d) => d.idle()));
		await Promise.all(devices.map((d) => d.idle()));
		if (devices.reduce((n, d) => n + d.writes, 0) === before) return round;
	}
	throw new Error(`devices still writing after ${maxRounds} rounds`);
}

export function snapshot(d: Device): Record<string, string> {
	return Object.fromEntries(d.index.entries().map((e) => [e.path, e.meta.id]));
}
