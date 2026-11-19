import type { App } from "obsidian";
import type { BinaryFiles, FileStat } from "../files/FileSyncer";
import { syncKind, toVault, toWs } from "./paths";
import type { SelfWriteRegistry } from "./SelfWriteRegistry";

/** The synced files on this device's disk (notes, and binaries when on), by workspace path. */
export interface LocalFiles {
	list(): string[];
	exists(path: string): boolean;
	/** Create an empty note (its content arrives through the note doc). Binaries are downloaded. */
	create(path: string): Promise<void>;
	rename(from: string, to: string): Promise<void>;
	/** Move to the trash the user configured in Obsidian. */
	trash(path: string): Promise<void>;
}

/** Last index state the relay acknowledged, intersected with disk: workspace path → file id. */
export interface KnownStore {
	load(): Record<string, string>;
	save(known: Record<string, string>): void;
}

/**
 * `LocalFiles` over the Obsidian vault, rooted at the shared folder. Every write registers a
 * self-write first, so the DiskWatcher drops the vault event it causes. Binaries are listed only
 * when `binaries` is on (the relay has chunk storage).
 */
export class ObsidianLocalFiles implements LocalFiles, BinaryFiles {
	constructor(
		private readonly app: App,
		private readonly root: string,
		private readonly selfWrites: SelfWriteRegistry,
		private readonly binaries = false,
	) {}

	list(): string[] {
		const out: string[] = [];
		const files = this.binaries ? this.app.vault.getFiles() : this.app.vault.getMarkdownFiles();
		for (const file of files) {
			const ws = toWs(this.root, file.path);
			const kind = ws && syncKind(ws);
			if (ws && (kind === "md" || (kind === "binary" && this.binaries))) out.push(ws);
		}
		return out;
	}

	stat(path: string): FileStat | null {
		const vp = toVault(this.root, path);
		const file = vp === null ? null : this.app.vault.getFileByPath(vp);
		return file ? { size: file.stat.size, mtime: file.stat.mtime } : null;
	}

	async readBinary(path: string): Promise<ArrayBuffer | null> {
		const vp = toVault(this.root, path);
		const file = vp === null ? null : this.app.vault.getFileByPath(vp);
		return file ? this.app.vault.readBinary(file) : null;
	}

	async writeBinary(path: string, data: ArrayBuffer): Promise<void> {
		const vp = this.vaultPath(path);
		const file = this.app.vault.getFileByPath(vp);
		if (file) {
			this.selfWrites.expect(vp, { kind: "modify" });
			await this.app.vault.modifyBinary(file, data);
			return;
		}
		await this.ensureParent(vp);
		this.selfWrites.expect(vp, { kind: "create" });
		await this.app.vault.createBinary(vp, data);
	}

	exists(path: string): boolean {
		const vp = toVault(this.root, path);
		return vp !== null && this.app.vault.getFileByPath(vp) !== null;
	}

	async create(path: string): Promise<void> {
		const vp = this.vaultPath(path);
		await this.ensureParent(vp);
		this.selfWrites.expect(vp, { kind: "create" });
		await this.app.vault.create(vp, "");
	}

	/**
	 * `vault.rename`, not `fileManager.renameFile`: the renaming device already rewrote the links
	 * in other notes, and those edits arrive through their note docs. Rewriting them again here
	 * would apply the same edit twice to the shared text.
	 */
	async rename(from: string, to: string): Promise<void> {
		const file = this.app.vault.getFileByPath(this.vaultPath(from));
		if (!file) return;
		const vp = this.vaultPath(to);
		await this.ensureParent(vp);
		this.selfWrites.expect(vp, { kind: "rename" });
		await this.app.vault.rename(file, vp);
	}

	async trash(path: string): Promise<void> {
		const vp = this.vaultPath(path);
		const file = this.app.vault.getFileByPath(vp);
		if (!file) return;
		this.selfWrites.expect(vp, { kind: "delete" });
		await this.app.fileManager.trashFile(file);
	}

	private vaultPath(path: string): string {
		const vp = toVault(this.root, path);
		if (!vp) throw new Error(`not a syncable workspace path: ${path}`);
		return vp;
	}

	private async ensureParent(vaultPath: string): Promise<void> {
		const segs = vaultPath.split("/").slice(0, -1);
		for (let i = 1; i <= segs.length; i++) {
			const dir = segs.slice(0, i).join("/");
			if (this.app.vault.getFolderByPath(dir)) continue;
			try {
				await this.app.vault.createFolder(dir);
			} catch (error) {
				// Created concurrently (e.g. by a sync of the same folder); anything else is real.
				if (!this.app.vault.getFolderByPath(dir)) throw error;
			}
		}
	}
}

/**
 * `KnownStore` in localStorage under `arcasync:<vaultId>:<workspaceId>:known`. The record names
 * the folder it describes: after the user maps a different folder, the old record would make
 * every indexed note look deleted offline, so a record for another root loads as empty.
 */
export class LocalStorageKnown implements KnownStore {
	private last: string | null = null;

	constructor(
		private readonly key: string,
		private readonly root: string,
	) {}

	load(): Record<string, string> {
		try {
			const raw = window.localStorage.getItem(this.key);
			const parsed = (raw ? JSON.parse(raw) : null) as { root?: unknown; files?: unknown } | null;
			const files = parsed?.root === this.root ? parsed.files : null;
			if (files && typeof files === "object" && !Array.isArray(files)) {
				return Object.fromEntries(
					Object.entries(files).filter((e): e is [string, string] => typeof e[1] === "string"),
				);
			}
		} catch (error) {
			console.warn("[ArcaSync] unreadable known-paths record; starting empty", error);
		}
		return {};
	}

	save(known: Record<string, string>): void {
		const raw = JSON.stringify({ root: this.root, files: known });
		if (raw === this.last) return;
		try {
			window.localStorage.setItem(this.key, raw);
			this.last = raw;
		} catch (error) {
			console.error("[ArcaSync] could not persist known paths", error);
		}
	}
}
