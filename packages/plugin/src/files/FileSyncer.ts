import { type Chunk, chunkFile, type FileMeta, fileHash, mimeForPath } from "@arcasync/shared";
import { ChunkNotFoundError } from "./ChunkClient";

/** The chunk routes FileSyncer uses; `ChunkClient` in the app, an in-memory store in tests. */
export interface ChunkTransfer {
	missing(shas: string[]): Promise<string[]>;
	put(sha: string, bytes: Uint8Array): Promise<void>;
	get(sha: string): Promise<Uint8Array>;
}

export interface FileStat {
	size: number;
	mtime: number;
}

/** Binary file access by workspace path. Every write registers a self-write first. */
export interface BinaryFiles {
	exists(path: string): boolean;
	/** Size and mtime without reading; null when there is no such file. */
	stat(path: string): FileStat | null;
	readBinary(path: string): Promise<ArrayBuffer | null>;
	/** Creates the file (and its folders) or replaces its content. */
	writeBinary(path: string, data: ArrayBuffer): Promise<void>;
	rename(from: string, to: string): Promise<void>;
}

/** The localStorage subset FileSyncer uses. */
export interface KeyValueStore {
	getItem(key: string): string | null;
	setItem(key: string, value: string): void;
}

/** What a sync asks of the Reconciler: index `index` at the path, and/or add `aside` as new. */
export interface BinaryOutcome {
	index?: FileMeta;
	/** A locally changed file was renamed here before the remote version replaced it. */
	aside?: string;
}

export interface FileSyncerOptions {
	files: BinaryFiles;
	chunks: ChunkTransfer;
	storage: KeyValueStore;
	/** localStorage key of the synced-hash record, `teamsync:<vaultId>:<workspaceId>:binhash`. */
	storageKey: string;
	userId: string;
	/** Device label used in conflict-copy names. */
	device: string;
	/** Larger files are skipped (`limits().maxBinaryBytes`, capped by the server's `maxFileBytes`). */
	maxBytes: number;
	/** This user may only read the workspace (a viewer). */
	isReadonly(): boolean;
	/** Resolves once the relay has acked every local index change. */
	whenIndexAcked(): Promise<void>;
	/** The index entry at a workspace path now, or null. */
	current(path: string): FileMeta | null;
	notify(message: string): void;
	now?: () => number;
}

/** A file's content as last synced on this device (file id → hash, plus the stat it had). */
interface Synced extends FileStat {
	hash: string;
}

interface LocalRead {
	stat: FileStat;
	bytes: Uint8Array;
	chunks: Chunk[];
	hash: string;
}

const JOBS = 2;

/**
 * Syncs binary files through R2 chunks (P2-11). The Reconciler owns paths (add, rename, delete);
 * FileSyncer owns content: `sync` compares a file with its index entry and uploads or downloads,
 * off the Reconciler's queue. Its outcome goes back to the Reconciler, which alone writes the
 * index, and only after the chunks exist.
 *
 * - Upload: size and role checks first, then one read, `chunkFile`, `missing`, PUT the missing
 *   chunks, and the meta to index. After the relay acks the index entry, `missing` is asked again
 *   and anything collected in between is re-uploaded (D13).
 * - Download: every chunk, checked against its sha256 and the entry's `fileHash`. A local file
 *   changed since it last synced, and different from the entry, is renamed aside first
 *   (`<name> (conflict <device> <YYYYMMDDHHmm>).<ext>`) and comes back as `aside`.
 * - "Changed since it last synced" compares with the hash recorded per file id after the last
 *   upload ack or download, with its size and mtime: an unchanged stat needs no read.
 *
 * Jobs for one path run in order; at most `JOBS` run at once.
 */
