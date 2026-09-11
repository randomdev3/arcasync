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
	/** Non-null when `GET /api/server-info` failed. */
	serverError: string | null;
	status: ConnectionStatus;
	statusMessage: string | null;
	signedInAs: string | null;
	workspaceName: string | null;
	/** A request is in flight; buttons are disabled. */
	busy: boolean;
	onServerUrlChange(value: string): void;
	onDevLoginNameChange(value: string): void;
	onConnect(): void;
	onDisconnect(): void;
	onSignOut(): void;
};

/** The render-only half of `SettingsViewProps`, produced by the plugin. */
export type SettingsViewState = Omit<SettingsViewProps, `on${string}`>;
