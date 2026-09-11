import type { WorkspaceSummary } from "@teamsync/shared";

export interface TeamSyncSettings {
	/** Base URL of the TeamSync server, e.g. `http://localhost:8787`. */
	serverUrl: string;
	/** Name used for `POST /api/auth/dev-login` while the server allows open login. */
	devLoginName: string;
	/** Workspace whose index doc the plugin opens. Empty = first workspace returned by the server. */
	workspaceId: string;
	/** Cached, non-secret identity for rendering before the first `/api/auth/me`. */
	user: { id: string; name: string; color: string } | null;
	/** Cached workspace list from the last successful session call. */
	workspaces: WorkspaceSummary[];
	/** Connect on plugin load. */
	autoConnect: boolean;
}

export const DEFAULT_SETTINGS: TeamSyncSettings = {
	serverUrl: "http://localhost:8787",
	devLoginName: "",
	workspaceId: "",
	user: null,
	workspaces: [],
	autoConnect: false,
};

/**
 * Merge persisted `data.json` over the defaults. The session token is never part
 * of settings — it lives in `SecretStore` — so a stray token in an old
 * `data.json` is dropped here rather than round-tripped.
 */
export function normalizeSettings(raw: unknown): TeamSyncSettings {
	const data = (raw ?? {}) as Partial<TeamSyncSettings>;
	return {
		serverUrl: typeof data.serverUrl === "string" ? data.serverUrl : DEFAULT_SETTINGS.serverUrl,
		devLoginName:
			typeof data.devLoginName === "string" ? data.devLoginName : DEFAULT_SETTINGS.devLoginName,
		workspaceId:
			typeof data.workspaceId === "string" ? data.workspaceId : DEFAULT_SETTINGS.workspaceId,
		user: data.user ?? null,
		workspaces: Array.isArray(data.workspaces) ? data.workspaces : [],
		autoConnect: data.autoConnect === true,
	};
}

/** `http(s)://host` → `ws(s)://host`, with any trailing slash removed. */
export function websocketUrl(serverUrl: string, wsPath: string): string {
	return `${serverUrl.trim().replace(/\/+$/, "").replace(/^http/, "ws")}${wsPath}`;
}
