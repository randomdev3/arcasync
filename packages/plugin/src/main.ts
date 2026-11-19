import type { DeviceInfo, ServerInfo, SessionResponse, WorkspaceSummary } from "@arcasync/shared";
import { WS_PATH } from "@arcasync/shared";
import {
	type Modal,
	Notice,
	normalizePath,
	type ObsidianProtocolData,
	Platform,
	Plugin,
} from "obsidian";
import { DeviceLogin } from "./auth/DeviceLogin";
import { inviteFromParams, parseInviteLink, sameServer } from "./auth/invites";
import { CounterDebug } from "./debug/CounterDebug";
import { editorExtensions } from "./editor";
import { ChunkClient } from "./files/ChunkClient";
import { ApiClient, ApiRequestError, type MeResult } from "./net/ApiClient";
import type { WorkspaceAuth } from "./net/bearer";
import { CloneClient } from "./net/CloneClient";
import { ConnectionManager, type ConnectionState } from "./net/ConnectionManager";
import { TokenStore } from "./net/TokenStore";
import { limits, type PlatformLimits } from "./platform";
import { registerNavigatorCommands } from "./presence/commands";
import {
	DEFAULT_SETTINGS,
	normalizeSettings,
	normalizeSharedFolders,
	type SharedFolder,
	type TeamSyncSettings,
	websocketUrl,
} from "./settings";
import { SecretStore } from "./storage/SecretStore";
import { ApproveDeviceModal } from "./ui/ApproveDeviceModal";
import { ConfirmModal, type ConfirmOptions } from "./ui/ConfirmModal";
import { CreateInviteModal } from "./ui/CreateInviteModal";
import type { SettingsViewState } from "./ui/components/settingsProps";
import { DeviceCodeModal } from "./ui/DeviceCodeModal";
import { FolderSuggest } from "./ui/FolderSuggest";
import { InviteModal } from "./ui/InviteModal";
import { MembersModal } from "./ui/MembersModal";
import { TeamSyncSettingsTab } from "./ui/SettingsTab";
import { StatusBar } from "./ui/StatusBar";
import { containingRoot, foldersOverlap } from "./workspace/paths";
import {
	type BinaryOptions,
	type SessionUser,
	WorkspaceSession,
} from "./workspace/WorkspaceSession";

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

/** One connected workspace: its own socket and session. */
interface LiveWorkspace {
	/** The workspace's name when it connected (a removal may already have dropped it from settings). */
	name: string;
	connections: ConnectionManager;
	session: WorkspaceSession;
	/** Stops the session and closes the socket. */
	stop(): void;
}

/** Worst first: the plugin's connection status is the worst of its workspaces'. */
const STATUS_RANK = { connected: 0, connecting: 1, disconnected: 2, error: 3 } as const;

/** A vault folder path as stored in `sharedFolders`, or "" for none. */
function cleanFolder(value: string): string {
	const trimmed = value.trim();
	const path = trimmed ? normalizePath(trimmed).replace(/^\/+|\/+$/g, "") : "";
	return path === "/" ? "" : path;
}

/** A user-facing sentence for a failed invite accept or redeem. */
function inviteErrorMessage(error: unknown): string {
	if (error instanceof ApiRequestError) {
		switch (error.code) {
			case "not_found":
				return "This invite does not exist or was revoked";
			case "invite_expired":
				return "This invite has expired";
			case "invite_used":
				return "This invite was already used";
			case "name_taken":
				return "That name is taken; pick another";
		}
		return error.message;
	}
	return error instanceof Error ? error.message : String(error);
}

/** The server may send `expiresAt` in seconds or milliseconds; normalise to ms. */
function toEpochMs(expiresAt: number): number {
	return expiresAt < 1e12 ? expiresAt * 1000 : expiresAt;
}

export default class TeamSyncPlugin extends Plugin {
	settings: TeamSyncSettings = { ...DEFAULT_SETTINGS };

