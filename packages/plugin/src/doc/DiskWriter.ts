import type { Vault } from "obsidian";
import type { SelfWriteRegistry } from "../workspace/SelfWriteRegistry";
import { textHash } from "./diskText";

/** The vault operations the doc layer needs; `ObsidianDisk` in the app, an in-memory fake in tests. */
export interface DiskIO {
	/** Raw content, or null when the file does not exist. */
	read(path: string): Promise<string | null>;
	/** Writes whatever `fn` returns for the current content (atomic). False when the file is missing. */
	process(path: string, fn: (current: string) => string): Promise<boolean>;
	exists(path: string): boolean;
	/** Creates a new file (and missing parent folders). */
	create(path: string, text: string): Promise<void>;
}

export class ObsidianDisk implements DiskIO {
	constructor(private readonly vault: Vault) {}

	async read(path: string): Promise<string | null> {
		const file = this.vault.getFileByPath(path);
		return file ? this.vault.read(file) : null;
	}

	async process(path: string, fn: (current: string) => string): Promise<boolean> {
		const file = this.vault.getFileByPath(path);
		if (!file) return false;
		await this.vault.process(file, fn);
		return true;
	}

	exists(path: string): boolean {
		return this.vault.getAbstractFileByPath(path) !== null;
	}

	async create(path: string, text: string): Promise<void> {
		const slash = path.lastIndexOf("/");
		const folder = slash > 0 ? path.slice(0, slash) : "";
		if (folder && !this.vault.getFolderByPath(folder)) await this.vault.createFolder(folder);
		await this.vault.create(path, text);
	}
}

/**
 * `written`: the file now holds the text. `unchanged`: it already did. `changed`: someone else
 * wrote it since the caller read it, so nothing was written. `missing`: no such file; the doc
 * layer never creates notes (index sync owns creation and deletion).
 */
export type WriteResult = "written" | "unchanged" | "changed" | "missing";

/**
 * The only path from a note's CRDT to the vault. Writes per path run one at a time, in call
 * order. A write is compare-and-swap against the raw content the caller decided on, so a user
 * edit that lands in between is never overwritten. Each write that happens is registered in the
 * `SelfWriteRegistry` (with the hash of the written text) right before it is made.
 */
export class DiskWriter {
	private readonly queues = new Map<string, Promise<unknown>>();

	constructor(
		private readonly io: DiskIO,
		private readonly selfWrites: SelfWriteRegistry,
	) {}

	read(path: string): Promise<string | null> {
		return this.io.read(path);
	}

	/** Replaces the file's content with `text` if it still equals `expected` (raw). */
	write(path: string, text: string, expected: string): Promise<WriteResult> {
		return this.enqueue(path, async () => {
			const current = await this.io.read(path);
			if (current === null) return "missing";
			if (current === text) return "unchanged";
			if (current !== expected) return "changed";
			const hash = await textHash(text);
			let result: WriteResult = "changed";
			const exists = await this.io.process(path, (now) => {
				if (now === text) {
					result = "unchanged";
					return now;
				}
				if (now !== expected) return now;
				this.selfWrites.expect(path, { kind: "modify", hash });
				result = "written";
				return text;
			});
			return exists ? result : "missing";
		});
	}

	/**
	 * Saves `text` next to `path` as `<name> (local copy <device> <YYYYMMDDHHmm>).md` and returns
	 * the new path. Not registered as a self-write: the copy is a new user file like any other.
	 */
	saveCopy(path: string, text: string, device: string, at: Date): Promise<string> {
		return this.enqueue(path, async () => {
			const copy = this.copyPath(path, device, at);
			await this.io.create(copy, text);
			return copy;
		});
	}

	private copyPath(path: string, device: string, at: Date): string {
		const dot = path.toLowerCase().endsWith(".md") ? path.length - 3 : path.length;
		const base = path.slice(0, dot);
		const ext = path.slice(dot);
		const pad = (n: number) => String(n).padStart(2, "0");
		const stamp = `${at.getFullYear()}${pad(at.getMonth() + 1)}${pad(at.getDate())}${pad(at.getHours())}${pad(at.getMinutes())}`;
		const who = device.replace(/[\\/:*?"<>|#^[\]]+/g, "-").trim() || "device";
		const stem = `${base} (local copy ${who} ${stamp}`;
		let candidate = `${stem})${ext}`;
		for (let n = 2; this.io.exists(candidate); n++) candidate = `${stem} ${n})${ext}`;
		return candidate;
	}

	private enqueue<T>(path: string, job: () => Promise<T>): Promise<T> {
		const previous = this.queues.get(path) ?? Promise.resolve();
		const run = previous.then(job, job);
		const tail = run.catch(() => undefined);
		this.queues.set(path, tail);
		void tail.then(() => {
			if (this.queues.get(path) === tail) this.queues.delete(path);
		});
		return run;
	}
}
