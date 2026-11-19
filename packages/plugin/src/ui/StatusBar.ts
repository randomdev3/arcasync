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

const PREFIX = "ArcaSync";

/**
 * Renders `ArcaSync: alice · Dev · 2 online` in the Obsidian status bar, or
 * `ArcaSync: alice · Dev +1 · 3 online` with two workspaces connected.
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

	constructor(private readonly el: HTMLElement) {
		this.el.addClass("arcasync-status-bar");
		this.render();
	}

	update(patch: Partial<StatusBarModel>): void {
		this.model = { ...this.model, ...patch };
		this.render();
	}

	/** Exposed for tests and for the settings tab's status line. */
	get text(): string {
		const { status, message, userName, workspaceName, extraWorkspaces, online } = this.model;
		if (status === "error") return `${PREFIX}: error${message ? ` — ${message}` : ""}`;
		if (status === "connecting") return `${PREFIX}: connecting…`;
		if (status === "disconnected") return `${PREFIX}: offline`;
		const extra = extraWorkspaces > 0 ? `+${extraWorkspaces}` : null;
		const workspaces = [workspaceName, extra].filter(Boolean).join(" ") || null;
		const parts = [userName ?? "connected", workspaces, online > 0 ? `${online} online` : null];
		return `${PREFIX}: ${parts.filter(Boolean).join(" · ")}`;
	}

	private render(): void {
		this.el.setText(this.text);
		this.el.dataset.state = this.model.status;
		this.el.setAttribute("aria-label", this.text);
	}

	destroy(): void {
		this.el.removeClass("arcasync-status-bar");
		this.el.setText("");
	}
}
