/**
 * Accounts, devices, sessions, workspaces and memberships for the whole deployment, in one
 * SQLite Durable Object (singleton by name). Mirrors the behaviour of the Node server's
 * `routes/auth.ts`, `routes/workspaces.ts` and `seed.ts`; responses use the shared zod shapes.
 */

import { DurableObject } from "cloudflare:workers";
import type {
	BootstrapResponse,
	DeviceInfo,
	InviteAcceptRequest,
	InviteCreated,
	InviteCreateRequest,
	InvitesResponse,
	MeResponse,
	Role,
	SessionResponse,
	User,
	WorkspaceSummary,
	WorkspacesResponse,
} from "@teamsync/shared";
import { WS_TOKEN_TTL_SECONDS } from "@teamsync/shared";
import type { z } from "zod";
import { constantTimeEqual, hashSecret, newOpaqueToken, sha256 } from "./accounts/tokens";
import type { Env } from "./env";
import { signWsToken } from "./jwt";

export const SESSION_TTL_SECONDS = 90 * 24 * 60 * 60;
const DEV_WORKSPACE_SLUG = "dev";
const BOOTSTRAP_INVITE_TTL_MS = 24 * 60 * 60 * 1000;
const MIN_BOOTSTRAP_TOKEN_LENGTH = 32;
const ROLE_RANK: Record<Role, number> = { viewer: 1, editor: 2, owner: 3 };

export interface ApiError {
	status: 400 | 401 | 403 | 404 | 409 | 410 | 411 | 413 | 429 | 503;
	code: string;
	message: string;
}
export type Result<T> = { ok: true; value: T } | { ok: false; error: ApiError };

const ok = <T>(value: T): Result<T> => ({ ok: true, value });
const fail = (status: ApiError["status"], code: string, message: string): Result<never> => ({
	ok: false,
	error: { status, code, message },
});

const PALETTE = [
	"#e8534a",
	"#e88a34",
	"#d9b021",
	"#69b32d",
	"#2fae8f",
	"#2f90d0",
	"#5a6ee0",
	"#8f5ad8",
	"#d24fa8",
	"#c9575f",
];

/** Same deterministic colour as the Node server (`sha256(name)[0] % palette`). */
async function userColor(seed: string): Promise<string> {
	const digest = await sha256(seed);
	return PALETTE[(digest[0] ?? 0) % PALETTE.length] ?? "#2f90d0";
}

/** `obsidian://` link the plugin's protocol handler turns into a prefilled join. */
export function inviteUrl(publicUrl: string, token: string): string {
	return `obsidian://teamsync?server=${encodeURIComponent(publicUrl)}&invite=${token}`;
}

/** Lowercase `a-z0-9-`, at most 40 characters (the `DevLoginRequest.workspace` slug shape). */
function slugify(name: string): string {
	const slug = name
		.toLowerCase()
		.normalize("NFKD")
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 40)
		.replace(/-+$/, "");
	return slug || "workspace";
}

interface UserRow extends Record<string, SqlStorageValue> {
	id: string;
	name: string;
	email: string | null;
	color: string;
	avatar_url: string | null;
	is_admin: number;
	disabled_at: number | null;
}

interface InviteRow extends Record<string, SqlStorageValue> {
	id: string;
	workspace_id: string;
	role: string;
	admin: number;
	max_uses: number;
	uses: number;
	expires_at: number;
	revoked_at: number | null;
	created_by: string | null;
}

interface SessionRow extends Record<string, SqlStorageValue> {
	session_id: string;
	user_id: string;
	device_id: string;
	device_name: string;
	platform: string;
	expires_at: number;
	revoked_at: number | null;
}

function toApiUser(row: UserRow): User {
	return {
		id: row.id,
		name: row.name,
		email: row.email,
		color: row.color,
		avatarUrl: row.avatar_url,
		isAdmin: row.is_admin === 1,
	};
}