export class FileSyncer {
	private readonly options: FileSyncerOptions;
	private readonly now: () => number;
	private readonly synced: Map<string, Synced>;
	/** Local hashes read this session: path → hash at a stat. */
	private readonly hashes = new Map<string, Synced>();
	/** Uploads indexed but not yet acked: `id:hash` → the stat that was read. */
	private readonly uploads = new Map<string, FileStat>();
	private readonly tails = new Map<string, Promise<unknown>>();
	/** Not yet started jobs by `path|id|hash`, so a repeated request joins the queued one. */
	private readonly queued = new Map<string, Promise<BinaryOutcome>>();
	private readonly pending = new Set<Promise<unknown>>();
	/** Paths whose download found a chunk missing; retried on the next index change. */
	private readonly waitingPaths = new Set<string>();
	private readonly warned = new Set<string>();
	private active = 0;
	private readonly slots: Array<() => void> = [];
	private disposed = false;
	private stopWaiting: () => void = () => {};
	private readonly stopped = new Promise<void>((resolve) => {
		this.stopWaiting = resolve;
	});

	constructor(options: FileSyncerOptions) {
		this.options = options;
		this.now = options.now ?? Date.now;
		this.synced = new Map(Object.entries(this.load()));
	}

	/**
	 * Brings the file at `path` and its index entry `meta` (null: none yet, the file is new under
	 * `id`) into agreement. Never rejects; a failure is logged and retried by a later run.
	 */
	sync(path: string, id: string, meta: FileMeta | null): Promise<BinaryOutcome> {
		const key = `${path}|${id}|${meta?.hash ?? ""}`;
		const queued = this.queued.get(key);
		if (queued) return queued;
		const previous = this.tails.get(path) ?? Promise.resolve();
		const job = previous
			.then(async () => {
				this.queued.delete(key);
				await this.slot();
				try {
					return this.disposed ? {} : await this.run(path, id, meta);
				} finally {
					this.release();
				}
			})
			.catch((error: unknown) => {
				console.error(`[TeamSync] syncing ${path} failed`, error);
				return {};
			});
		this.queued.set(key, job);
		this.tails.set(path, job);
		this.track(job);
		void job.then(() => {
			if (this.tails.get(path) === job) this.tails.delete(path);
		});
		return job;
	}

	/**
	 * The Reconciler indexed `meta` (from an upload) at `path`. Once the relay acks it, the hash is
	 * recorded as synced and chunks collected meanwhile are uploaded again.
	 */
	indexed(path: string, meta: FileMeta): void {
		const key = `${meta.id}:${meta.hash}`;
		const stat = this.uploads.get(key);
		if (!stat || !meta.hash) return;
		const hash = meta.hash;
		const recheck = async () => {
			if (this.disposed) return;
			this.uploads.delete(key);
			this.record(meta.id, { hash, ...stat });
			const gone = await this.options.chunks.missing(meta.chunks ?? []);
			if (gone.length === 0 || this.disposed) return;
			const read = await this.read(path);
			if (read?.hash !== hash) return;
			await this.putChunks(read.chunks, new Set(gone));
		};
		// Waiting for the ack is not work in flight: `idle()` does not wait for it.
		void Promise.race([this.options.whenIndexAcked(), this.stopped]).then(() =>
			this.track(
				recheck().catch((error: unknown) =>
					console.error(`[TeamSync] re-checking the chunks of ${path} failed`, error),
				),
			),
		);
	}

	/** Paths waiting for a chunk that was not uploaded yet. */
	waiting(): string[] {
		return [...this.waitingPaths];
	}

	/** Drops the synced hashes of files no longer indexed. */
	prune(ids: Set<string>): void {
		let changed = false;
		for (const id of this.synced.keys()) {
			if (!ids.has(id) && ![...this.uploads.keys()].some((k) => k.startsWith(`${id}:`))) {
				this.synced.delete(id);
				changed = true;
			}
		}
		if (changed) this.save();
	}

	/** Resolves once no job or ack re-check is running. */
	async idle(): Promise<void> {
		while (this.pending.size > 0) await Promise.all([...this.pending]);
	}

	dispose(): void {
		this.disposed = true;
		this.stopWaiting();
	}

