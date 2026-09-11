import type { DeviceInfo, ServerInfo } from "@teamsync/shared";
import { WS_PATH } from "@teamsync/shared";
import { Notice, Platform, Plugin } from "obsidian";
import { CounterDebug } from "./debug/CounterDebug";
import { ApiClient, ApiRequestError, type MeResult } from "./net/ApiClient";
import { ConnectionManager, type ConnectionState } from "./net/ConnectionManager";
import { TokenStore } from "./net/TokenStore";
import {
	DEFAULT_SETTINGS,
	normalizeSettings,
	type TeamSyncSettings,
	websocketUrl,
} from "./settings";
import { SecretStore } from "./storage/SecretStore";
import type { SettingsViewState } from "./ui/components/settingsProps";
import { TeamSyncSettingsTab } from "./ui/SettingsTab";
import { StatusBar } from "./ui/StatusBar";

/**
 * Every live plugin instance. Obsidian reloads plugins in place; an instance
 * that fails to tear down keeps its socket and timers alive, so this set turns
 * a silent leak into a console warning on the next load.
 */
const liveInstances = new Set<TeamSyncPlugin>();

function platformName(): DeviceInfo["platform"] {
	if (Platform.isIosApp) return "ios";
	if (Platform.isAndroidApp) return "android";
	if (Platform.isMacOS) return "macos";
	if (Platform.isWin) return "windows";
	if (Platform.isLinux) return "linux";
	return "unknown";
}

/** The server may send `expiresAt` in seconds or milliseconds; normalise to ms. */
function toEpochMs(expiresAt: number): number {
	return expiresAt < 1e12 ? expiresAt * 1000 : expiresAt;
}

export default class TeamSyncPlugin extends Plugin {
	settings: TeamSyncSettings = { ...DEFAULT_SETTINGS };

	private secrets!: SecretStore;
	private api!: ApiClient;
	private tokens!: TokenStore;
	private statusBar: StatusBar | null = null;
	private connections: ConnectionManager | null = null;
	private counter: CounterDebug | null = null;
	private unsubscribeConnection: (() => void) | null = null;

	private serverInfo: ServerInfo | null = null;
	private serverError: string | null = null;
	private session: MeResult | null = null;
	private connection: ConnectionState = { status: "disconnected" };
	private busy = false;
	private readonly viewListeners = new Set<() => void>();

	async onload(): Promise<void> {
		if (liveInstances.size > 0) {
			console.warn(
				`[TeamSync] ${liveInstances.size} previous plugin instance(s) were never unloaded`,
			);
		}
		liveInstances.add(this);

		await this.loadSettings();
		this.secrets = new SecretStore(this.app);
		this.api = new ApiClient({
			getBaseUrl: () => this.settings.serverUrl,
			getSessionToken: () => this.secrets.get(),
		});
		this.tokens = new TokenStore({
			fetchToken: async (workspaceId) => {
				const response = await this.api.wsToken(workspaceId);
				return { token: response.token, expiresAt: toEpochMs(response.expiresAt) };
			},
		});

		this.statusBar = new StatusBar(this.addStatusBarItem());
		this.addSettingTab(new TeamSyncSettingsTab(this.app, this));

		this.addCommand({
			id: "connect",
			name: "Connect",
			callback: () => {
				void this.connect();
			},
		});
		this.addCommand({
			id: "disconnect",
			name: "Disconnect",
			callback: () => this.disconnect(),
		});
		this.addCommand({
			id: "debug-counter-increment",
			name: "Debug counter +1",
			callback: () => {
				const value = this.counter?.increment();
				new Notice(
					value === null || value === undefined
						? "TeamSync: not connected"
						: `TeamSync counter: ${value}`,
				);
			},
		});

		if (this.settings.autoConnect && this.secrets.get()) {
			// Do not block `onload`; a slow or unreachable server must not stall Obsidian.
			this.app.workspace.onLayoutReady(() => {
				void this.connect();
			});
		}
	}

	onunload(): void {
		const teardownStep = (name: string, fn: () => void) => {
			try {
				fn();
			} catch (error) {
				const e = error as { message?: string; stack?: string };
				console.error(
					`[TeamSync] onunload failed at step: ${name}: ${e?.message ?? String(error)}\n${e?.stack ?? ""}`,
				);
				// Never rethrow: each later step frees a different resource
				// (doc observers, the shared socket, the status bar element,
				// the view-listener set, the leak registry).
			}
		};

		teardownStep("counter.close", () => this.counter?.close());
		this.counter = null;
		teardownStep("connection.unsubscribe", () => this.unsubscribeConnection?.());
		this.unsubscribeConnection = null;
		teardownStep("connections.destroy", () => this.connections?.destroy());
		this.connections = null;
		teardownStep("tokens.invalidate", () => this.tokens?.invalidate());
		teardownStep("statusBar.destroy", () => this.statusBar?.destroy());
		this.statusBar = null;
		teardownStep("viewListeners.clear", () => this.viewListeners.clear());
		teardownStep("liveInstances.delete", () => {
			liveInstances.delete(this);
		});
	}

	// --- settings -----------------------------------------------------------

	private async loadSettings(): Promise<void> {
		const raw = (await this.loadData()) as Record<string, unknown> | null;
		this.settings = normalizeSettings(raw);
		// A token in `data.json` predates SecretStore (or came from a synced
		// vault). Move it and rewrite the file so it never round-trips again.
		const stray = raw?.sessionToken;
		if (typeof stray === "string" && stray.length > 0) {
			new SecretStore(this.app).set(stray);
			await this.saveSettings();
		}
	}

	async saveSettings(): Promise<void> {
		await this.saveData(this.settings);
	}