export class AccountsDO extends DurableObject<Env> {
	private readonly sql: SqlStorage;

	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
		this.sql = ctx.storage.sql;
		this.sql.exec(`
			CREATE TABLE IF NOT EXISTS users (
				id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, email TEXT, color TEXT NOT NULL,
				avatar_url TEXT, is_admin INTEGER NOT NULL DEFAULT 0, disabled_at INTEGER);
			CREATE TABLE IF NOT EXISTS devices (
				id TEXT PRIMARY KEY, user_id TEXT NOT NULL, name TEXT NOT NULL, platform TEXT NOT NULL,
				vault_id TEXT NOT NULL, UNIQUE (user_id, vault_id));
			CREATE TABLE IF NOT EXISTS sessions (
				id TEXT PRIMARY KEY, user_id TEXT NOT NULL, device_id TEXT NOT NULL,
				token_hash TEXT NOT NULL UNIQUE, expires_at INTEGER NOT NULL, revoked_at INTEGER);
			CREATE TABLE IF NOT EXISTS workspaces (
				id TEXT PRIMARY KEY, slug TEXT NOT NULL UNIQUE, name TEXT NOT NULL, deleted_at INTEGER);
			CREATE TABLE IF NOT EXISTS memberships (
				workspace_id TEXT NOT NULL, user_id TEXT NOT NULL, role TEXT NOT NULL,
				PRIMARY KEY (workspace_id, user_id));
			CREATE TABLE IF NOT EXISTS server_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
			CREATE TABLE IF NOT EXISTS audit_log (
				id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, actor_id TEXT,
				action TEXT NOT NULL, target TEXT NOT NULL, details TEXT NOT NULL DEFAULT '{}');
			CREATE TABLE IF NOT EXISTS invites (
				id TEXT PRIMARY KEY, token_hash TEXT NOT NULL UNIQUE, workspace_id TEXT NOT NULL,
				role TEXT NOT NULL, admin INTEGER NOT NULL DEFAULT 0, max_uses INTEGER NOT NULL,
				uses INTEGER NOT NULL DEFAULT 0, expires_at INTEGER NOT NULL, revoked_at INTEGER,
				created_by TEXT, created_at INTEGER NOT NULL);
			CREATE TABLE IF NOT EXISTS device_codes (
				id TEXT PRIMARY KEY, code_hash TEXT NOT NULL UNIQUE, user_code TEXT NOT NULL UNIQUE,
				device TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending', user_id TEXT,
				expires_at INTEGER NOT NULL, created_at INTEGER NOT NULL);
		`);
	}

	private hashToken(token: string): Promise<string> {
		return hashSecret(this.env.TEAMSYNC_SECRET, token);
	}

	/** One audit row; callers write it in the same synchronous block as the mutation. */
	private audit(
		actorId: string | null,
		action: string,
		target: string,
		details: Record<string, unknown> = {},
	): void {
		this.sql.exec(
			"INSERT INTO audit_log (at, actor_id, action, target, details) VALUES (?, ?, ?, ?, ?)",
			Date.now(),
			actorId,
			action,
			target,
			JSON.stringify(details),
		);
	}

	private roleIn(userId: string, workspaceId: string): Role | undefined {
		return this.sql
			.exec<{ role: string }>(
				`SELECT m.role FROM memberships m JOIN workspaces w ON w.id = m.workspace_id
				 WHERE m.workspace_id = ? AND m.user_id = ? AND w.deleted_at IS NULL`,
				workspaceId,
				userId,
			)
			.toArray()[0]?.role as Role | undefined;
	}

	/** Owners of the workspace and server admins manage its invites and members. */
	private canManage(user: UserRow, workspaceId: string): boolean {
		return user.is_admin === 1 || this.roleIn(user.id, workspaceId) === "owner";
	}

	private createWorkspaceRow(name: string): WorkspaceSummary & { role: "owner" } {
		const base = slugify(name);
		const taken = (slug: string) =>
			this.sql.exec("SELECT 1 FROM workspaces WHERE slug = ?", slug).toArray().length > 0;
		let slug = base;
		for (let n = 2; taken(slug); n++) slug = `${base.slice(0, 40 - `-${n}`.length)}-${n}`;
		const id = crypto.randomUUID();
		this.sql.exec("INSERT INTO workspaces (id, slug, name) VALUES (?, ?, ?)", id, slug, name);
		return { id, slug, name, role: "owner" };
	}

	private insertInvite(
		tokenHash: string,
		workspaceId: string,
		role: Role,
		admin: boolean,
		maxUses: number,
		expiresAt: number,
		createdBy: string | null,
	): string {
		const id = crypto.randomUUID();
		this.sql.exec(
			`INSERT INTO invites (id, token_hash, workspace_id, role, admin, max_uses, expires_at,
			 created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			id,
			tokenHash,
			workspaceId,
			role,
			admin ? 1 : 0,
			maxUses,
			expiresAt,
			createdBy,
			Date.now(),
		);
		return id;
	}

	/** A usable invite for `tokenHash`, or why not (404 unknown/revoked, 410 expired/used). */
	private usableInvite(tokenHash: string): Result<InviteRow> {
		const invite = this.sql
			.exec<InviteRow>(
				`SELECT i.* FROM invites i JOIN workspaces w ON w.id = i.workspace_id
				 WHERE i.token_hash = ? AND w.deleted_at IS NULL`,
				tokenHash,
			)
			.toArray()[0];
		if (!invite || invite.revoked_at !== null) return fail(404, "not_found", "Unknown invite");
		if (invite.expires_at <= Date.now()) return fail(410, "invite_expired", "Invite expired");
		if (invite.uses >= invite.max_uses) return fail(410, "invite_used", "Invite already used");
		return ok(invite);
	}

	/** Find-or-create the user's device for this vault; returns its id. */
	private deviceFor(userId: string, device: DeviceInfo): string {
		const existing = this.sql
			.exec<{ id: string }>(
				"SELECT id FROM devices WHERE user_id = ? AND vault_id = ?",
				userId,
				device.vaultId,
			)
			.toArray()[0];
		if (existing) return existing.id;
		const id = crypto.randomUUID();
		this.sql.exec(
			"INSERT INTO devices (id, user_id, name, platform, vault_id) VALUES (?, ?, ?, ?, ?)",
			id,
			userId,
			device.name,
			device.platform,
			device.vaultId,
		);
		return id;
	}

	private insertSession(userId: string, deviceId: string, tokenHash: string): void {
		this.sql.exec(
			"INSERT INTO sessions (id, user_id, device_id, token_hash, expires_at) VALUES (?, ?, ?, ?, ?)",
			crypto.randomUUID(),
			userId,
			deviceId,
			tokenHash,
			Date.now() + SESSION_TTL_SECONDS * 1000,
		);
	}

	private ensureDevWorkspace(slug = DEV_WORKSPACE_SLUG): string {
		const existing = this.sql
			.exec<{ id: string }>("SELECT id FROM workspaces WHERE slug = ?", slug)
			.toArray()[0];
		if (existing) return existing.id;
		const id = crypto.randomUUID();
		this.sql.exec(
			"INSERT INTO workspaces (id, slug, name) VALUES (?, ?, ?)",
			id,
			slug,
			slug === DEV_WORKSPACE_SLUG ? "Dev" : slug,
		);
		return id;
	}

	private workspacesFor(userId: string): WorkspaceSummary[] {
		return this.sql
			.exec<{ id: string; slug: string; name: string; role: string }>(
				`SELECT w.id, w.slug, w.name, m.role FROM memberships m
				 JOIN workspaces w ON w.id = m.workspace_id
				 WHERE m.user_id = ? AND w.deleted_at IS NULL`,
				userId,
			)
			.toArray()
			.map((r) => ({ id: r.id, slug: r.slug, name: r.name, role: r.role as Role }));
	}

	private userById(id: string): UserRow | undefined {
		return this.sql.exec<UserRow>("SELECT * FROM users WHERE id = ?", id).toArray()[0];
	}

	/**
	 * `role` applies only when this creates the membership; existing memberships keep theirs.
	 * `workspace` joins (or creates) that slug instead of `dev`.
	 */
	async devLogin(
		name: string,
		device: DeviceInfo,
		role?: Role,
		workspace?: string,
	): Promise<Result<SessionResponse>> {
		if (this.env.TEAMSYNC_DEV_OPEN_LOGIN !== "1") {
			return fail(403, "forbidden", "Dev login is disabled");
		}
		const color = await userColor(name);
		const sessionToken = newOpaqueToken();
		const tokenHash = await this.hashToken(sessionToken);

		// Everything below is synchronous, so it commits as one implicit transaction.
		let user = this.sql.exec<UserRow>("SELECT * FROM users WHERE name = ?", name).toArray()[0];
		if (!user) {
			this.sql.exec(
				"INSERT INTO users (id, name, color) VALUES (?, ?, ?)",
				crypto.randomUUID(),
				name,
				color,
			);
			user = this.sql.exec<UserRow>("SELECT * FROM users WHERE name = ?", name).toArray()[0];
		}
		if (!user) return fail(400, "bad_request", "Could not create user");

		const workspaceId = this.ensureDevWorkspace(workspace);
		const firstMember = this.sql
			.exec("SELECT user_id FROM memberships WHERE workspace_id = ? LIMIT 1", workspaceId)
			.toArray()[0];
		this.sql.exec(
			"INSERT INTO memberships (workspace_id, user_id, role) VALUES (?, ?, ?) ON CONFLICT DO NOTHING",
			workspaceId,
			user.id,
			role ?? (firstMember ? "editor" : "owner"),
		);

		this.insertSession(user.id, this.deviceFor(user.id, device), tokenHash);

		return ok({ sessionToken, user: toApiUser(user), workspaces: this.workspacesFor(user.id) });
	}

	private async session(token: string | null): Promise<Result<{ user: UserRow; row: SessionRow }>> {
		if (!token) return fail(401, "unauthorized", "Missing bearer token");
		const row = this.sql
			.exec<SessionRow>(
				`SELECT s.id AS session_id, s.user_id, s.device_id, s.expires_at, s.revoked_at,
				        d.name AS device_name, d.platform
				 FROM sessions s JOIN devices d ON d.id = s.device_id
				 WHERE s.token_hash = ? AND s.revoked_at IS NULL`,
				await this.hashToken(token),
			)
			.toArray()[0];
		if (!row) return fail(401, "unauthorized", "Invalid session");
		if (row.expires_at <= Date.now()) return fail(401, "unauthorized", "Session expired");
		const user = this.userById(row.user_id);
		if (!user) return fail(401, "unauthorized", "Invalid session");
		if (user.disabled_at) return fail(403, "forbidden", "Account disabled");
		return ok({ user, row });
	}

	async me(token: string | null): Promise<Result<z.infer<typeof MeResponse>>> {
		const s = await this.session(token);
		if (!s.ok) return s;
		const { user, row } = s.value;
		return ok({
			user: toApiUser(user),
			device: { id: row.device_id, name: row.device_name, platform: row.platform },
			workspaces: this.workspacesFor(user.id),
		});
	}

	async wsToken(
		token: string | null,
		workspaceId: string,
	): Promise<Result<{ token: string; expiresAt: number }>> {
		const s = await this.session(token);
		if (!s.ok) return s;
		const { user, row } = s.value;
		const membership = this.sql
			.exec<{ role: string }>(
				"SELECT role FROM memberships WHERE workspace_id = ? AND user_id = ?",
				workspaceId,
				user.id,
			)
			.toArray()[0];
		if (!membership) return fail(404, "not_found", "No membership in that workspace");
		return ok(
			await signWsToken(
				{ userId: user.id, workspaceId, role: membership.role as Role, deviceId: row.device_id },
				this.env.TEAMSYNC_SECRET,
				WS_TOKEN_TTL_SECONDS,
			),
		);
	}

	async logout(token: string | null): Promise<Result<{ ok: true }>> {
		const s = await this.session(token);
		if (!s.ok) return s;
		this.sql.exec(
			"UPDATE sessions SET revoked_at = ? WHERE id = ?",
			Date.now(),
			s.value.row.session_id,
		);
		return ok({ ok: true });
	}

	async workspaces(token: string | null): Promise<Result<{ workspaces: WorkspaceSummary[] }>> {
		const s = await this.session(token);
		if (!s.ok) return s;
		return ok({ workspaces: this.workspacesFor(s.value.user.id) });
	}

	// --- P2 accounts: bootstrap, invites, workspaces ---

	/** One-shot: the first workspace plus a single-use owner + admin invite (D1). */
	async bootstrap(
		token: string | null,
		workspaceName: string,
		publicUrl: string,
	): Promise<Result<BootstrapResponse>> {
		const expected = this.env.TEAMSYNC_BOOTSTRAP_TOKEN ?? "";
		if (!expected) return fail(404, "not_found", "Bootstrap is not enabled");
		if (
			expected.length < MIN_BOOTSTRAP_TOKEN_LENGTH &&
			this.env.TEAMSYNC_ALLOW_DEV_SECRET !== "1"
		) {
			return fail(503, "misconfigured", "TEAMSYNC_BOOTSTRAP_TOKEN is too short");
		}
		const [given, wanted] = await Promise.all([sha256(token ?? ""), sha256(expected)]);
		if (!token || !constantTimeEqual(given, wanted)) {
			return fail(401, "unauthorized", "Invalid bootstrap token");
		}
		const inviteToken = newOpaqueToken();
		const inviteHash = await this.hashToken(inviteToken);

		if (this.sql.exec("SELECT 1 FROM server_settings WHERE key = 'bootstrapped_at'").toArray()[0]) {
			return fail(409, "already_bootstrapped", "This server is already bootstrapped");
		}
		const now = Date.now();
		const workspace = this.createWorkspaceRow(workspaceName);
		const expiresAt = now + BOOTSTRAP_INVITE_TTL_MS;
		const inviteId = this.insertInvite(inviteHash, workspace.id, "owner", true, 1, expiresAt, null);
		this.sql.exec(
			"INSERT INTO server_settings (key, value) VALUES ('bootstrapped_at', ?)",
			String(now),
		);
		this.audit(null, "bootstrap", workspace.id, { inviteId });
		return ok({
			workspace,
			invite: {
				id: inviteId,
				token: inviteToken,
				url: inviteUrl(publicUrl, inviteToken),
				role: "owner",
				admin: true,
				maxUses: 1,
				expiresAt,
			},
		});
	}

	async createInvite(
		token: string | null,
		workspaceId: string,
		req: InviteCreateRequest,
		publicUrl: string,
	): Promise<Result<InviteCreated>> {
		const inviteToken = newOpaqueToken();
		const inviteHash = await this.hashToken(inviteToken);
		const s = await this.session(token);
		if (!s.ok) return s;
		const { user } = s.value;
		if (!this.canManage(user, workspaceId)) return fail(403, "forbidden", "Owner or admin only");
		const expiresAt = Date.now() + req.expiresInSec * 1000;
		const id = this.insertInvite(
			inviteHash,
			workspaceId,
			req.role,
			false,
			req.maxUses,
			expiresAt,
			user.id,
		);
		this.audit(user.id, "invite.create", id, {
			workspaceId,
			role: req.role,
			maxUses: req.maxUses,
		});
		return ok({
			id,
			token: inviteToken,
			url: inviteUrl(publicUrl, inviteToken),
			role: req.role,
			admin: false,
			maxUses: req.maxUses,
			expiresAt,
		});
	}

	/** Never returns tokens (only their hashes are stored). */
	async listInvites(token: string | null, workspaceId: string): Promise<Result<InvitesResponse>> {
		const s = await this.session(token);
		if (!s.ok) return s;
		if (!this.canManage(s.value.user, workspaceId)) {
			return fail(403, "forbidden", "Owner or admin only");
		}
		const invites = this.sql
			.exec<InviteRow>(
				"SELECT * FROM invites WHERE workspace_id = ? ORDER BY created_at DESC",
				workspaceId,
			)
			.toArray()
			.map((r) => ({
				id: r.id,
				role: r.role as Role,
				admin: r.admin === 1,
				uses: r.uses,
				maxUses: r.max_uses,
				expiresAt: r.expires_at,
				// The bootstrap invite has no creator.
				createdBy: r.created_by ?? "",
				revoked: r.revoked_at !== null,
			}));
		return ok({ invites });
	}

	async revokeInvite(
		token: string | null,
		workspaceId: string,
		inviteId: string,
	): Promise<Result<{ ok: true }>> {
		const s = await this.session(token);
		if (!s.ok) return s;
		const { user } = s.value;
		if (!this.canManage(user, workspaceId)) return fail(403, "forbidden", "Owner or admin only");
		const invite = this.sql
			.exec<InviteRow>(
				"SELECT * FROM invites WHERE id = ? AND workspace_id = ?",
				inviteId,
				workspaceId,
			)
			.toArray()[0];
		if (!invite) return fail(404, "not_found", "Unknown invite");
		if (invite.revoked_at === null) {
			this.sql.exec("UPDATE invites SET revoked_at = ? WHERE id = ?", Date.now(), inviteId);
			this.audit(user.id, "invite.revoke", inviteId, { workspaceId });
		}
		return ok({ ok: true });
	}

	/** Unauthenticated: a new user joins through an invite and gets a session. */
	async acceptInvite(req: InviteAcceptRequest): Promise<Result<SessionResponse>> {
		const inviteHash = await this.hashToken(req.token);
		const sessionToken = newOpaqueToken();
		const sessionHash = await this.hashToken(sessionToken);
		const color = await userColor(req.name);

		// Synchronous from here: the use count cannot be double-spent.
		const found = this.usableInvite(inviteHash);
		if (!found.ok) return found;
		const invite = found.value;
		if (this.sql.exec("SELECT 1 FROM users WHERE name = ?", req.name).toArray()[0]) {
			return fail(409, "name_taken", "That name is taken");
		}
		const userId = crypto.randomUUID();
		this.sql.exec(
			"INSERT INTO users (id, name, color, is_admin) VALUES (?, ?, ?, ?)",
			userId,
			req.name,
			color,
			invite.admin,
		);
		this.sql.exec(
			"INSERT INTO memberships (workspace_id, user_id, role) VALUES (?, ?, ?)",
			invite.workspace_id,
			userId,
			invite.role,
		);
		this.insertSession(userId, this.deviceFor(userId, req.device), sessionHash);
		this.sql.exec("UPDATE invites SET uses = uses + 1 WHERE id = ?", invite.id);
		this.audit(userId, "invite.accept", invite.id, {
			workspaceId: invite.workspace_id,
			role: invite.role,
			admin: invite.admin === 1,
		});
		const user = this.userById(userId);
		if (!user) return fail(400, "bad_request", "Could not create user");
		return ok({ sessionToken, user: toApiUser(user), workspaces: this.workspacesFor(userId) });
	}

	/** Authenticated: an existing user joins another workspace; an existing role never drops. */
	async redeemInvite(
		token: string | null,
		inviteToken: string,
	): Promise<Result<WorkspacesResponse>> {
		const inviteHash = await this.hashToken(inviteToken);
		const s = await this.session(token);
		if (!s.ok) return s;
		const { user } = s.value;
		const found = this.usableInvite(inviteHash);
		if (!found.ok) return found;
		const invite = found.value;
		const offered = invite.role as Role;
		const current = this.roleIn(user.id, invite.workspace_id);
		const role = current && ROLE_RANK[current] >= ROLE_RANK[offered] ? current : offered;
		this.sql.exec(
			`INSERT INTO memberships (workspace_id, user_id, role) VALUES (?, ?, ?)
			 ON CONFLICT (workspace_id, user_id) DO UPDATE SET role = excluded.role`,
			invite.workspace_id,
			user.id,
			role,
		);
		if (invite.admin === 1) this.sql.exec("UPDATE users SET is_admin = 1 WHERE id = ?", user.id);
		this.sql.exec("UPDATE invites SET uses = uses + 1 WHERE id = ?", invite.id);
		this.audit(user.id, "invite.redeem", invite.id, {
			workspaceId: invite.workspace_id,
			role,
			previousRole: current ?? null,
			admin: invite.admin === 1,
		});
		return ok({ workspaces: this.workspacesFor(user.id) });
	}

	/** Admin only; the creator owns the new workspace. */
	async createWorkspace(token: string | null, name: string): Promise<Result<WorkspaceSummary>> {
		const s = await this.session(token);
		if (!s.ok) return s;
		const { user } = s.value;
		if (user.is_admin !== 1) return fail(403, "forbidden", "Admin only");
		const workspace = this.createWorkspaceRow(name);
		this.sql.exec(
			"INSERT INTO memberships (workspace_id, user_id, role) VALUES (?, ?, 'owner')",
			workspace.id,
			user.id,
		);
		this.audit(user.id, "workspace.create", workspace.id, { name, slug: workspace.slug });
		return ok(workspace);
	}

	// --- dev-only (worker gates these on TEAMSYNC_DEBUG_STATS) ---

	async debugExpireInvite(id: string): Promise<{ ok: boolean }> {
		const changed = this.sql
			.exec("UPDATE invites SET expires_at = ? WHERE id = ? RETURNING id", Date.now() - 1, id)
			.toArray().length;
		return { ok: changed > 0 };
	}
}