	private async run(path: string, id: string, meta: FileMeta | null): Promise<BinaryOutcome> {
		const stat = this.options.files.stat(path);
		if (!stat) return meta ? this.download(path, meta) : {};
		if (!meta) {
			const index = await this.upload(path, id, stat);
			return index ? { index } : {};
		}
		if (meta.kind !== "binary" || !meta.hash) return {};
		if (this.tooLarge(path, stat.size)) return {};
		let read: LocalRead | null = null;
		let local = this.knownHash(path, meta.id, stat);
		if (local === null) {
			read = await this.read(path);
			if (!read) return {};
			local = read.hash;
		}
		if (local === meta.hash) {
			if (this.synced.get(meta.id)?.hash !== local) this.record(meta.id, { hash: local, ...stat });
			return {};
		}
		// Unchanged remotely since this device last synced it: the local edit wins.
		if (this.synced.get(meta.id)?.hash === meta.hash) {
			const index = await this.upload(path, meta.id, stat, read);
			return index ? { index } : {};
		}
		return this.download(path, meta);
	}

	private async upload(
		path: string,
		id: string,
		stat: FileStat,
		read: LocalRead | null = null,
	): Promise<FileMeta | null> {
		if (this.tooLarge(path, stat.size)) return null;
		if (this.options.isReadonly()) {
			this.warnOnce(
				`readonly:${path}`,
				`TeamSync: you can only view this workspace; ${path} is not uploaded.`,
			);
			return null;
		}
		const local = read ?? (await this.read(path));
		if (!local) return null;
		const shas = local.chunks.map((c) => c.sha256);
		const missing = new Set(await this.options.chunks.missing(shas));
		await this.putChunks(local.chunks, missing);
		this.uploads.set(`${id}:${local.hash}`, local.stat);
		return {
			id,
			kind: "binary",
			hash: local.hash,
			size: local.bytes.byteLength,
			mtime: local.stat.mtime,
			chunks: shas,
			mime: mimeForPath(path),
			updatedBy: this.options.userId,
			updatedAt: this.now(),
		};
	}

	private async putChunks(chunks: Chunk[], wanted: Set<string>): Promise<void> {
		const sent = new Set<string>();
		const puts: Promise<void>[] = [];
		for (const chunk of chunks) {
			if (!wanted.has(chunk.sha256) || sent.has(chunk.sha256)) continue;
			sent.add(chunk.sha256);
			puts.push(this.options.chunks.put(chunk.sha256, chunk.bytes));
		}
		await Promise.all(puts);
	}

	private async download(path: string, meta: FileMeta): Promise<BinaryOutcome> {
		const shas = meta.chunks;
		if (meta.kind !== "binary" || !meta.hash || !shas) return {};
		if (this.tooLarge(path, meta.size ?? 0)) return {};
		if ((await fileHash(shas)) !== meta.hash) {
			console.warn(`[TeamSync] ${path}: index entry does not match its chunks; skipped`);
			return {};
		}
		let parts: Uint8Array[];
		try {
			parts = await Promise.all(shas.map((sha) => this.options.chunks.get(sha)));
		} catch (error) {
			if (!(error instanceof ChunkNotFoundError)) throw error;
			this.waitingPaths.add(path);
			this.warnOnce(`waiting:${path}:${meta.hash}`, `TeamSync: ${path}: waiting for upload`);
			return {};
		}
		this.waitingPaths.delete(path);
		const bytes = concat(parts);
		if (meta.size !== undefined && bytes.byteLength !== meta.size) {
			console.warn(`[TeamSync] ${path}: downloaded size does not match its index entry`);
			return {};
		}
		// The entry may have moved on during the download; the next sync fetches the new one.
		const now = this.options.current(path);
		if (this.disposed || now?.id !== meta.id || now.hash !== meta.hash) return {};

		let aside: string | undefined;
		const stat = this.options.files.stat(path);
		if (stat) {
			const local = this.knownHash(path, meta.id, stat) ?? (await this.read(path))?.hash;
			if (local === meta.hash) {
				this.record(meta.id, { hash: meta.hash, ...stat });
				return {};
			}
			if (local !== this.synced.get(meta.id)?.hash) {
				aside = this.conflictPath(path);
				await this.options.files.rename(path, aside);
			}
		}
		await this.options.files.writeBinary(path, toArrayBuffer(bytes));
		const written = this.options.files.stat(path) ?? { size: bytes.byteLength, mtime: 0 };
		this.record(meta.id, { hash: meta.hash, ...written });
		return aside ? { aside } : {};
	}

