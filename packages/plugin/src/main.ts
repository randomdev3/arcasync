import type {
	AuthProvider,
	DeviceInfo,
	PinSummary,
	Role,
	ServerInfo,
	SessionResponse,
	WorkspaceSummary,
} from "@arcasync/shared";
import { passwordProblem, WS_PATH } from "@arcasync/shared";
import {
	Menu,
	type Modal,
	Notice,
	normalizePath,
	type ObsidianProtocolData,
	Platform,
	Plugin,
	TFolder,
} from "obsidian";
import { DeviceLogin, DeviceLoginError } from "./auth/DeviceLogin";
import { inviteFromParams, parseInviteLink, parsePin, sameServer } from "./auth/invites";
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
	type ArcaSyncSettings,
	DEFAULT_SERVER_URL,
	DEFAULT_SETTINGS,
	normalizeSettings,
	normalizeSharedFolders,
	type SharedFolder,
	websocketUrl,
} from "./settings";
import { SecretStore } from "./storage/SecretStore";
import { ApproveDeviceModal } from "./ui/ApproveDeviceModal";
import { ConfirmModal, type ConfirmOptions } from "./ui/ConfirmModal";
import { CreateInviteModal } from "./ui/CreateInviteModal";
import type {
	BrowserSignInView,
	InvitesView,
	MappedFolderView,
	SettingsViewState,
} from "./ui/components/settingsProps";
import { DeviceCodeModal } from "./ui/DeviceCodeModal";
import { FolderDecorations } from "./ui/FolderDecorations";
import { FolderPickerModal } from "./ui/FolderPickerModal";
import { InviteModal } from "./ui/InviteModal";
import { MembersModal } from "./ui/MembersModal";
import { PasswordModal } from "./ui/PasswordModal";
import { ArcaSyncSettingsTab } from "./ui/SettingsTab";
import {
	type ShareChoice,
	ShareFolderModal,
	type ShareFolderModalOptions,
} from "./ui/ShareFolderModal";
import { StatusBar } from "./ui/StatusBar";
import { SyncStatusModal } from "./ui/SyncStatusModal";
import {
	browserSignInUrl,
	type FolderState,
	folderState,
	type MemberView,
	memberView,
	sortMembers,
	type TeamView,
	teamErrorMessage,
	teamOfFolder,
	teamPermissions,
	teamViews,
} from "./ui/settings/model";
import type { Page } from "./ui/settings/router";
import { TextPromptModal } from "./ui/TextPromptModal";
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
const liveInstances = new Set<ArcaSyncPlugin>();

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

/** How many people one invite link lets in. */
const INVITE_LINK_USES = 10;

/** Worst first: the plugin's connection status is the worst of its workspaces'. */
const STATUS_RANK = { connected: 0, connecting: 1, disconnected: 2, error: 3 } as const;

/** A vault folder path as stored in `sharedFolders`, or "" for none. */
function cleanFolder(value: string): string {
	const trimmed = value.trim();
	const path = trimmed ? normalizePath(trimmed).replace(/^\/+|\/+$/g, "") : "";
	return path === "/" ? "" : path;
}

/** "in 12 min" / "in 3 h" from an error's `details.retryAfter` (seconds), or "later". */
function retryWhen(error: ApiRequestError): string {
	const seconds = (error.details as { retryAfter?: unknown } | undefined)?.retryAfter;
	if (typeof seconds !== "number") return "later";
	if (seconds < 90) return `in ${Math.max(1, Math.round(seconds))} s`;
	if (seconds < 5400) return `in ${Math.round(seconds / 60)} min`;
	return `in ${Math.round(seconds / 3600)} h`;
}