	async updateSettings(patch: Partial<TeamSyncSettings>): Promise<void> {
		this.settings = { ...this.settings, ...patch };
		await this.saveSettings();
		this.notifyView();
	}

	async setServerUrl(value: string): Promise<void> {
		const serverUrl = value.trim().replace(/\/+$/, "");
		if (serverUrl === this.settings.serverUrl) return;
		this.disconnect();
		this.serverInfo = null;
		this.serverError = null;
		this.session = null;
		this.tokens.invalidate();
		await this.updateSettings({ serverUrl, workspaceId: "", workspaces: [] });
		await this.refreshServerInfo();
	}

	// --- view ---------------------------------------------------------------

	/** Subscribe to any state the settings tab renders; returns unsubscribe. */
	onViewChange(listener: () => void): () => void {
		this.viewListeners.add(listener);
		return () => this.viewListeners.delete(listener);
	}

	viewModel(): SettingsViewState {
		const workspace = this.settings.workspaces.find((w) => w.id === this.settings.workspaceId);
		return {
			serverUrl: this.settings.serverUrl,
			devLoginName: this.settings.devLoginName,
			devOpenLogin: this.serverInfo?.features.devOpenLogin ?? false,
			serverError: this.serverError,
			status: this.connection.status,
			statusMessage: this.connection.message ?? null,
			signedInAs: this.session?.user.name ?? this.settings.user?.name ?? null,
			workspaceName: workspace?.name ?? null,
			busy: this.busy,
		};
	}

	private notifyView(): void {
		for (const listener of this.viewListeners) {
			try {
				listener();
			} catch (error) {
				console.error("[TeamSync] settings listener failed", error);
			}
		}
	}

	/** Re-reads `GET /api/server-info`; drives the dev-login field's visibility. */
	async refreshServerInfo(): Promise<ServerInfo | null> {
		try {
			this.serverInfo = await this.api.serverInfo();
			this.serverError = null;
		} catch (error) {
			this.serverInfo = null;
			this.serverError = error instanceof Error ? error.message : String(error);
		}
		this.notifyView();
		return this.serverInfo;
	}

	// --- connection ---------------------------------------------------------

	async connect(): Promise<void> {
		if (this.busy) return;
		this.busy = true;
		this.notifyView();
		try {
			const info = await this.refreshServerInfo();
			if (!info) throw new Error(this.serverError ?? "Server unreachable");

			if (!this.secrets.get()) await this.devLogin(info);
			const me = await this.fetchMe();

			const workspaceId =
				this.settings.workspaces.find((w) => w.id === this.settings.workspaceId)?.id ??
				me.workspaces[0]?.id;
			if (!workspaceId) throw new Error("This account is not a member of any workspace");
			if (workspaceId !== this.settings.workspaceId) {
				this.settings.workspaceId = workspaceId;
				await this.saveSettings();
			}

			this.openConnection(workspaceId);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			this.setConnectionState({ status: "error", message });
			new Notice(`TeamSync: ${message}`);
		} finally {
			this.busy = false;
			this.notifyView();
		}
	}

	private async devLogin(info: ServerInfo): Promise<void> {
		if (!info.features.devOpenLogin) {
			throw new Error("Not signed in, and this server does not allow open login");
		}
		const name = this.settings.devLoginName.trim();
		if (!name) throw new Error("Enter a display name in TeamSync settings first");
		const session = await this.api.devLogin(name, this.deviceInfo());
		this.secrets.set(session.sessionToken);
		this.settings.user = {
			id: session.user.id,
			name: session.user.name,
			color: session.user.color,
		};
		this.settings.workspaces = session.workspaces;
		await this.saveSettings();
	}

	private async fetchMe(): Promise<MeResult> {
		try {
			const me = await this.api.me();
			this.session = me;
			this.settings.user = { id: me.user.id, name: me.user.name, color: me.user.color };
			this.settings.workspaces = me.workspaces;
			await this.saveSettings();
			return me;
		} catch (error) {
			if (error instanceof ApiRequestError && error.status === 401) {
				// The stored session is dead; drop it so the next connect re-enrols.
				this.secrets.clear();
				this.session = null;
				throw new Error("Session expired — connect again to sign in");
			}
			throw error;
		}
	}

	private openConnection(workspaceId: string): void {
		this.disconnect();
		const connections = new ConnectionManager({
			url: websocketUrl(this.settings.serverUrl, WS_PATH),
			tokenStore: this.tokens,
		});
		this.connections = connections;
		this.unsubscribeConnection = connections.onStateChange((state) =>
			this.setConnectionState(state),
		);
		connections.connect();
		this.counter = new CounterDebug(connections);
		this.counter.open(workspaceId);
	}

	disconnect(): void {
		this.counter?.close();
		this.counter = null;
		this.unsubscribeConnection?.();
		this.unsubscribeConnection = null;
		this.connections?.destroy();
		this.connections = null;
		this.setConnectionState({ status: "disconnected" });
	}

	async signOut(): Promise<void> {
		this.disconnect();
		this.secrets.clear();
		this.tokens.invalidate();
		this.session = null;
		await this.updateSettings({ user: null, workspaces: [], workspaceId: "" });
	}

	private setConnectionState(state: ConnectionState): void {
		this.connection = state;
		this.statusBar?.update({
			status: state.status,
			message: state.message ?? null,
			userName: this.session?.user.name ?? this.settings.user?.name ?? null,
		});
		this.notifyView();
	}

	private deviceInfo(): DeviceInfo {
		return {
			name: this.app.vault.getName(),
			platform: platformName(),
			vaultId: this.secrets.vaultId,
		};
	}
}
