import type { AuthProvider, InviteSummary, PinSummary, Role } from "@arcasync/shared";
import type { ConnectionStatus } from "../../net/ConnectionManager";
import type { FolderState, MemberView, TeamView } from "../settings/model";
import type { Page } from "../settings/router";

/** A vault folder mapped to a shared folder, with what the rows show about it. */
export interface MappedFolderView {
	path: string;
	workspaceId: string;
	teamId: string | null;
	teamName: string | null;
	folderName: string | null;
	state: FolderState;
	paused: boolean;
}

/** "Continue with Google": the device code is waiting for the browser to approve it. */
export interface BrowserSignInView {
	provider: AuthProvider;
	userCode: string | null;
	/** Set when the sign-in ended without a session (expired, denied, failed). */
	error: string | null;
}

export interface InvitesView {
	invites: InviteSummary[];
	/** null when the server has no PINs. */
	pins: PinSummary[] | null;
	pinsLocked: boolean;
}

/**
 * Everything the settings pages render. A plain type alias (not an interface) so it satisfies
 * `Record<string, unknown>`.
 */
export type SettingsViewState = {
	page: Page;
	canGoBack: boolean;

	serverUrl: string;
	/** The hosted relay's URL, so Self-hosting can say whether it is in use. */
	defaultServerUrl: string;
	/** Non-null when `GET /api/server-info` failed. */
	serverError: string | null;
	serverVersion: string | null;
	devOpenLogin: boolean;
	devLoginName: string;
	/** `features.accounts`: invites and device sign-in. */
	accounts: boolean;
	/** `features.passwords`: name + password sign-in. */
	passwords: boolean;
	/** `features.pins`: a PIN works where an invite link does. */
	pins: boolean;
	/** `features.teams`: team pages, create team, share folder. */
	teamsFeature: boolean;
	/** Browser sign-in providers (`ServerInfo.auth.providers`). */
	providers: AuthProvider[];
	limits: { teamsPerUser: number; membersPerTeam: number; foldersPerTeam: number } | null;

	signedIn: boolean;
	user: {
		id: string;
		name: string;
		email: string | null;
		color: string;
		avatarUrl: string | null;
		isAdmin: boolean;
	} | null;
	/** null while unknown. */
	hasPassword: boolean | null;
	browserSignIn: BrowserSignInView | null;

	status: ConnectionStatus;
	statusMessage: string | null;
	teams: TeamView[];
	folders: MappedFolderView[];
	/** A request is in flight; buttons are disabled. */
	busy: boolean;
};

/** What the settings pages can ask the plugin to do. */
export interface SettingsController {
	navigate(page: Page): void;
	back(): void;

	startBrowserSignIn(provider: AuthProvider): void;
	/** Opens the browser page again for the pending code. */
	reopenBrowserSignIn(): void;
	cancelBrowserSignIn(): void;
	passwordSignIn(name: string, password: string): Promise<boolean>;
	/** Invite link, code or PIN. Signed out, `name` names the new account; a PIN also needs a password. */
	join(input: string, name: string, password: string, confirm: string): Promise<boolean>;
	deviceSignIn(): void;
	signOut(): void;
	setPassword(): void;
	approveDevice(): void;
	connect(): void;
	disconnect(): void;

	refreshTeams(): void;
	createTeam(): void;
	renameTeam(teamId: string, name: string): Promise<boolean>;
	deleteTeam(team: TeamView): void;
	leaveTeam(team: TeamView): void;
	loadMembers(team: TeamView): Promise<MemberView[]>;
	setRole(team: TeamView, userId: string, role: Role): Promise<boolean>;
	/** Asks first; resolves true once removed. */
	removeMember(team: TeamView, member: MemberView): Promise<boolean>;
	loadInvites(team: TeamView): Promise<InvitesView>;
	/** The new link (shown once), or null on failure. */
	createInviteLink(team: TeamView, role: Role): Promise<string | null>;
	createPin(team: TeamView, role: Role): Promise<PinSummary | null>;
	revokeInvite(team: TeamView, inviteId: string): Promise<void>;
	revokePin(team: TeamView, pinId: string): Promise<void>;
	copy(text: string, what: string): void;

	/** Picks a vault folder for a team folder that is not in this vault yet. */
	addToVault(workspaceId: string, folderName: string): void;
	shareLocalFolder(team: TeamView | null): void;
	/** The ⋯ menu of a team folder row. */
	folderMenu(event: MouseEvent, team: TeamView, folder: { id: string; name: string }): void;

	setServerUrl(value: string): void;
	setDevLoginName(value: string): void;
	refreshServer(): void;
}

export type SettingsViewProps = SettingsViewState & { ctl: SettingsController };
