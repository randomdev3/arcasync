import { Role, TeamSummary, type WorkspaceSummary } from "@arcasync/shared";
import { foldersOverlap } from "./workspace/paths";

export interface ArcaSyncSettings {
	/** Base URL of the ArcaSync server; the hosted relay unless self-hosting. */
	serverUrl: string;
	/** Name used for `POST /api/auth/dev-login` while the server allows open login. */
	devLoginName: string;
	/**
	 * The primary workspace: the one a connect opens when no folder is mapped, and the one the
	 * status bar names first. Empty = first workspace returned by the server.
	 */
	workspaceId: string;
	/** Cached, non-secret identity for rendering before the first `/api/auth/me`. */
	user: { id: string; name: string; color: string } | null;
	/** Cached workspace list from the last successful session call. */
	workspaces: WorkspaceSummary[];
	/** Cached `GET /api/teams` (servers with `features.teams`), for names while offline. */
	teams: TeamSummary[];
	/** Connect on plugin load. */
	autoConnect: boolean;
	/**
	 * Vault folders synced with workspaces, at most one folder per workspace and none inside
	 * another. An empty `workspaceId` is bound to the primary workspace on the next connect.
	 */
	sharedFolders: SharedFolder[];
	/** Role asked for when dev-login creates a new membership; `""` = server default. */
	devLoginRole: "" | Role;
}

export interface SharedFolder {
	/** Vault-relative folder path without leading or trailing slashes. */
	path: string;
	workspaceId: string;
	/** Sync is paused for this folder ("Disconnect" in the file menu); it stays mapped. */
	paused?: boolean;
}

/** The hosted relay. */
export const DEFAULT_SERVER_URL = "https://arcasync-relay.studentranoa.workers.dev";

export const DEFAULT_SETTINGS: ArcaSyncSettings = {
	serverUrl: DEFAULT_SERVER_URL,
	devLoginName: "",
	workspaceId: "",
	user: null,
	workspaces: [],
	teams: [],
	autoConnect: false,
	sharedFolders: [],
	devLoginRole: "",
};

/**
 * Merge persisted `data.json` over the defaults. The session token is never part
 * of settings — it lives in `SecretStore` — so a stray token in an old
 * `data.json` is dropped here rather than round-tripped. A P1 `sharedFolder` becomes a
 * one-element `sharedFolders`.
 */
export function normalizeSettings(raw: unknown): ArcaSyncSettings {
	const data = (raw ?? {}) as Partial<ArcaSyncSettings> & { sharedFolder?: unknown };
	return {
		serverUrl: typeof data.serverUrl === "string" ? data.serverUrl : DEFAULT_SETTINGS.serverUrl,
		devLoginName:
			typeof data.devLoginName === "string" ? data.devLoginName : DEFAULT_SETTINGS.devLoginName,
		workspaceId:
			typeof data.workspaceId === "string" ? data.workspaceId : DEFAULT_SETTINGS.workspaceId,
		user: data.user ?? null,
		workspaces: Array.isArray(data.workspaces) ? data.workspaces : [],
		teams: Array.isArray(data.teams)
			? data.teams.flatMap((team) => {
					const parsed = TeamSummary.safeParse(team);
					return parsed.success ? [parsed.data] : [];
				})
			: [],
		autoConnect: data.autoConnect === true,
		sharedFolders: normalizeSharedFolders(
			Array.isArray(data.sharedFolders) ? data.sharedFolders : [data.sharedFolder],
		),
		devLoginRole: Role.safeParse(data.devLoginRole).data ?? "",
	};
}

/**
 * Valid entries in order, dropping any that overlaps an earlier folder or maps a workspace an
 * earlier entry already maps (an unbound `""` workspace may repeat only once).
 */
export function normalizeSharedFolders(values: unknown[]): SharedFolder[] {
	const out: SharedFolder[] = [];
	for (const value of values) {
		const folder = normalizeSharedFolder(value);
		if (!folder) continue;
		if (
			out.some((f) => foldersOverlap(f.path, folder.path) || f.workspaceId === folder.workspaceId)
		)
			continue;
		out.push(folder);
	}
	return out;
}

function normalizeSharedFolder(value: unknown): SharedFolder | null {
	if (!value || typeof value !== "object") return null;
	const { path, workspaceId, paused } = value as Partial<SharedFolder>;
	if (typeof path !== "string") return null;
	const trimmed = path.trim().replace(/^\/+|\/+$/g, "");
	if (!trimmed) return null;
	const folder: SharedFolder = {
		path: trimmed,
		workspaceId: typeof workspaceId === "string" ? workspaceId : "",
	};
	if (paused === true) folder.paused = true;
	return folder;
}

/** `http(s)://host` → `ws(s)://host`, with any trailing slash removed. */
export function websocketUrl(serverUrl: string, wsPath: string): string {
	return `${serverUrl.trim().replace(/\/+$/, "").replace(/^http/, "ws")}${wsPath}`;
}