	/** The local hash when the stat says the file has not changed since it was hashed. */
	private knownHash(path: string, id: string, stat: FileStat): string | null {
		for (const entry of [this.synced.get(id), this.hashes.get(path)]) {
			if (entry && entry.size === stat.size && entry.mtime === stat.mtime) return entry.hash;
		}
		return null;
	}

	/** One read of the file: its chunks and `fileHash`. */
	private async read(path: string): Promise<LocalRead | null> {
		const stat = this.options.files.stat(path);
		const data = await this.options.files.readBinary(path);
		if (!stat || !data) return null;
		const bytes = new Uint8Array(data);
		const chunks = await chunkFile(bytes);
		const hash = await fileHash(chunks.map((c) => c.sha256));
		this.hashes.set(path, { hash, ...stat });
		return { stat, bytes, chunks, hash };
	}

	private tooLarge(path: string, size: number): boolean {
		const max = this.options.maxBytes;
		if (size <= max) return false;
		const limit = `${Math.round((max / 1048576) * 10) / 10} MiB`;
		this.warnOnce(
			`large:${path}`,
			`TeamSync: ${path} is larger than ${limit} and is not synced on this device.`,
		);
		return true;
	}

	private warnOnce(key: string, message: string): void {
		if (this.warned.has(key)) return;
		this.warned.add(key);
		console.warn(message);
		this.options.notify(message);
	}

	private conflictPath(path: string): string {
		const slash = path.lastIndexOf("/");
		const dot = path.lastIndexOf(".");
		const [stem, ext] = dot > slash + 1 ? [path.slice(0, dot), path.slice(dot)] : [path, ""];
		const at = new Date(this.now());
		const pad = (n: number) => String(n).padStart(2, "0");
		const stamp = `${at.getFullYear()}${pad(at.getMonth() + 1)}${pad(at.getDate())}${pad(at.getHours())}${pad(at.getMinutes())}`;
		const who = this.options.device.replace(/[\\/:*?"<>|#^[\]]+/g, "-").trim() || "device";
		const base = `${stem} (conflict ${who} ${stamp}`;
		const free = (p: string) => !this.options.files.exists(p) && !this.options.current(p);
		let candidate = `${base})${ext}`;
		for (let n = 2; !free(candidate); n++) candidate = `${base} ${n})${ext}`;
		return candidate;
	}

	private record(id: string, synced: Synced): void {
		this.synced.set(id, synced);
		this.save();
	}

	private load(): Record<string, Synced> {
		try {
			const raw = this.options.storage.getItem(this.options.storageKey);
			const parsed = raw ? (JSON.parse(raw) as unknown) : null;
			if (!parsed || typeof parsed !== "object") return {};
			return Object.fromEntries(
				Object.entries(parsed).filter(
					(e): e is [string, Synced] =>
						typeof e[1]?.hash === "string" &&
						typeof e[1]?.size === "number" &&
						typeof e[1]?.mtime === "number",
				),
			);
		} catch {
			return {};
		}
	}

	private save(): void {
		try {
			this.options.storage.setItem(
				this.options.storageKey,
				JSON.stringify(Object.fromEntries(this.synced)),
			);
		} catch (error) {
			console.error("[TeamSync] could not persist binary sync state", error);
		}
	}

	private track(promise: Promise<unknown>): void {
		this.pending.add(promise);
		void promise.finally(() => this.pending.delete(promise));
	}

	private slot(): Promise<void> {
		if (this.active < JOBS) {
			this.active++;
			return Promise.resolve();
		}
		return new Promise((resolve) => this.slots.push(resolve));
	}

	private release(): void {
		const next = this.slots.shift();
		if (next) next();
		else this.active--;
	}
}

function concat(parts: Uint8Array[]): Uint8Array {
	if (parts.length === 1 && parts[0]) return parts[0];
	const out = new Uint8Array(parts.reduce((n, p) => n + p.byteLength, 0));
	let offset = 0;
	for (const part of parts) {
		out.set(part, offset);
		offset += part.byteLength;
	}
	return out;
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
	return bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength
		? (bytes.buffer as ArrayBuffer)
		: (bytes.slice().buffer as ArrayBuffer);
}
