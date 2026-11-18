import { Role, type WorkspaceSummary } from "@teamsync/shared";

export interface TeamSyncSettings {
	/** Base URL of the TeamSync server, e.g. `http://localhost:8789` (`pnpm dev`). */
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
	/**
	 * Vault folder synced with a workspace. An empty `workspaceId` is bound to the workspace the
	 * next successful connect resolves.
	 */
	sharedFolder: SharedFolder | null;
	/** Role asked for when dev-login creates a new membership; `""` = server default. */
	devLoginRole: "" | Role;
}

export interface SharedFolder {
	/** Vault-relative folder path without leading or trailing slashes. */
	path: string;
	workspaceId: string;
}

export const DEFAULT_SETTINGS: TeamSyncSettings = {
	serverUrl: "http://localhost:8789",
	devLoginName: "",
	workspaceId: "",
	user: null,
	workspaces: [],
	autoConnect: false,
	sharedFolder: null,
	devLoginRole: "",
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
		sharedFolder: normalizeSharedFolder(data.sharedFolder),
		devLoginRole: Role.safeParse(data.devLoginRole).data ?? "",
	};
}

function normalizeSharedFolder(value: unknown): SharedFolder | null {
	if (!value || typeof value !== "object") return null;
	const { path, workspaceId } = value as Partial<SharedFolder>;
	if (typeof path !== "string") return null;
	const trimmed = path.trim().replace(/^\/+|\/+$/g, "");
	if (!trimmed) return null;
	return { path: trimmed, workspaceId: typeof workspaceId === "string" ? workspaceId : "" };
}

/** `http(s)://host` → `ws(s)://host`, with any trailing slash removed. */
export function websocketUrl(serverUrl: string, wsPath: string): string {
	return `${serverUrl.trim().replace(/\/+$/, "").replace(/^http/, "ws")}${wsPath}`;
}
