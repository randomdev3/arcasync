import { type App, setIcon } from "obsidian";
import { FOLDER_STATE_LABEL, type FolderState } from "./settings/model";

export interface DecoratedFolder {
	path: string;
	state: FolderState;
	teamName: string | null;
}

/** The file explorer's private per-path items (`view.fileItems`). */
interface ExplorerItem {
	selfEl?: HTMLElement;
	el?: HTMLElement;
	childrenEl?: HTMLElement;
}

interface Decoration {
	pill: HTMLElement;
	children: HTMLElement | null;
	state: FolderState | null;
}

const ICON: Record<FolderState, string> = {
	connected: "users",
	syncing: "refresh-cw",
	offline: "cloud-off",
	error: "alert-circle",
	paused: "pause",
	noaccess: "lock",
};

const REFRESH_DELAY_MS = 50;

/**
 * A status pill on every mapped folder in the file explorer, and a coloured guide on its
 * children. Relies on the explorer's private `fileItems`; any failure only skips decorating.
 */
export class FolderDecorations {
	private readonly decorated = new Map<HTMLElement, Decoration>();
	private timer: number | null = null;

	constructor(
		private readonly app: App,
		private readonly folders: () => DecoratedFolder[],
		private readonly onPillClick: (path: string, event: MouseEvent) => void,
	) {}

	/** Refreshes soon; many calls in a row refresh once. */
	schedule(): void {
		if (this.timer !== null) return;
		this.timer = window.setTimeout(() => {
			this.timer = null;
			this.refresh();
		}, REFRESH_DELAY_MS);
	}

	refresh(): void {
		try {
			this.apply();
		} catch (error) {
			console.warn("[ArcaSync] could not decorate the file explorer", error);
		}
	}

	private apply(): void {
		const wanted = this.folders();
		const seen = new Set<HTMLElement>();
		for (const items of this.explorerItems()) {
			for (const folder of wanted) {
				const item = items[folder.path];
				if (!item?.selfEl) continue;
				this.decorate(item, folder);
				seen.add(item.selfEl);
			}
		}
		for (const [selfEl, decoration] of this.decorated) {
			if (!seen.has(selfEl)) this.undecorate(selfEl, decoration);
		}
	}

	private explorerItems(): Record<string, ExplorerItem>[] {
		const out: Record<string, ExplorerItem>[] = [];
		// Iterated by hand: some plugins patch getLeavesOfType("file-explorer").
		this.app.workspace.iterateAllLeaves((leaf) => {
			if (leaf.view.getViewType() !== "file-explorer") return;
			const items = (leaf.view as unknown as { fileItems?: Record<string, ExplorerItem> })
				.fileItems;
			if (items) out.push(items);
		});
		return out;
	}

	private decorate(item: ExplorerItem, folder: DecoratedFolder): void {
		const selfEl = item.selfEl as HTMLElement;
		let decoration = this.decorated.get(selfEl);
		if (!decoration || decoration.pill.parentElement !== selfEl) {
			for (const stale of Array.from(selfEl.querySelectorAll(".arcasync-folder-pill")))
				stale.remove();
			const pill = selfEl.createSpan({ cls: "arcasync-folder-pill" });
			pill.addEventListener("click", (event) => {
				event.preventDefault();
				event.stopPropagation();
				this.onPillClick(folder.path, event);
			});
			decoration = { pill, children: null, state: null };
			this.decorated.set(selfEl, decoration);
		}
		const children =
			item.childrenEl ??
			item.el?.querySelector<HTMLElement>(":scope > .tree-item-children") ??
			null;
		if (decoration.children !== children) {
			decoration.children?.removeClass("arcasync-live");
			decoration.children = children;
		}
		children?.addClass("arcasync-live");
		if (children) children.dataset.arcasyncState = folder.state;
		selfEl.dataset.arcasyncState = folder.state;
		if (decoration.state !== folder.state) {
			decoration.pill.empty();
			setIcon(decoration.pill, ICON[folder.state]);
			decoration.state = folder.state;
		}
		decoration.pill.dataset.state = folder.state;
		const label = FOLDER_STATE_LABEL[folder.state];
		decoration.pill.setAttribute(
			"aria-label",
			folder.teamName ? `${folder.teamName} · ${label}` : label,
		);
	}

	private undecorate(selfEl: HTMLElement, decoration: Decoration): void {
		decoration.pill.remove();
		decoration.children?.removeClass("arcasync-live");
		if (decoration.children) delete decoration.children.dataset.arcasyncState;
		delete selfEl.dataset.arcasyncState;
		this.decorated.delete(selfEl);
	}

	destroy(): void {
		if (this.timer !== null) window.clearTimeout(this.timer);
		this.timer = null;
		for (const [selfEl, decoration] of [...this.decorated]) this.undecorate(selfEl, decoration);
	}
}