/** A user-facing sentence for a failed invite or PIN accept or redeem. */
function inviteErrorMessage(error: unknown): string {
	if (error instanceof ApiRequestError) {
		switch (error.code) {
			case "invalid_pin":
				return "That PIN is wrong, used or expired";
			case "rate_limited":
				return `Too many wrong PINs; try again ${retryWhen(error)}`;
			case "pins_locked":
				return "PIN entry is locked after too many wrong PINs; ask an admin";
			case "weak_password":
				return error.message;
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

export default class ArcaSyncPlugin extends Plugin {
	settings: ArcaSyncSettings = { ...DEFAULT_SETTINGS };

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
	private settingsTab: ArcaSyncSettingsTab | null = null;
	private decorations: FolderDecorations | null = null;
	/** "Continue with Google/GitHub": the device code the browser approves, while it polls. */
	private browserLogin: { login: DeviceLogin; view: BrowserSignInView; url: string | null } | null =
		null;

	async onload(): Promise<void> {
		if (liveInstances.size > 0) {
			console.warn(
				`[ArcaSync] ${liveInstances.size} previous plugin instance(s) were never unloaded`,
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

		this.statusBar = new StatusBar(this.addStatusBarItem(), () => this.openSettings());
		this.settingsTab = new ArcaSyncSettingsTab(this.app, this);
		this.addSettingTab(this.settingsTab);
		this.addRibbonIcon("users", "ArcaSync", () => this.openSettings());
		this.registerEditorExtension(editorExtensions(this));
		this.registerExplorer();

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
		this.registerObsidianProtocolHandler("arcasync", (params) => this.handleLink(params));
		registerNavigatorCommands(this);
		this.addCommand({
			id: "debug-counter-increment",
			name: "Debug counter +1",
			callback: () => {
				const value = this.counter?.increment();
				new Notice(value === undefined ? "ArcaSync: not connected" : `ArcaSync counter: ${value}`);
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
					`[ArcaSync] onunload failed at step: ${name}: ${e?.message ?? String(error)}\n${e?.stack ?? ""}`,
				);
				// Never rethrow: each later step frees a different resource
				// (doc observers, the shared socket, the status bar element,
				// the view-listener set, the leak registry).
			}
		};

		teardownStep("browserLogin.cancel", () => this.browserLogin?.login.cancel());
		this.browserLogin = null;
		for (const modal of [...this.modals]) teardownStep("modal.close", () => modal.close());
		this.modals.clear();
		teardownStep("decorations.destroy", () => this.decorations?.destroy());
		this.decorations = null;
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

	async updateSettings(patch: Partial<ArcaSyncSettings>): Promise<void> {
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
			new Notice(`ArcaSync: ${path} overlaps the shared folder ${clash.path}.`);
			return false;
		}
		if (folders.some((f) => f.workspaceId === workspaceId)) {
			const name = this.settings.workspaces.find((w) => w.id === workspaceId)?.name ?? workspaceId;
			new Notice(`ArcaSync: workspace ${name} is already mapped to a folder.`);
			return false;
		}
		return true;
	}

	/** Mapping or resuming a folder while signed in but not connected connects. */
	private async setSharedFolders(sharedFolders: SharedFolder[]): Promise<void> {
		await this.updateSettings({ sharedFolders });
		if (this.live.size > 0) this.syncLive();
		else if (this.signedIn && sharedFolders.some((f) => !f.paused)) void this.connect();
	}

	/** Pauses ("Disconnect") or resumes ("Connect") one mapped folder; it stays mapped. */
	async setFolderPaused(path: string, paused: boolean): Promise<void> {
		const folders = this.settings.sharedFolders;
		if (!folders.some((f) => f.path === path && Boolean(f.paused) !== paused)) return;
		await this.setSharedFolders(
			folders.map((f) => {
				if (f.path !== path) return f;
				const { paused: _, ...rest } = f;
				return paused ? { ...rest, paused: true } : rest;
			}),
		);
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
			console.warn("[ArcaSync] could not list workspaces", error);
		}
	}

	/** Re-reads the teams (or, on an older server, the workspaces); silent when signed out. */
	async refreshTeams(): Promise<void> {
		if (!this.secrets.get()) return;
		if (!this.serverInfo) await this.refreshServerInfo();
		await this.refreshWorkspaces();
		if (!this.serverInfo?.features.teams) return;
		try {
			const teams = await this.api.teams();
			await this.updateSettings({ teams });
		} catch (error) {
			console.warn("[ArcaSync] could not list teams", error);
		}
	}

	/**
	 * Switches servers. A session belongs to one server, so this signs out first: its token must
	 * never be sent to another host.
	 */
	async setServerUrl(value: string): Promise<void> {
		const serverUrl = value.trim().replace(/\/+$/, "") || DEFAULT_SERVER_URL;
		if (serverUrl === this.settings.serverUrl) return;
		if (this.signedIn) await this.signOut();
		this.disconnect();
		this.serverInfo = null;
		this.serverError = null;
		this.me = null;
		this.tokens.invalidate();
		await this.updateSettings({ serverUrl, workspaceId: "", workspaces: [], teams: [] });
		await this.refreshServerInfo();
	}

	// --- view ---------------------------------------------------------------

	/** Subscribe to any state the settings tab renders; returns unsubscribe. */
	onViewChange(listener: () => void): () => void {
		this.viewListeners.add(listener);
		return () => this.viewListeners.delete(listener);
	}

	/** The server has team routes; while it is unreachable, whether teams were cached. */
	get teamsFeature(): boolean {
		return this.serverInfo
			? this.serverInfo.features.teams === true
			: this.settings.teams.length > 0;
	}

	/** The account's teams (each workspace as a team on an older server). */
	teams(): TeamView[] {
		return teamViews(this.teamsFeature, this.settings.teams, this.settings.workspaces);
	}

	/** Every mapped folder with its team and live state. */
	mappedFolders(): MappedFolderView[] {
		const teams = this.teams();
		const known = new Set(this.settings.workspaces.map((w) => w.id));
		return this.settings.sharedFolders.map((f) => {
			const entry = this.live.get(f.workspaceId);
			const owner = teamOfFolder(teams, f.workspaceId);
			const state = folderState({
				paused: f.paused === true,
				member: !this.signedIn || !f.workspaceId || known.has(f.workspaceId),
				connection: entry?.connections.currentState.status ?? null,
				synced: entry ? entry.session.started && entry.session.indexProvider.synced : false,
			});
			return {
				path: f.path,
				workspaceId: f.workspaceId,
				teamId: owner?.team.id ?? null,
				teamName: owner?.team.name ?? null,
				folderName: owner?.folder.name ?? null,
				state,
				paused: f.paused === true,
			};
		});
	}

	viewModel(): Omit<SettingsViewState, "page" | "canGoBack"> {
		const features = this.serverInfo?.features;
		const user = this.me?.user ?? null;
		const cached = this.settings.user;
		return {
			serverUrl: this.settings.serverUrl,
			defaultServerUrl: DEFAULT_SERVER_URL,
			serverError: this.serverError,
			serverVersion: this.serverInfo?.version ?? null,
			devOpenLogin: features?.devOpenLogin ?? false,
			devLoginName: this.settings.devLoginName,
			accounts: features?.accounts ?? false,
			passwords: features?.passwords ?? false,
			pins: features?.pins ?? false,
			teamsFeature: this.teamsFeature,
			providers: this.serverInfo?.auth?.providers ?? [],
			limits: this.serverInfo?.auth?.limits ?? null,
			signedIn: this.signedIn,
			user: user
				? {
						id: user.id,
						name: user.name,
						email: user.email,
						color: user.color,
						avatarUrl: user.avatarUrl,
						isAdmin: user.isAdmin,
					}
				: cached
					? { ...cached, email: null, avatarUrl: null, isAdmin: false }
					: null,
			hasPassword: this.me?.hasPassword ?? null,
			browserSignIn: this.browserLogin ? { ...this.browserLogin.view } : null,
			status: this.connection.status,
			statusMessage: this.connection.message ?? null,
			teams: this.teams(),
			folders: this.mappedFolders(),
			busy: this.busy,
		};
	}

	private notifyView(): void {
		for (const listener of this.viewListeners) {
			try {
				listener();
			} catch (error) {
				console.error("[ArcaSync] settings listener failed", error);
			}
		}
		this.decorations?.schedule();
	}

	/** Opens ArcaSync's settings tab, optionally on `page` (e.g. a team's page). */
	openSettings(page?: Page): void {
		const setting = (
			this.app as unknown as { setting?: { open(): void; openTabById(id: string): void } }
		).setting;
		if (!setting) return;
		this.settingsTab?.showNext(page ?? null);
		setting.open();
		setting.openTabById(this.manifest.id);
	}

	/** Re-reads `/api/auth/me` (email, avatar, password) for the account row. */
	async refreshMe(): Promise<void> {
		if (!this.signedIn) return;
		try {
			await this.fetchMe();
		} catch (error) {
			console.warn("[ArcaSync] could not read the account", error);
		}
		this.notifyView();
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
			if (!workspaceId) {
				// A new account without a team yet: signed in, nothing to sync.
				this.disconnect();
				return;
			}
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
			new Notice(`ArcaSync: ${message}`);
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
				throw new Error(
					info.features.passwords
						? "Not signed in — sign in with your name and password, an invite or another device"
						: "Not signed in — paste an invite link or sign in from another device",
				);
			}
			if (!info.features.devOpenLogin) {
				throw new Error("Not signed in, and this server does not allow open login");
			}
			throw new Error("Enter a display name in ArcaSync settings first");
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
		await this.refreshTeams();
	}

	// --- browser sign-in ("Continue with Google/GitHub") ----------------------

	/**
	 * Starts a device code and opens the website's sign-in for `provider`, which then approves the
	 * code; this device polls until it is approved. Lives in the plugin so closing settings does not
	 * stop it.
	 */
	startBrowserSignIn(provider: AuthProvider): void {
		if (this.signedIn) return;
		this.browserLogin?.login.cancel();
		const publicUrl = this.serverInfo?.publicUrl ?? "";
		const login = new DeviceLogin({ api: this.api, device: this.deviceInfo() });
		const entry = {
			login,
			view: { provider, userCode: null, error: null } as BrowserSignInView,
			url: null as string | null,
		};
		this.browserLogin = entry;
		this.notifyView();
		login
			.run((code) => {
				if (this.browserLogin !== entry) return;
				entry.view = { ...entry.view, userCode: code.userCode };
				entry.url = browserSignInUrl(publicUrl, provider, code.userCode);
				if (entry.url) window.open(entry.url);
				else entry.view = { ...entry.view, error: "This server has no sign-in page" };
				this.notifyView();
			})
			.then(
				async (session) => {
					if (this.browserLogin !== entry) return;
					this.browserLogin = null;
					await this.completeSignIn(session);
				},
				(error: unknown) => {
					if (this.browserLogin !== entry) return;
					if (error instanceof DeviceLoginError && error.code === "cancelled") return;
					const message =
						error instanceof DeviceLoginError && error.code === "access_denied"
							? "Sign-in was denied"
							: error instanceof DeviceLoginError && error.code === "expired_token"
								? "The sign-in expired"
								: error instanceof Error
									? error.message
									: String(error);
					entry.view = { ...entry.view, error: message };
					this.notifyView();
				},
			);
	}

	/** Opens the browser page again while the code is valid; after a failure, starts over. */
	reopenBrowserSignIn(): void {
		const entry = this.browserLogin;
		if (!entry) return;
		if (entry.view.error || !entry.url) {
			this.startBrowserSignIn(entry.view.provider);
			return;
		}
		window.open(entry.url);
	}

	cancelBrowserSignIn(): void {
		const entry = this.browserLogin;
		this.browserLogin = null;
		entry?.login.cancel();
		this.notifyView();
	}

	/**
	 * Joins with an invite link, bare token or (relay with `features.pins`) 4-digit PIN. Signed
	 * out, it creates the account `name` (with `password` for a PIN) and connects; signed in, it
	 * adds the workspace. Returns whether it joined.
	 */
	async joinWithInvite(input: string, name = "", password = "", confirm = ""): Promise<boolean> {
		const pin = this.serverInfo?.features.pins ? parsePin(input) : null;
		if (pin) return this.joinWithPin(pin, name, password, confirm);
		const invite = parseInviteLink(input);
		if (!invite) {
			new Notice("ArcaSync: that is not an ArcaSync invite link or code");
			return false;
		}
		const sameRelay = !invite.server || sameServer(invite.server, this.settings.serverUrl);
		try {
			if (this.signedIn) {
				if (!sameRelay) {
					new Notice(
						`ArcaSync: this invite is for ${invite.server}. Sign out first to switch servers.`,
					);
					return false;
				}
				const before = new Set(this.settings.workspaces.map((w) => w.id));
				const workspaces = await this.api.redeemInvite(invite.token);
				await this.afterRedeem(before, workspaces, "ArcaSync: invite redeemed");
				return true;
			}
			const displayName = name.trim();
			if (!displayName) {
				new Notice("ArcaSync: enter your name to join");
				return false;
			}
			if (!sameRelay && invite.server) await this.setServerUrl(invite.server);
			const session = await this.api.acceptInvite(invite.token, displayName, this.deviceInfo());
			await this.completeSignIn(session);
			return true;
		} catch (error) {
			new Notice(`ArcaSync: ${inviteErrorMessage(error)}`);
			return false;
		}
	}

	private async joinWithPin(
		pin: string,
		name: string,
		password: string,
		confirm: string,
	): Promise<boolean> {
		try {
			if (this.signedIn) {
				const before = new Set(this.settings.workspaces.map((w) => w.id));
				const workspaces = await this.api.redeemPin(pin);
				await this.afterRedeem(before, workspaces, "ArcaSync: PIN redeemed");
				return true;
			}
			const displayName = name.trim();
			if (!displayName) {
				new Notice("ArcaSync: enter your name to join");
				return false;
			}
			const problem = passwordProblem(password);
			if (problem) {
				new Notice(`ArcaSync: ${problem}`);
				return false;
			}
			if (password !== confirm) {
				new Notice("ArcaSync: the two passwords differ");
				return false;
			}
			const session = await this.api.acceptPin(pin, displayName, password, this.deviceInfo());
			await this.completeSignIn(session);
			return true;
		} catch (error) {
			new Notice(`ArcaSync: ${inviteErrorMessage(error)}`);
			return false;
		}
	}

	/** Signed in, an invite or PIN was redeemed: names the teams joined and starts syncing. */
	private async afterRedeem(
		before: Set<string>,
		workspaces: WorkspaceSummary[],
		fallback: string,
	): Promise<void> {
		await this.updateSettings({ workspaces });
		await this.refreshTeams();
		const fresh = new Set(workspaces.filter((w) => !before.has(w.id)).map((w) => w.id));
		const joined = this.teams()
			.filter((t) => t.folders.some((f) => fresh.has(f.id)))
			.map((t) => t.name);
		new Notice(joined.length > 0 ? `ArcaSync: joined ${joined.join(", ")}` : fallback);
		if (this.live.size === 0) void this.connect();
	}

	/** Signed out: name + password sign-in (relay with `features.passwords`). */
	async signInWithPassword(name: string, password: string): Promise<boolean> {
		if (this.signedIn) {
			new Notice("ArcaSync: already signed in");
			return false;
		}
		try {
			const session = await this.api.login(name.trim(), password, this.deviceInfo());
			await this.completeSignIn(session);
			return true;
		} catch (error) {
			let message = error instanceof Error ? error.message : String(error);
			if (error instanceof ApiRequestError && error.code === "invalid_credentials") {
				message = "Wrong name or password";
			} else if (error instanceof ApiRequestError && error.code === "rate_limited") {
				message = `Too many failed sign-ins; try again ${retryWhen(error)}`;
			}
			new Notice(`ArcaSync: ${message}`);
			return false;
		}
	}

	/** Signed in: "Set password" or "Change password". */
	setPassword(): void {
		if (!this.signedIn) {
			new Notice("ArcaSync: sign in first");
			return;
		}
		this.openModal(
			new PasswordModal(this.app, {
				hasPassword: this.me?.hasPassword ?? false,
				submit: async (next, current) => {
					await this.api.setPassword(next, current);
					if (this.me) this.me = { ...this.me, hasPassword: true };
					this.notifyView();
				},
			}),
		);
	}

	/** Opens the device-code sign-in ("Sign in with another device"). */
	signInWithDevice(): void {
		if (this.signedIn) {
			new Notice("ArcaSync: already signed in");
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
			new Notice("ArcaSync: sign in first to approve another device");
			return;
		}
		this.openModal(new ApproveDeviceModal(this.app, this.api, code));
	}

	/** `obsidian://arcasync?server=…&invite=…` or `obsidian://arcasync?approve=<code>`. */
	private handleLink(params: ObsidianProtocolData): void {
		if (params.approve) {
			this.approveDevice(params.approve);
			return;
		}
		const invite = inviteFromParams({ server: params.server, invite: params.invite });
		if (!invite) {
			new Notice("ArcaSync: this link is not a valid ArcaSync invite");
			return;
		}
		const server = invite.server ?? this.settings.serverUrl;
		const switching = !sameServer(server, this.settings.serverUrl);
		const signOutFirst = switching && this.signedIn;
		// Never act on a link without asking: it may come from anyone.
		this.openModal(
			new ConfirmModal(this.app, {
				title: "Join an ArcaSync server",
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
		const link = `obsidian://arcasync?server=${encodeURIComponent(server)}&invite=${token}`;
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
		this.openModal(
			new CreateInviteModal(this.app, {
				api: this.api,
				...target,
				pins: this.serverInfo?.features.pins ?? false,
				isAdmin: this.me?.user.isAdmin ?? false,
			}),
		);
	}

	// --- teams ----------------------------------------------------------------

	private get isAdmin(): boolean {
		return this.me?.user.isAdmin ?? false;
	}

	private get selfId(): string | null {
		return this.me?.user.id ?? this.settings.user?.id ?? null;
	}

	private fail(error: unknown): void {
		new Notice(`ArcaSync: ${teamErrorMessage(error)}`);
	}

	/** A yes/no question; resolves true only when confirmed. */
	private ask(options: Omit<ConfirmOptions, "onConfirm">): Promise<boolean> {
		return new Promise((resolve) => {
			let confirmed = false;
			const modal = new ConfirmModal(this.app, {
				...options,
				onConfirm: () => {
					confirmed = true;
					resolve(true);
				},
			});
			const onClose = modal.onClose.bind(modal);
			modal.onClose = () => {
				onClose();
				// The confirm button closes the modal before it calls `onConfirm`.
				queueMicrotask(() => {
					if (!confirmed) resolve(false);
				});
			};
			this.openModal(modal);
		});
	}

	createTeam(): void {
		const limits = this.serverInfo?.auth?.limits;
		this.openModal(
			new TextPromptModal(this.app, {
				title: "Create team",
				label: "Name",
				placeholder: "My team",
				description: limits
					? `Up to ${limits.membersPerTeam} people and ${limits.foldersPerTeam} shared folders.`
					: undefined,
				confirmText: "Create",
				submit: async (name) => {
					try {
						const team = await this.api.createTeam(name);
						await this.refreshTeams();
						this.settingsTab?.navigate({ kind: "team", teamId: team.id });
						return true;
					} catch (error) {
						this.fail(error);
						return false;
					}
				},
			}),
		);
	}

	async renameTeam(teamId: string, name: string): Promise<boolean> {
		try {
			await this.api.renameTeam(teamId, name.trim());
			await this.refreshTeams();
			return true;
		} catch (error) {
			this.fail(error);
			return false;
		}
	}

	/** Stops syncing the team's folders here; the files stay in the vault. */
	private async unmapTeam(team: TeamView): Promise<void> {
		const ids = new Set(team.folders.map((f) => f.id));
		const folders = this.settings.sharedFolders;
		if (folders.some((f) => ids.has(f.workspaceId))) {
			await this.setSharedFolders(folders.filter((f) => !ids.has(f.workspaceId)));
		}
	}

	async deleteTeam(team: TeamView): Promise<void> {
		const ok = await this.ask({
			title: `Delete ${team.name}?`,
			message:
				"Its shared folders are deleted for everyone, and everyone loses access. Copies already in vaults stay.",
			confirmText: "Delete team",
			warning: true,
		});
		if (!ok) return;
		try {
			await this.api.deleteTeam(team.id);
			await this.unmapTeam(team);
			await this.refreshTeams();
		} catch (error) {
			this.fail(error);
		}
	}

	async leaveTeam(team: TeamView): Promise<void> {
		const selfId = this.selfId;
		if (!selfId) return;
		const ok = await this.ask({
			title: `Leave ${team.name}?`,
			message: "Its folders stop syncing here. The files stay in this vault.",
			confirmText: "Leave team",
			warning: true,
		});
		if (!ok) return;
		try {
			if (team.legacy) await this.api.removeMember(team.id, selfId);
			else await this.api.removeTeamMember(team.id, selfId);
			await this.unmapTeam(team);
			await this.refreshTeams();
		} catch (error) {
			this.fail(error);
		}
	}

	async loadMembers(team: TeamView): Promise<MemberView[]> {
		try {
			const members = team.legacy
				? await this.api.members(team.id)
				: await this.api.teamMembers(team.id);
			return sortMembers(members.map(memberView));
		} catch (error) {
			this.fail(error);
			return [];
		}
	}

	async setMemberRole(team: TeamView, userId: string, role: Role): Promise<boolean> {
		try {
			if (team.legacy) await this.api.setRole(team.id, userId, role);
			else await this.api.setTeamRole(team.id, userId, role);
			return true;
		} catch (error) {
			this.fail(error);
			return false;
		}
	}

	async removeTeamMember(team: TeamView, member: MemberView): Promise<boolean> {
		const ok = await this.ask({
			title: `Remove ${member.name}?`,
			message: `${member.name} loses access to ${team.name}.`,
			confirmText: "Remove",
			warning: true,
		});
		if (!ok) return false;
		try {
			if (team.legacy) await this.api.removeMember(team.id, member.id);
			else await this.api.removeTeamMember(team.id, member.id);
			return true;
		} catch (error) {
			this.fail(error);
			return false;
		}
	}

	async loadInvites(team: TeamView): Promise<InvitesView> {
		const pins = this.serverInfo?.features.pins ?? false;
		try {
			const [invites, pinList] = await Promise.all([
				team.legacy ? this.api.listInvites(team.id) : this.api.listTeamInvites(team.id),
				pins
					? team.legacy
						? this.api.listPins(team.id)
						: this.api.listTeamPins(team.id)
					: Promise.resolve(null),
			]);
			return { invites, pins: pinList?.pins ?? null, pinsLocked: pinList?.locked ?? false };
		} catch (error) {
			console.warn("[ArcaSync] could not list invites", error);
			return { invites: [], pins: pins ? [] : null, pinsLocked: false };
		}
	}

	async createInviteLink(team: TeamView, role: Role): Promise<string | null> {
		const invite = { role, maxUses: INVITE_LINK_USES };
		try {
			const created = team.legacy
				? await this.api.createInvite(team.id, invite)
				: await this.api.createTeamInvite(team.id, invite);
			return created.url;
		} catch (error) {
			this.fail(error);
			return null;
		}
	}

	async createTeamPin(team: TeamView, role: Role): Promise<PinSummary | null> {
		try {
			return team.legacy
				? await this.api.createPin(team.id, { role })
				: await this.api.createTeamPin(team.id, { role });
		} catch (error) {
			this.fail(error);
			return null;
		}
	}

	async revokeTeamInvite(team: TeamView, inviteId: string): Promise<void> {
		try {
			if (team.legacy) await this.api.revokeInvite(team.id, inviteId);
			else await this.api.revokeTeamInvite(team.id, inviteId);
		} catch (error) {
			this.fail(error);
		}
	}

	async revokeTeamPin(team: TeamView, pinId: string): Promise<void> {
		try {
			if (team.legacy) await this.api.revokePin(team.id, pinId);
			else await this.api.revokeTeamPin(team.id, pinId);
		} catch (error) {
			this.fail(error);
		}
	}

	copy(text: string, what: string): void {
		void navigator.clipboard.writeText(text).then(
			() => new Notice(`ArcaSync: ${what} copied`),
			() => new Notice("ArcaSync: could not copy"),
		);
	}

	// --- shared folders in this vault ------------------------------------------

	/** A vault folder that no mapped folder contains or is inside. */
	private freeFolder(path: string): boolean {
		return path !== "" && !this.settings.sharedFolders.some((f) => foldersOverlap(f.path, path));
	}

	/** "Add to this vault": picks (or creates) the vault folder a team folder syncs into. */
	addToVault(workspaceId: string, folderName: string): void {
		this.openModal(
			new FolderPickerModal(this.app, {
				defaultName: folderName,
				allowed: (path) => this.freeFolder(path),
				onPick: (path, create) => void this.mapInto(path, workspaceId, create),
			}),
		);
	}

	private async mapInto(path: string, workspaceId: string, create: boolean): Promise<boolean> {
		const folder = cleanFolder(path);
		try {
			if (create && !this.app.vault.getAbstractFileByPath(folder)) {
				await this.app.vault.createFolder(folder);
			}
		} catch (error) {
			this.fail(error);
			return false;
		}
		return this.addMapping(folder, workspaceId);
	}

	/** Teams this account can share into: a new folder (owner/editor) or one not in this vault. */
	private shareTargets(): ShareFolderModalOptions["teams"] {
		const mapped = new Set(this.settings.sharedFolders.map((f) => f.workspaceId));
		return this.teams()
			.map((team) => ({
				team,
				canCreate: teamPermissions(team, this.isAdmin).shareFolder,
				unmapped: team.folders.filter((f) => !mapped.has(f.id)),
			}))
			.filter((t) => t.canCreate || t.unmapped.length > 0);
	}

	/** "Share with team…" for `localPath` (or a folder picked in the modal). */
	shareLocalFolder(team: TeamView | null, localPath: string | null = null): void {
		if (!this.signedIn) {
			this.openSettings();
			return;
		}
		const teams = this.shareTargets();
		if (teams.length === 0 && !this.teamsFeature) {
			new Notice("ArcaSync: every workspace already syncs into this vault");
			return;
		}
		this.openModal(
			new ShareFolderModal(this.app, {
				localPath,
				teams,
				teamId: team?.id ?? null,
				canCreateTeam: this.teamsFeature,
				submit: (choice) => this.share(choice),
			}),
		);
	}

	private async share(choice: ShareChoice): Promise<boolean> {
		const path = cleanFolder(choice.localPath);
		if (!path) {
			new Notice("ArcaSync: pick a folder to share");
			return false;
		}
		if (!this.freeFolder(path)) {
			const clash = this.settings.sharedFolders.find((f) => foldersOverlap(f.path, path));
			new Notice(`ArcaSync: ${path} overlaps the shared folder ${clash?.path ?? ""}`);
			return false;
		}
		const folderName = choice.folderName.trim() || (path.split("/").pop() ?? path);
		if (choice.teamId === null && !choice.newTeamName.trim()) {
			new Notice("ArcaSync: name the new team");
			return false;
		}
		try {
			const teamId = choice.teamId ?? (await this.api.createTeam(choice.newTeamName.trim())).id;
			const folderId = choice.folderId ?? (await this.api.createTeamFolder(teamId, folderName)).id;
			if (!this.app.vault.getAbstractFileByPath(path)) await this.app.vault.createFolder(path);
			await this.refreshTeams();
			if (!(await this.addMapping(path, folderId))) return false;
			const name = this.teams().find((t) => t.id === teamId)?.name;
			new Notice(`ArcaSync: ${path} is shared${name ? ` with ${name}` : ""}`);
			return true;
		} catch (error) {
			this.fail(error);
			// A team or folder may have been created before the failure.
			await this.refreshTeams();
			return false;
		}
	}

	/** Asks, then stops syncing `path` here; the files stay. */
	async confirmRemoveMapping(path: string): Promise<void> {
		const ok = await this.ask({
			title: `Remove ${path} from sync?`,
			message: "It stops syncing in this vault. The files stay, and the team keeps its copy.",
			confirmText: "Remove",
			warning: true,
		});
		if (ok) await this.removeMapping(path);
	}

	async deleteTeamFolder(team: TeamView, folder: { id: string; name: string }): Promise<void> {
		const ok = await this.ask({
			title: `Delete ${folder.name} for everyone?`,
			message: `It is removed from ${team.name} for every member. Copies already in vaults stay.`,
			confirmText: "Delete folder",
			warning: true,
		});
		if (!ok) return;
		try {
			await this.api.deleteTeamFolder(team.id, folder.id);
			const mapped = this.settings.sharedFolders.find((f) => f.workspaceId === folder.id);
			if (mapped) await this.removeMapping(mapped.path);
			await this.refreshTeams();
		} catch (error) {
			this.fail(error);
		}
	}

	/** The ⋯ menu of a team folder in settings. */
	folderMenu(event: MouseEvent, team: TeamView, folder: { id: string; name: string }): void {
		const menu = new Menu();
		const mapped = this.settings.sharedFolders.find((f) => f.workspaceId === folder.id);
		if (mapped) {
			this.addPauseItem(menu, mapped);
			menu.addItem((item) =>
				item
					.setTitle("Remove from this vault")
					.setIcon("folder-minus")
					.onClick(() => void this.confirmRemoveMapping(mapped.path)),
			);
		} else {
			menu.addItem((item) =>
				item
					.setTitle("Add to this vault…")
					.setIcon("folder-plus")
					.onClick(() => this.addToVault(folder.id, folder.name)),
			);
		}
		if (teamPermissions(team, this.isAdmin).deleteFolder) {
			menu.addSeparator();
			menu.addItem((item) => {
				item
					.setTitle("Delete for everyone")
					.setIcon("trash-2")
					.onClick(() => void this.deleteTeamFolder(team, folder));
				item.setWarning(true);
			});
		}
		menu.showAtMouseEvent(event);
	}

	/** "Disconnect" pauses a mapped folder, "Connect" resumes it. */
	private addPauseItem(menu: Menu, folder: SharedFolder): void {
		menu.addItem((item) =>
			folder.paused
				? item
						.setTitle("Connect")
						.setIcon("play")
						.onClick(() => void this.setFolderPaused(folder.path, false))
				: item
						.setTitle("Disconnect")
						.setIcon("pause")
						.onClick(() => void this.setFolderPaused(folder.path, true)),
		);
	}

	private registerExplorer(): void {
		this.decorations = new FolderDecorations(
			this.app,
			() =>
				this.mappedFolders().map((f) => ({ path: f.path, state: f.state, teamName: f.teamName })),
			(path) => this.showSyncStatus(path),
		);
		this.app.workspace.onLayoutReady(() => this.decorations?.refresh());
		const schedule = () => this.decorations?.schedule();
		this.registerEvent(this.app.workspace.on("layout-change", schedule));
		this.registerEvent(this.app.vault.on("create", schedule));
		this.registerEvent(this.app.vault.on("rename", schedule));
		this.registerEvent(this.app.vault.on("delete", schedule));
		this.registerEvent(
			this.app.workspace.on("file-menu", (menu, file) => {
				if (file instanceof TFolder && !file.isRoot()) this.folderFileMenu(menu, file.path);
			}),
		);
	}

	private folderFileMenu(menu: Menu, path: string): void {
		const mapped = this.settings.sharedFolders.find((f) => f.path === path);
		if (!mapped) {
			if (!this.freeFolder(path)) return;
			menu.addItem((item) =>
				item
					.setTitle("Share with team…")
					.setIcon("users")
					.setSection("arcasync")
					.onClick(() => this.shareLocalFolder(null, path)),
			);
			return;
		}
		const view = this.mappedFolders().find((f) => f.path === path);
		menu.addItem((item) =>
			item
				.setTitle("Team settings")
				.setIcon("settings")
				.setSection("arcasync")
				.onClick(() =>
					this.openSettings(view?.teamId ? { kind: "team", teamId: view.teamId } : undefined),
				),
		);
		menu.addItem((item) =>
			item
				.setTitle("Sync status")
				.setIcon("info")
				.setSection("arcasync")
				.onClick(() => this.showSyncStatus(path)),
		);
		this.addPauseItem(menu, mapped);
	}

	showSyncStatus(path: string): void {
		const view = this.mappedFolders().find((f) => f.path === path);
		if (!view) return;
		const entry = this.live.get(view.workspaceId);
		const state: FolderState = view.state;
		const teamId = view.teamId;
		this.openModal(
			new SyncStatusModal(
				this.app,
				{
					path,
					teamName: view.teamName,
					folderName: view.folderName,
					state,
					online: entry
						? Math.max(entry.session.online, entry.session.presence?.users().size ?? 0)
						: 0,
					files: entry?.session.index?.entries().length ?? null,
					message:
						state === "error"
							? (entry?.connections.currentState.message ?? null)
							: state === "noaccess"
								? "You are no longer a member of this folder's team."
								: null,
				},
				{ openTeam: teamId ? () => this.openSettings({ kind: "team", teamId }) : null },
			),
		);
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
			const mapped = folders.filter((f) => known.has(f.workspaceId) && !f.paused);
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
		// The folder's pill turns from syncing to synced once the index is in.
		let offSynced = () => {};
		this.live.set(workspaceId, {
			name: this.settings.workspaces.find((w) => w.id === workspaceId)?.name ?? workspaceId,
			connections,
			session: started,
			stop: () => {
				offOnline();
				offSynced();
				started.stop();
				offState();
				offMembership();
				connections.destroy();
			},
		});
		started.start();
		const provider = started.indexProvider;
		const onSynced = () => this.notifyView();
		provider.on("synced", onSynced);
		offSynced = () => provider.off("synced", onSynced);
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
			await this.refreshTeams();
			return;
		}
		const entry = this.live.get(workspaceId);
		if (entry?.connections !== connections) return;
		const name = this.settings.workspaces.find((w) => w.id === workspaceId)?.name ?? entry.name;
		this.live.delete(workspaceId);
		entry.stop();
		new Notice(`ArcaSync: you were removed from ${name}`);
		// Drop it locally first: if the uncached refresh fails, it still must not reconnect.
		await this.updateSettings({
			workspaces: this.settings.workspaces.filter((w) => w.id !== workspaceId),
		});
		await this.refreshTeams();
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
		this.cancelBrowserSignIn();
		this.disconnect();
		if (this.signedIn) {
			try {
				// Before clearing: the client reads the token for the Authorization header.
				await this.api.logout();
			} catch (error) {
				// Offline or already revoked: the local session is dropped either way.
				console.warn("[ArcaSync] logout request failed", error);
			}
		}
		this.secrets.clear();
		this.tokens.invalidate();
		this.me = null;
		await this.updateSettings({ user: null, workspaces: [], teams: [], workspaceId: "" });
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
