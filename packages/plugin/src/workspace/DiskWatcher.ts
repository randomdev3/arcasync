import { type EventRef, type TAbstractFile, TFile, type Vault } from "obsidian";
import { syncKind, toWs } from "./paths";
import type { SelfWriteRegistry } from "./SelfWriteRegistry";

/** User-made changes to synced files, as workspace paths. */
export interface DiskEvents {
	create(path: string): void;
	delete(path: string): void;
	rename(from: string, to: string): void;
	modify(path: string): void;
}

export const CREATE_DEBOUNCE_MS = 500;

/**
 * Turns vault events under the shared folder into `DiskEvents`. Events ArcaSync caused itself
 * are consumed from the `SelfWriteRegistry` at event time and dropped. A new path is announced
 * only after it has existed for `debounceMs`, so editors' temp files and the instant rename of
 * "Untitled.md" never reach the index. Renames across the folder boundary become a create or a
 * delete; Obsidian's trash is outside it. Binaries are watched only when `binaries` is on.
 */
export class DiskWatcher {
	private refs: EventRef[] = [];
	private readonly pending = new Map<string, ReturnType<typeof setTimeout>>();

	constructor(
		private readonly vault: Vault,
		private readonly root: string,
		private readonly selfWrites: SelfWriteRegistry,
		private readonly events: DiskEvents,
		private readonly debounceMs = CREATE_DEBOUNCE_MS,
		private readonly binaries = false,
	) {}

	start(): void {
		if (this.refs.length > 0) return;
		this.refs = [
			this.vault.on("create", (f) => this.onCreate(f)),
			this.vault.on("modify", (f) => this.onModify(f)),
			this.vault.on("delete", (f) => this.onDelete(f)),
			this.vault.on("rename", (f, oldPath) => this.onRename(f, oldPath)),
		];
	}

	stop(): void {
		for (const ref of this.refs) this.vault.offref(ref);
		this.refs = [];
		for (const timer of this.pending.values()) clearTimeout(timer);
		this.pending.clear();
	}

	private ws(vaultPath: string): string | null {
		const ws = toWs(this.root, vaultPath);
		const kind = ws && syncKind(ws);
		return kind === "md" || (kind === "binary" && this.binaries) ? ws : null;
	}

	private onCreate(file: TAbstractFile): void {
		if (!(file instanceof TFile) || !this.ws(file.path)) return;
		if (this.selfWrites.consume(file.path, "create")) return;
		this.schedule(file.path);
	}

	private onModify(file: TAbstractFile): void {
		if (!(file instanceof TFile)) return;
		const ws = this.ws(file.path);
		if (!ws || this.selfWrites.consume(file.path, "modify")) return;
		if (this.pending.has(file.path)) return;
		this.events.modify(ws);
	}

	private onDelete(file: TAbstractFile): void {
		if (!(file instanceof TFile)) return;
		const ws = this.ws(file.path);
		if (!ws || this.cancel(file.path)) return;
		if (this.selfWrites.consume(file.path, "delete")) return;
		this.events.delete(ws);
	}

	private onRename(file: TAbstractFile, oldPath: string): void {
		if (!(file instanceof TFile)) return;
		const from = this.ws(oldPath);
		const to = this.ws(file.path);
		const wasPending = this.cancel(oldPath);
		if (!from && !to) return;
		if (this.selfWrites.consume(file.path, "rename")) return;
		if (from && !to) {
			// Out of the folder, including into Obsidian's `.trash`.
			if (wasPending || this.selfWrites.consume(oldPath, "delete")) return;
			this.events.delete(from);
		} else if (to && (!from || wasPending)) {
			this.schedule(file.path);
		} else if (from && to) {
			this.events.rename(from, to);
		}
	}

	private schedule(vaultPath: string): void {
		this.cancel(vaultPath);
		this.pending.set(
			vaultPath,
			setTimeout(() => {
				this.pending.delete(vaultPath);
				const ws = this.ws(vaultPath);
				if (ws) this.events.create(ws);
			}, this.debounceMs),
		);
	}

	/** True when a create for `vaultPath` was still waiting (it is dropped). */
	private cancel(vaultPath: string): boolean {
		const timer = this.pending.get(vaultPath);
		if (timer === undefined) return false;
		clearTimeout(timer);
		this.pending.delete(vaultPath);
		return true;
	}
}
