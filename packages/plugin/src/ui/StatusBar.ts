import { setIcon } from "obsidian";
import type { ConnectionStatus } from "../net/ConnectionManager";

export interface StatusBarModel {
	status: ConnectionStatus;
	message: string | null;
	userName: string | null;
	/** The primary workspace's name. */
	workspaceName: string | null;
	/** Further connected workspaces, shown as `+k` after the primary's name. */
	extraWorkspaces: number;
	/** Distinct users present on the connected workspaces' index docs, this one included. */
	online: number;
}

const ICON: Record<ConnectionStatus, string> = {
	connected: "users",
	connecting: "refresh-cw",
	disconnected: "cloud-off",
	error: "alert-circle",
};

/**
 * An icon and a short state in the Obsidian status bar (`Dev +1 · 3 online`, `Offline`); the
 * tooltip has the details. Clicking it opens ArcaSync's settings.
 */
export class StatusBar {
	private model: StatusBarModel = {
		status: "disconnected",
		message: null,
		userName: null,
		workspaceName: null,
		extraWorkspaces: 0,
		online: 0,
	};
	private readonly iconEl: HTMLElement;
	private readonly textEl: HTMLElement;
	private icon: ConnectionStatus | null = null;

	constructor(
		private readonly el: HTMLElement,
		onClick?: () => void,
	) {
		this.el.addClass("arcasync-status-bar");
		this.iconEl = this.el.createSpan({ cls: "arcasync-status-bar-icon" });
		this.textEl = this.el.createSpan({ cls: "arcasync-status-bar-text" });
		if (onClick) {
			this.el.addClass("mod-clickable");
			this.el.addEventListener("click", onClick);
		}
		this.render();
	}

	update(patch: Partial<StatusBarModel>): void {
		this.model = { ...this.model, ...patch };
		this.render();
	}

	/** The short text next to the icon. */
	get text(): string {
		const { status, workspaceName, extraWorkspaces, online } = this.model;
		if (status === "error") return "Error";
		if (status === "connecting") return "Syncing…";
		if (status === "disconnected") return "Offline";
		const extra = extraWorkspaces > 0 ? `+${extraWorkspaces}` : null;
		const name = [workspaceName, extra].filter(Boolean).join(" ") || "Synced";
		return online > 1 ? `${name} · ${online} online` : name;
	}

	/** The tooltip: who, where and how many, or the error. */
	get label(): string {
		const { status, message, userName, workspaceName, extraWorkspaces, online } = this.model;
		if (status === "error") return `ArcaSync: error${message ? ` — ${message}` : ""}`;
		if (status === "connecting") return "ArcaSync: connecting…";
		if (status === "disconnected") return "ArcaSync: offline";
		const extra = extraWorkspaces > 0 ? `+${extraWorkspaces}` : null;
		const workspaces = [workspaceName, extra].filter(Boolean).join(" ") || null;
		const parts = [userName ?? "connected", workspaces, online > 0 ? `${online} online` : null];
		return `ArcaSync: ${parts.filter(Boolean).join(" · ")}`;
	}

	private render(): void {
		if (this.icon !== this.model.status) {
			this.iconEl.empty();
			setIcon(this.iconEl, ICON[this.model.status]);
			this.icon = this.model.status;
		}
		this.textEl.setText(this.text);
		this.el.dataset.state = this.model.status;
		this.el.setAttribute("aria-label", this.label);
		this.el.setAttribute("data-tooltip-position", "top");
	}

	destroy(): void {
		this.el.removeClass("arcasync-status-bar");
		this.el.empty();
	}
}