	private secrets!: SecretStore;
	/** Public so e2e can read `api.requestCounts`. */
	readonly api = new ApiClient({
		getBaseUrl: () => this.settings.serverUrl,
		getSessionToken: () => this.secrets?.get() ?? null,
	});
	private tokens!: TokenStore;
	/** Sign-in and approval modals; closed on unload so a device-code poll never outlives us. */
	private readonly modals = new Set<Modal>();
	private statusBar: StatusBar | null = null;
	/** Connected workspaces by id: one per mapped folder, or the primary when none is mapped. */
	private readonly live = new Map<string, LiveWorkspace>();
	private counter: CounterDebug | null = null;
	private counterSession: WorkspaceSession | null = null;

	private serverInfo: ServerInfo | null = null;
	private serverError: string | null = null;
	private me: MeResult | null = null;
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
		this.tokens = new TokenStore({
			fetchToken: async (workspaceId) => {
				const response = await this.api.wsToken(workspaceId);
				return { token: response.token, expiresAt: toEpochMs(response.expiresAt) };
			},
		});

		this.statusBar = new StatusBar(this.addStatusBarItem());
		this.addSettingTab(new TeamSyncSettingsTab(this.app, this));
		this.registerEditorExtension(editorExtensions(this));

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
			id: "sign-out",
			name: "Sign out",
			callback: () => {
				void this.signOut();
			},
		});
		this.addCommand({
			id: "approve-device",
			name: "Approve a device sign-in",
			callback: () => this.approveDevice(),
		});
		this.addCommand({
			id: "manage-members",
			name: "Manage workspace members",
			checkCallback: (checking) => {
				if (this.manageableWorkspaces().length === 0) return false;
				if (!checking) this.manageMembers();
				return true;
			},
		});
		this.addCommand({
			id: "create-invite",
			name: "Create an invite link",
			checkCallback: (checking) => {
				if (this.manageableWorkspaces().length === 0) return false;
				if (!checking) this.createInvite();
				return true;
			},
		});
		this.registerObsidianProtocolHandler("teamsync", (params) => this.handleLink(params));
		registerNavigatorCommands(this);
		this.addCommand({
			id: "debug-counter-increment",
			name: "Debug counter +1",
			callback: () => {
				const value = this.counter?.increment();
				new Notice(value === undefined ? "TeamSync: not connected" : `TeamSync counter: ${value}`);
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

		for (const modal of [...this.modals]) teardownStep("modal.close", () => modal.close());
		this.modals.clear();
		teardownStep("counter.close", () => this.counter?.close());
		this.counter = null;
		this.counterSession = null;
		for (const [workspaceId, entry] of [...this.live]) {
			teardownStep(`workspace.stop ${workspaceId}`, () => entry.stop());
		}
		this.live.clear();
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

	/**
	 * Maps a vault folder to a workspace. A folder that overlaps a mapped one, or a workspace that
	 * is already mapped, is refused with a Notice. While connected, only that workspace's
	 * connection (re)starts. Returns whether the mapping is in place.
	 */
	async addMapping(path: string, workspaceId: string): Promise<boolean> {
		const folder = cleanFolder(path);
		// An empty workspace id is bound to the primary workspace on the next connect.
		if (!folder) return false;
		const folders = this.settings.sharedFolders;
		if (folders.some((f) => f.path === folder && f.workspaceId === workspaceId)) return true;
		if (!this.mappingAllowed(folders, folder, workspaceId)) return false;
		if (workspaceId && !this.settings.workspaces.some((w) => w.id === workspaceId)) {
			await this.refreshWorkspaces();
		}
		await this.setSharedFolders([...folders, { path: folder, workspaceId }]);
		return true;
	}

	/** Unmaps the folder at `path` (its files stay); its workspace's connection closes. */
	async removeMapping(path: string): Promise<void> {
		const folder = cleanFolder(path);
		const folders = this.settings.sharedFolders;
		if (!folders.some((f) => f.path === folder)) return;
		await this.setSharedFolders(folders.filter((f) => f.path !== folder));
	}

	/** Changes the folder or the workspace of the mapping at `index` (the settings rows). */
	async updateMapping(index: number, patch: Partial<SharedFolder>): Promise<void> {
		const folders = this.settings.sharedFolders;
		const current = folders[index];
		if (!current) return;
		const next = {
			path: patch.path === undefined ? current.path : cleanFolder(patch.path),
			workspaceId: patch.workspaceId ?? current.workspaceId,
		};
		if (next.path === current.path && next.workspaceId === current.workspaceId) return;
		if (!next.path) return this.removeMapping(current.path);
		const others = folders.filter((_, i) => i !== index);
		if (!this.mappingAllowed(others, next.path, next.workspaceId)) return;
		await this.setSharedFolders(folders.map((f, i) => (i === index ? next : f)));
	}

	private mappingAllowed(folders: SharedFolder[], path: string, workspaceId: string): boolean {
		const clash = folders.find((f) => foldersOverlap(f.path, path));
		if (clash) {
			new Notice(`TeamSync: ${path} overlaps the shared folder ${clash.path}.`);
			return false;
		}
		if (folders.some((f) => f.workspaceId === workspaceId)) {
			const name = this.settings.workspaces.find((w) => w.id === workspaceId)?.name ?? workspaceId;
			new Notice(`TeamSync: workspace ${name} is already mapped to a folder.`);
			return false;
		}
		return true;
	}

	private async setSharedFolders(sharedFolders: SharedFolder[]): Promise<void> {
		await this.updateSettings({ sharedFolders });
		if (this.live.size > 0) this.syncLive();
	}

	/** Selects the primary workspace (opened when no folder is mapped, named in the status bar). */
	async setWorkspace(workspaceId: string): Promise<void> {
		if (workspaceId === this.settings.workspaceId) return;
		await this.updateSettings({ workspaceId });
		if (this.live.size > 0) this.syncLive();
	}

	/** Re-reads `GET /api/workspaces` for the workspace select; silent when signed out. */
	async refreshWorkspaces(): Promise<void> {
		if (!this.secrets.get()) return;
		try {
			const workspaces = await this.api.workspaces();
			await this.updateSettings({ workspaces });
		} catch (error) {
			console.warn("[TeamSync] could not list workspaces", error);
		}
	}

	attachFolderSuggest(input: HTMLInputElement, onPick: (path: string) => void): () => void {
		const suggest = new FolderSuggest(this.app, input, onPick);
		return () => suggest.close();
	}

	async setServerUrl(value: string): Promise<void> {
		const serverUrl = value.trim().replace(/\/+$/, "");
		if (serverUrl === this.settings.serverUrl) return;
		this.disconnect();
		this.serverInfo = null;
		this.serverError = null;
		this.me = null;
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
			accounts: this.serverInfo?.features.accounts ?? false,
			signedIn: this.signedIn,
			serverError: this.serverError,
			status: this.connection.status,
			statusMessage: this.connection.message ?? null,
			signedInAs: this.me?.user.name ?? this.settings.user?.name ?? null,
			workspaceName: workspace?.name ?? null,
			workspaces: this.settings.workspaces.map((w) => ({ id: w.id, name: w.name })),
			workspaceId: this.settings.workspaceId,
			sharedFolders: this.settings.sharedFolders.map((f) => ({ ...f })),
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
			// `/api/auth/me` may be cached by the relay for up to a minute; a mapped or primary
			// workspace it does not list yet (a membership that just changed) is checked against the
			// uncached `/api/workspaces` before it is skipped or replaced.
			const known = new Set(this.settings.workspaces.map((w) => w.id));
			const wanted = [
				this.settings.workspaceId,
				...this.settings.sharedFolders.map((f) => f.workspaceId),
			];
			if (wanted.some((id) => id && !known.has(id))) await this.refreshWorkspaces();

			const workspaceId =
				this.settings.workspaces.find((w) => w.id === this.settings.workspaceId)?.id ??
				me.workspaces[0]?.id;
			if (!workspaceId) throw new Error("This account is not a member of any workspace");
			const folders = this.settings.sharedFolders;
			const unbound = folders.some((f) => !f.workspaceId);
			if (workspaceId !== this.settings.workspaceId || unbound) {
				this.settings.workspaceId = workspaceId;
				if (unbound) {
					this.settings.sharedFolders = normalizeSharedFolders(
						folders.map((f) => (f.workspaceId ? f : { ...f, workspaceId })),
					);
				}
				await this.saveSettings();
			}

			this.disconnect();
			this.syncLive();
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			this.setConnectionState({ status: "error", message });
			new Notice(`TeamSync: ${message}`);
		} finally {
			this.busy = false;
			this.notifyView();
		}
	}

	/** Signed out: dev-login when the server allows it and a name is set; never a silent fallback. */
	private async devLogin(info: ServerInfo): Promise<void> {
		const name = this.settings.devLoginName.trim();
		if (!info.features.devOpenLogin || !name) {
			if (info.features.accounts) {
				throw new Error("Not signed in — paste an invite link or sign in from another device");
			}
			if (!info.features.devOpenLogin) {
				throw new Error("Not signed in, and this server does not allow open login");
			}
			throw new Error("Enter a display name in TeamSync settings first");
		}
		const session = await this.api.devLogin(
			name,
			this.deviceInfo(),
			this.settings.devLoginRole || undefined,
		);
		await this.storeSession(session);
	}

	/** Keeps a new session (the token in SecretStore, never `data.json`) and its identity. */
	private async storeSession(session: SessionResponse): Promise<void> {
		this.secrets.set(session.sessionToken);
		this.tokens.invalidate();
		this.me = null;
		this.settings.user = {
			id: session.user.id,
			name: session.user.name,
			color: session.user.color,
		};
		this.settings.workspaces = session.workspaces;
		await this.saveSettings();
	}

	get signedIn(): boolean {
		return Boolean(this.secrets?.get());
	}

	// --- sign-in ------------------------------------------------------------

	/** A real (non-dev) sign-in finished: keep the session, connect, and reconnect on restart. */
	private async completeSignIn(session: SessionResponse): Promise<void> {
		this.settings.autoConnect = true;
		await this.storeSession(session);
		this.notifyView();
		await this.connect();
	}

	/**
	 * Joins with an invite link or bare token. Signed out, it creates the account `name` and
	 * connects; signed in, it adds the invite's workspace. Returns whether it joined.
	 */
	async joinWithInvite(input: string, name = ""): Promise<boolean> {
		const invite = parseInviteLink(input);
		if (!invite) {
			new Notice("TeamSync: that is not a TeamSync invite link or code");
			return false;
		}
		const sameRelay = !invite.server || sameServer(invite.server, this.settings.serverUrl);
		try {
			if (this.signedIn) {
				if (!sameRelay) {
					new Notice(
						`TeamSync: this invite is for ${invite.server}. Sign out first to switch servers.`,
					);
					return false;
				}
				const before = new Set(this.settings.workspaces.map((w) => w.id));
				const workspaces = await this.api.redeemInvite(invite.token);
				await this.updateSettings({ workspaces });
				const joined = workspaces.filter((w) => !before.has(w.id)).map((w) => w.name);
				new Notice(
					joined.length > 0 ? `TeamSync: joined ${joined.join(", ")}` : "TeamSync: invite redeemed",
				);
				return true;
			}
			const displayName = name.trim();
			if (!displayName) {
				new Notice("TeamSync: enter your name to join");
				return false;
			}
			if (!sameRelay && invite.server) await this.setServerUrl(invite.server);
			const session = await this.api.acceptInvite(invite.token, displayName, this.deviceInfo());
			await this.completeSignIn(session);
			return true;
		} catch (error) {
			new Notice(`TeamSync: ${inviteErrorMessage(error)}`);
			return false;
		}
	}

	/** Opens the device-code sign-in ("Sign in with another device"). */
	signInWithDevice(): void {
		if (this.signedIn) {
			new Notice("TeamSync: already signed in");
			return;
		}
		const login = new DeviceLogin({ api: this.api, device: this.deviceInfo() });
		this.openModal(
			new DeviceCodeModal(this.app, {
				login,
				onSession: (session) => this.completeSignIn(session),
			}),
		);
	}

	/** Opens "Approve a device sign-in", optionally pre-filled with a code. */
	approveDevice(code = ""): void {
		if (!this.signedIn) {
			new Notice("TeamSync: sign in first to approve another device");
			return;
		}
		this.openModal(new ApproveDeviceModal(this.app, this.api, code));
	}

	/** `obsidian://teamsync?server=…&invite=…` or `obsidian://teamsync?approve=<code>`. */
	private handleLink(params: ObsidianProtocolData): void {
		if (params.approve) {
			this.approveDevice(params.approve);
			return;
		}
		const invite = inviteFromParams({ server: params.server, invite: params.invite });
		if (!invite) {
			new Notice("TeamSync: this link is not a valid TeamSync invite");
			return;
		}
		const server = invite.server ?? this.settings.serverUrl;
		const switching = !sameServer(server, this.settings.serverUrl);
		const signOutFirst = switching && this.signedIn;
		// Never act on a link without asking: it may come from anyone.
		this.openModal(
			new ConfirmModal(this.app, {
				title: "Join a TeamSync server",
				message: signOutFirst
					? `Join ${server}? You will be signed out of ${this.settings.serverUrl}.`
					: `Join ${server}?`,
				confirmText: "Continue",
				onConfirm: () => void this.openInvite(server, invite.token, switching),
			}),
		);
	}

	private async openInvite(server: string, token: string, switching: boolean): Promise<void> {
		if (switching) {
			// A session belongs to one server; its token must never be sent to another.
			if (this.signedIn) await this.signOut();
			await this.setServerUrl(server);
		}
		const link = `obsidian://teamsync?server=${encodeURIComponent(server)}&invite=${token}`;
		this.openModal(
			new InviteModal(this.app, {
				link,
				askName: !this.signedIn,
				join: (value, name) => this.joinWithInvite(value, name),
			}),
		);
	}

	// --- owner tools ----------------------------------------------------------

	/**
	 * Workspaces whose members and invites this user may manage: those they own, or all of them
	 * for an admin. Only hides the commands; the relay authorises every change itself.
	 */
	manageableWorkspaces(): WorkspaceSummary[] {
		if (!this.signedIn) return [];
		const admin = this.me?.user.isAdmin ?? false;
		return this.settings.workspaces.filter((w) => admin || w.role === "owner");
	}

	/** The primary workspace when it is manageable, otherwise the first manageable one. */
	private ownerToolTarget(): { workspaces: WorkspaceSummary[]; workspaceId: string } | null {
		const workspaces = this.manageableWorkspaces();
		const target = workspaces.find((w) => w.id === this.settings.workspaceId) ?? workspaces[0];
		return target ? { workspaces, workspaceId: target.id } : null;
	}

	manageMembers(): void {
		const target = this.ownerToolTarget();
		if (!target) return;
		this.openModal(
			new MembersModal(this.app, {
				api: this.api,
				...target,
				selfId: this.me?.user.id ?? this.settings.user?.id ?? null,
				confirm: (options: ConfirmOptions) => this.openModal(new ConfirmModal(this.app, options)),
			}),
		);
	}

	createInvite(): void {
		const target = this.ownerToolTarget();
		if (!target) return;
		this.openModal(new CreateInviteModal(this.app, { api: this.api, ...target }));
	}

	private openModal(modal: Modal): void {
		const onClose = modal.onClose.bind(modal);
		modal.onClose = () => {
			this.modals.delete(modal);
			onClose();
		};
		this.modals.add(modal);
		modal.open();
	}

	private async fetchMe(): Promise<MeResult> {
		try {
			const me = await this.api.me();
			this.me = me;
			this.settings.user = { id: me.user.id, name: me.user.name, color: me.user.color };
			this.settings.workspaces = me.workspaces;
			await this.saveSettings();
			return me;
		} catch (error) {
			if (error instanceof ApiRequestError && error.status === 401) {
				// The stored session is dead; drop it so the next connect re-enrols.
				this.secrets.clear();
				this.me = null;
				throw new Error("Session expired — connect again to sign in");
			}
			throw error;
		}
	}

	/** The primary workspace's session, otherwise the first connected one; null while disconnected. */
	get session(): WorkspaceSession | null {
		return this.primary()?.session ?? null;
	}

	/** The socket of `session`'s workspace. */
	get connections(): ConnectionManager | null {
		return this.primary()?.connections ?? null;
	}

	/** Every connected workspace's session. */
	get sessions(): WorkspaceSession[] {
		return [...this.live.values()].map((entry) => entry.session);
	}

	/** The session whose mapped folder contains `vaultPath`, or null. */
	sessionFor(vaultPath: string): WorkspaceSession | null {
		return containingRoot(this.sessions, vaultPath);
	}

	private primary(): LiveWorkspace | null {
		return this.live.get(this.settings.workspaceId) ?? this.live.values().next().value ?? null;
	}

	/**
	 * Workspace id → mapped folder (or null) of every workspace that should be connected. A
	 * mapping to a workspace this account is not (or no longer) a member of is kept but skipped.
	 * The primary workspace opens unmapped only when no folder is mapped at all: a vault whose
	 * only mapping lost its workspace must not start syncing into another one.
	 */
	private wantedWorkspaces(): Map<string, string | null> {
		const known = new Set(this.settings.workspaces.map((w) => w.id));
		const folders = this.settings.sharedFolders;
		if (folders.length > 0) {
			const mapped = folders.filter((f) => known.has(f.workspaceId));
			return new Map(mapped.map((f) => [f.workspaceId, f.path]));
		}
		const primary = this.settings.workspaceId;
		return known.has(primary) ? new Map([[primary, null]]) : new Map();
	}

	/**
	 * Opens, restarts or closes workspace connections so they match `sharedFolders`. A workspace
	 * whose folder did not change keeps its socket and session; there is never more than one
	 * socket per workspace.
	 */
	private syncLive(): void {
		const user = this.settings.user;
		if (!user) throw new Error("Not signed in");
		const wanted = this.wantedWorkspaces();
		for (const [workspaceId, entry] of [...this.live]) {
			if (wanted.has(workspaceId) && wanted.get(workspaceId) === entry.session.root) continue;
			this.live.delete(workspaceId);
			entry.stop();
		}
		for (const [workspaceId, root] of wanted) {
			if (!this.live.has(workspaceId)) this.startWorkspace(workspaceId, root, user);
		}
		const session = this.session;
		if (session !== this.counterSession) {
			this.counter?.close();
			this.counter = session ? new CounterDebug(session.indexDoc) : null;
			this.counterSession = session;
		}
		this.updateConnectionState();
	}

	private startWorkspace(workspaceId: string, root: string | null, user: SessionUser): void {
		let session: WorkspaceSession | null = null;
		const connections = new ConnectionManager({
			// `?ws=` routes the socket to the workspace's relay; the Node server ignores it.
			url: `${websocketUrl(this.settings.serverUrl, WS_PATH)}?ws=${encodeURIComponent(workspaceId)}`,
			workspaceId,
			tokenStore: this.tokens,
			features: this.serverInfo?.features,
			isIdle: () => session?.presence?.idle ?? false,
		});
		const offState = connections.onStateChange(() => this.updateConnectionState());
		const offMembership = connections.onMembershipChanged(({ removed }) => {
			// Out of the provider's callback: stopping the workspace destroys this socket.
			setTimeout(() => void this.onMembershipChanged(workspaceId, connections, removed), 0);
		});
		connections.connect();
		session = new WorkspaceSession({
			app: this.app,
			connections,
			workspaceId,
			root,
			user,
			vaultId: this.secrets.vaultId,
			binaries: this.binaryOptions(workspaceId),
			clone: this.serverInfo?.features.bulkClone
				? new CloneClient({ auth: this.workspaceAuth(workspaceId), workspaceId })
				: null,
		});
		const started = session;
		const offOnline = started.onOnlineChange(() => this.renderStatusBar());
		this.live.set(workspaceId, {
			name: this.settings.workspaces.find((w) => w.id === workspaceId)?.name ?? workspaceId,
			connections,
			session: started,
			stop: () => {
				offOnline();
				started.stop();
				offState();
				offMembership();
				connections.destroy();
			},
		});
		started.start();
	}

	/** Binary sync for a workspace when the relay has chunk storage (`features.chunks`). */
	private binaryOptions(workspaceId: string): BinaryOptions | null {
		const info = this.serverInfo;
		if (!info?.features.chunks) return null;
		return {
			chunks: new ChunkClient({ auth: this.workspaceAuth(workspaceId) }),
			maxBytes: Math.min(limits().maxBinaryBytes, info.limits.maxFileBytes),
		};
	}

	/** Chunk and clone requests authenticate with the workspace's WS-JWT (D6). */
	private workspaceAuth(workspaceId: string): WorkspaceAuth {
		return {
			baseUrl: () => this.settings.serverUrl,
			token: () => this.tokens.get(workspaceId),
			invalidate: () => this.tokens.invalidate(workspaceId),
		};
	}

	/**
	 * The relay changed this user's membership in `workspaceId`. A new role needs nothing (the
	 * socket re-mints and re-authenticates); only the cached roles are refreshed. A removal stops
	 * that workspace's session and keeps its files and mapping (a later invite restores both).
	 */
	private async onMembershipChanged(
		workspaceId: string,
		connections: ConnectionManager,
		removed: boolean,
	): Promise<void> {
		if (!removed) {
			await this.refreshWorkspaces();
			return;
		}
		const entry = this.live.get(workspaceId);
		if (entry?.connections !== connections) return;
		const name = this.settings.workspaces.find((w) => w.id === workspaceId)?.name ?? entry.name;
		this.live.delete(workspaceId);
		entry.stop();
		new Notice(`TeamSync: you were removed from ${name}`);
		// Drop it locally first: if the uncached refresh fails, it still must not reconnect.
		await this.updateSettings({
			workspaces: this.settings.workspaces.filter((w) => w.id !== workspaceId),
		});
		await this.refreshWorkspaces();
		if (this.settings.user) this.syncLive();
		else this.updateConnectionState();
	}

	disconnect(): void {
		this.counter?.close();
		this.counter = null;
		this.counterSession = null;
		for (const entry of [...this.live.values()]) entry.stop();
		this.live.clear();
		this.setConnectionState({ status: "disconnected" });
	}

	/** The worst state of the connected workspaces' sockets. */
	private updateConnectionState(): void {
		let state: ConnectionState = { status: "disconnected" };
		let rank = -1;
		for (const { connections } of this.live.values()) {
			const current = connections.currentState;
			if (STATUS_RANK[current.status] > rank) {
				rank = STATUS_RANK[current.status];
				state = current;
			}
		}
		this.setConnectionState(state);
	}

	async signOut(): Promise<void> {
		this.disconnect();
		if (this.signedIn) {
			try {
				// Before clearing: the client reads the token for the Authorization header.
				await this.api.logout();
			} catch (error) {
				// Offline or already revoked: the local session is dropped either way.
				console.warn("[TeamSync] logout request failed", error);
			}
		}
		this.secrets.clear();
		this.tokens.invalidate();
		this.me = null;
		await this.updateSettings({ user: null, workspaces: [], workspaceId: "" });
	}

	private setConnectionState(state: ConnectionState): void {
		this.connection = state;
		this.renderStatusBar();
		this.notifyView();
	}

	private renderStatusBar(): void {
		const workspaceId = this.session?.workspaceId ?? this.settings.workspaceId;
		const sessions = this.sessions;
		// The same user is present on every workspace they connect to; count them once.
		const users = new Set<string>();
		let online = 0;
		for (const session of sessions) {
			const present = session.presence?.users();
			if (present) for (const userId of present.keys()) users.add(userId);
			else online = Math.max(online, session.online);
		}
		this.statusBar?.update({
			status: this.connection.status,
			message: this.connection.message ?? null,
			userName: this.me?.user.name ?? this.settings.user?.name ?? null,
			workspaceName: this.settings.workspaces.find((w) => w.id === workspaceId)?.name ?? null,
			extraWorkspaces: Math.max(0, sessions.length - 1),
			online: Math.max(online, users.size),
		});
	}

	/** This device's sync limits (smaller on mobile). */
	limits(): PlatformLimits {
		return limits();
	}

	private deviceInfo(): DeviceInfo {
		return {
			name: this.app.vault.getName(),
			platform: platformName(),
			vaultId: this.secrets.vaultId,
		};
	}
}
