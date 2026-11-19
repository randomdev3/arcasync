import type { ConnectionStatus } from "../../net/ConnectionManager";

/**
 * Everything `Settings.svelte` renders, plus the callbacks it fires. A plain
 * type alias (not an interface) so it satisfies `Record<string, unknown>`.
 */
export type SettingsViewProps = {
	serverUrl: string;
	devLoginName: string;
	/** `server-info.features.devOpenLogin`; hides the dev-login field when false. */
	devOpenLogin: boolean;
	/** `server-info.features.accounts`; shows the invite and device sign-in rows. */
	accounts: boolean;
	/** A session token is stored for this vault. */
	signedIn: boolean;
	/** Non-null when `GET /api/server-info` failed. */
	serverError: string | null;
	status: ConnectionStatus;
	statusMessage: string | null;
	signedInAs: string | null;
	workspaceName: string | null;
	/** Workspaces this account belongs to, for the workspace select. */
	workspaces: { id: string; name: string }[];
	/** The primary workspace. */
	workspaceId: string;
	/** Vault folders and the workspace each one syncs with. */
	sharedFolders: { path: string; workspaceId: string }[];
	/** A request is in flight; buttons are disabled. */
	busy: boolean;
	onServerUrlChange(value: string): void;
	onDevLoginNameChange(value: string): void;
	/** Maps a new folder (an empty path does nothing). */
	onMappingAdd(path: string, workspaceId: string): void;
	/** Changes the folder or the workspace of mapping `index`; an empty path unmaps it. */
	onMappingChange(index: number, patch: { path?: string; workspaceId?: string }): void;
	onMappingRemove(path: string): void;
	/** Selects the primary workspace. */
	onWorkspaceChange(workspaceId: string): void;
	/** Attaches the vault-folder autocomplete to a folder input; returns its cleanup. */
	onFolderInputMount(input: HTMLInputElement, onPick: (path: string) => void): () => void;
	/** Joins with an invite link or code; `name` is used only when signed out. */
	onJoinInvite(link: string, name: string): void;
	/** Opens the device-code sign-in. */
	onDeviceSignIn(): void;
	/** Opens the approve-a-device modal. */
	onApproveDevice(): void;
	onConnect(): void;
	onDisconnect(): void;
	onSignOut(): void;
};

/** The render-only half of `SettingsViewProps`, produced by the plugin. */
export type SettingsViewState = Omit<SettingsViewProps, `on${string}`>;
