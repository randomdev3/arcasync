import type { ConnectionStatus } from "../net/ConnectionManager";

export interface StatusBarModel {
	status: ConnectionStatus;
	message: string | null;
	userName: string | null;
	workspaceName: string | null;
	/** Clients present on the workspace index doc, this one included. */
	online: number;
}

const PREFIX = "TeamSync";

/** Renders `TeamSync: alice · Dev · 2 online` in the Obsidian status bar. */
export class StatusBar {
	private model: StatusBarModel = {
		status: "disconnected",
		message: null,
		userName: null,
		workspaceName: null,
		online: 0,
	};

	constructor(private readonly el: HTMLElement) {
		this.el.addClass("teamsync-status-bar");
		this.render();
	}

	update(patch: Partial<StatusBarModel>): void {
		this.model = { ...this.model, ...patch };
		this.render();
	}

	/** Exposed for tests and for the settings tab's status line. */
	get text(): string {
		const { status, message, userName, workspaceName, online } = this.model;
		if (status === "error") return `${PREFIX}: error${message ? ` — ${message}` : ""}`;
		if (status === "connecting") return `${PREFIX}: connecting…`;
		if (status === "disconnected") return `${PREFIX}: offline`;
		const parts = [userName ?? "connected", workspaceName, online > 0 ? `${online} online` : null];
		return `${PREFIX}: ${parts.filter(Boolean).join(" · ")}`;
	}

	private render(): void {
		this.el.setText(this.text);
		this.el.dataset.state = this.model.status;
		this.el.setAttribute("aria-label", this.text);
	}

	destroy(): void {
		this.el.removeClass("teamsync-status-bar");
		this.el.setText("");
	}
}
