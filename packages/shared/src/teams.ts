/**
 * Teams and OAuth sign-in: the contract between relay-cf, the plugin and the website.
 *
 * A team owns shared folders. Each shared folder is a workspace (its own Yjs index and docs), so
 * sync, sockets and ws-tokens are unchanged. Team membership is the source of truth: every member
 * of a team holds a workspace membership with their team role in each of the team's folders, and
 * the relay keeps the two in step.
 */
import { z } from "zod";
import { AuthProvider, DeviceInfo, Role, User } from "./protocol.js";

// --- OAuth ---

/**
 * `POST /api/auth/oauth/:provider/start` → `{ url }`; the caller navigates there.
 * `signin` signs in or creates the account (subject to the signup policy). `link` (bearer
 * required) attaches the provider identity to the signed-in account.
 * `next` is a site path the website returns to after the handoff (`/account`, `/approve?code=…`,
 * `/join?invite=…`); the relay only stores and echoes it.
 */
export const OAuthStartRequest = z.object({
	intent: z.enum(["signin", "link"]).default("signin"),
	next: z.string().max(300).optional(),
	/**
	 * Binds the handoff to the browser that started it (no login CSRF): base64url SHA-256 of a
	 * random `verifier` the site keeps in sessionStorage and sends with the exchange.
	 */
	verifierHash: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
});
export type OAuthStartRequest = z.infer<typeof OAuthStartRequest>;

export const OAuthStartResponse = z.object({ url: z.string() });
export type OAuthStartResponse = z.infer<typeof OAuthStartResponse>;

/**
 * The provider redirects to `GET /api/auth/oauth/:provider/callback`; the relay then redirects
 * to `${ARCASYNC_PUBLIC_URL}/auth/callback?handoff=<one-time code>&next=<next>` or
 * `…/auth/callback?error=<code>&next=<next>` (codes: `signup_closed`, `identity_in_use`,
 * `oauth_denied`, `oauth_failed`, `state_expired`, `too_many_users`).
 * The site exchanges the handoff (60 s, single use) for a session:
 * `POST /api/auth/oauth/exchange` → `SessionResponse & { created: boolean }`.
 */
export const OAuthExchangeRequest = z.object({
	handoff: z.string().min(16).max(128),
	/** The value whose hash was sent as `verifierHash`; a mismatch is 400 `oauth_failed`. */
	verifier: z.string().min(43).max(128),
	device: DeviceInfo,
});
export type OAuthExchangeRequest = z.infer<typeof OAuthExchangeRequest>;

export const Identity = z.object({
	provider: AuthProvider,
	email: z.string().nullable(),
	linkedAt: z.number(),
});
export type Identity = z.infer<typeof Identity>;

/** `GET /api/auth/identities` → linked providers; `DELETE /api/auth/identities/:provider`. */
export const IdentitiesResponse = z.object({
	identities: z.array(Identity),
	hasPassword: z.boolean(),
});
export type IdentitiesResponse = z.infer<typeof IdentitiesResponse>;

/** `PATCH /api/auth/profile` — rename yourself (names stay unique, case-insensitively). */
export const ProfileUpdateRequest = z.object({ name: z.string().min(1).max(60) });
export type ProfileUpdateRequest = z.infer<typeof ProfileUpdateRequest>;

// --- Teams ---

export const SharedFolderSummary = z.object({
	/** The workspace id: what the plugin maps a local folder to and opens sockets for. */
	id: z.string(),
	slug: z.string(),
	name: z.string(),
});
export type SharedFolderSummary = z.infer<typeof SharedFolderSummary>;

export const TeamSummary = z.object({
	id: z.string(),
	slug: z.string(),
	name: z.string(),
	/** The caller's role in the team. */
	role: Role,
	memberCount: z.number(),
	folders: z.array(SharedFolderSummary),
});
export type TeamSummary = z.infer<typeof TeamSummary>;

/** `GET /api/teams` → the caller's teams. */
export const TeamsResponse = z.object({ teams: z.array(TeamSummary) });
export type TeamsResponse = z.infer<typeof TeamsResponse>;

/** `POST /api/teams` → `TeamSummary` (caller becomes owner); `PATCH /api/teams/:id` (owner). */
export const TeamCreateRequest = z.object({ name: z.string().trim().min(1).max(60) });
export type TeamCreateRequest = z.infer<typeof TeamCreateRequest>;

export const TeamMember = z.object({
	user: User.pick({ id: true, name: true, email: true, color: true, avatarUrl: true }),
	role: Role,
});
export type TeamMember = z.infer<typeof TeamMember>;

/**
 * `GET /api/teams/:id/members`; `PATCH /api/teams/:id/members/:userId` `{ role }` (owner);
 * `DELETE /api/teams/:id/members/:userId` (owner removes anyone but the last owner; anyone
 * removes themself = leave).
 */
export const TeamMembersResponse = z.object({ members: z.array(TeamMember) });
export type TeamMembersResponse = z.infer<typeof TeamMembersResponse>;

/**
 * `POST /api/teams/:id/folders` `{ name }` → `SharedFolderSummary` (owner or editor);
 * `DELETE /api/teams/:id/folders/:folderId` (owner). Deleting removes it for everyone.
 */
export const FolderCreateRequest = z.object({ name: z.string().trim().min(1).max(60) });
export type FolderCreateRequest = z.infer<typeof FolderCreateRequest>;

/**
 * Team invites reuse the invite and PIN shapes (`InviteCreateRequest`, `InviteCreated`,
 * `PinCreateRequest`, `PinSummary`) under `/api/teams/:id/invites` and `/api/teams/:id/pins`;
 * accepting one joins the team (and so every folder in it). Active PINs are capped per team, and
 * new PINs (invite and reset) have 6 digits; 4-digit PINs already issued stay valid. The older
 * `/api/workspaces/:id/invites|pins` routes keep working and act on the folder's team.
 */
export const TEAM_ROUTES = true;
