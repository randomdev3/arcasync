import type {
	AuthProvider,
	InviteSummary,
	Member,
	PinSummary,
	Role,
	TeamMember,
	TeamSummary,
	WorkspaceSummary,
} from "@arcasync/shared";
import { ApiRequestError } from "../../net/ApiClient";
import type { ConnectionStatus } from "../../net/ConnectionManager";

/**
 * A team as the settings pages show it. Against a server without `features.teams` every
 * workspace is shown as a team of one folder (`legacy`), managed through the workspace routes.
 */
export interface TeamView {
	id: string;
	name: string;
	role: Role;
	/** null for a legacy team (the workspace list carries no count). */
	memberCount: number | null;
	folders: { id: string; name: string }[];
	legacy: boolean;
}

export function teamViews(
	teamsFeature: boolean,
	teams: readonly TeamSummary[],
	workspaces: readonly WorkspaceSummary[],
): TeamView[] {
	if (teamsFeature) {
		return teams.map((t) => ({
			id: t.id,
			name: t.name,
			role: t.role,
			memberCount: t.memberCount,
			folders: t.folders.map((f) => ({ id: f.id, name: f.name })),
			legacy: false,
		}));
	}
	return workspaces.map((w) => ({
		id: w.id,
		name: w.name,
		role: w.role,
		memberCount: null,
		folders: [{ id: w.id, name: w.name }],
		legacy: true,
	}));
}

/** The team and folder a workspace id belongs to, or null. */
export function teamOfFolder(
	teams: readonly TeamView[],
	workspaceId: string,
): { team: TeamView; folder: { id: string; name: string } } | null {
	for (const team of teams) {
		const folder = team.folders.find((f) => f.id === workspaceId);
		if (folder) return { team, folder };
	}
	return null;
}

export interface TeamPermissions {
	rename: boolean;
	deleteTeam: boolean;
	/** Change roles and remove members. */
	manageMembers: boolean;
	invite: boolean;
	/** Create a shared folder in the team. */
	shareFolder: boolean;
	deleteFolder: boolean;
}

/** What the UI offers; the relay authorises every change itself. */
export function teamPermissions(team: TeamView, isAdmin: boolean): TeamPermissions {
	const owner = team.role === "owner" || isAdmin;
	const teamRoutes = !team.legacy;
	return {
		rename: owner && teamRoutes,
		deleteTeam: owner && teamRoutes,
		manageMembers: owner,
		invite: owner,
		shareFolder: teamRoutes && (owner || team.role === "editor"),
		deleteFolder: owner && teamRoutes,
	};
}

/** One mapped folder's sync state, as the explorer pill and the settings rows show it. */
export type FolderState = "connected" | "syncing" | "offline" | "error" | "paused" | "noaccess";

export interface FolderStateInput {
	paused: boolean;
	/** The account is (still) a member of the folder's workspace. */
	member: boolean;
	/** The workspace's socket state; null when it is not connected at all. */
	connection: ConnectionStatus | null;
	/** The workspace's index has finished its first sync. */
	synced: boolean;
}

export function folderState(input: FolderStateInput): FolderState {
	if (input.paused) return "paused";
	if (!input.member) return "noaccess";
	switch (input.connection) {
		case null:
		case "disconnected":
			return "offline";
		case "error":
			return "error";
		case "connecting":
			return "syncing";
		case "connected":
			return input.synced ? "connected" : "syncing";
	}
}

export const FOLDER_STATE_LABEL: Record<FolderState, string> = {
	connected: "Synced",
	syncing: "Syncing…",
	offline: "Offline",
	error: "Error",
	paused: "Paused",
	noaccess: "No access",
};

export const ROLE_LABEL: Record<Role, string> = {
	owner: "Owner",
	editor: "Editor",
	viewer: "Viewer",
};

export const PROVIDER_LABEL: Record<AuthProvider, string> = {
	google: "Google",
	github: "GitHub",
};

/**
 * The website page that signs in with `provider` and then approves this device's code:
 * `${publicUrl}/signin?provider=…&next=<encoded /approve?code=…>`. Null unless `publicUrl` is
 * http(s).
 */
export function browserSignInUrl(
	publicUrl: string,
	provider: AuthProvider,
	userCode: string,
): string | null {
	let base: URL;
	try {
		base = new URL(publicUrl.trim());
	} catch {
		return null;
	}
	if (base.protocol !== "https:" && base.protocol !== "http:") return null;
	const root = `${base.origin}${base.pathname.replace(/\/+$/, "")}`;
	const next = `/approve?code=${encodeURIComponent(userCode)}`;
	return `${root}/signin?provider=${encodeURIComponent(provider)}&next=${encodeURIComponent(next)}`;
}

/** A team member from either the team or the legacy workspace route. */
export interface MemberView {
	id: string;
	name: string;
	email: string | null;
	color: string;
	avatarUrl: string | null;
	role: Role;
}

export function memberView(member: TeamMember | Member): MemberView {
	const user = member.user as Partial<TeamMember["user"]> & Member["user"];
	return {
		id: user.id,
		name: user.name,
		email: user.email ?? null,
		color: user.color,
		avatarUrl: user.avatarUrl ?? null,
		role: member.role,
	};
}

/** Owners first, then editors, then viewers; by name within a role. */
export function sortMembers(members: MemberView[]): MemberView[] {
	const rank: Record<Role, number> = { owner: 0, editor: 1, viewer: 2 };
	return [...members].sort((a, b) => rank[a.role] - rank[b.role] || a.name.localeCompare(b.name));
}

/** Invite links that can still be used. */
export function openInvites(invites: readonly InviteSummary[], now: number): InviteSummary[] {
	return invites.filter((i) => !i.revoked && i.uses < i.maxUses && i.expiresAt > now);
}

/** PINs that can still be used. */
export function openPins(pins: readonly PinSummary[], now: number): PinSummary[] {
	return pins.filter((p) => p.usedAt === null && !p.revoked && p.expiresAt > now);
}

/** "in 3 days" / "in 5 h" / "in 12 min" until `at` (ms). */
export function expiresIn(at: number, now: number): string {
	const minutes = Math.max(1, Math.round((at - now) / 60_000));
	if (minutes < 90) return `in ${minutes} min`;
	const hours = Math.round(minutes / 60);
	if (hours < 48) return `in ${hours} h`;
	return `in ${Math.round(hours / 24)} days`;
}

/** A short sentence for a failed team action. */
export function teamErrorMessage(error: unknown): string {
	if (error instanceof ApiRequestError) {
		switch (error.code) {
			case "last_owner":
				return "A team needs at least one owner";
			case "forbidden":
				return "Only team owners can do that";
			case "too_many_pins":
				return "Too many open PINs; revoke one first";
		}
		return error.message;
	}
	return error instanceof Error ? error.message : String(error);
}
