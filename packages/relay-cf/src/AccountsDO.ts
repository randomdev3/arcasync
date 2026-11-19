/**
 * Accounts, devices, sessions, workspaces and memberships for the whole deployment, in one
 * SQLite Durable Object (singleton by name). Mirrors the behaviour of the Node server's
 * `routes/auth.ts`, `routes/workspaces.ts` and `seed.ts`; responses use the shared zod shapes.
 */

import { DurableObject } from "cloudflare:workers";
import type {
	AuditResponse,
	BootstrapResponse,
	DeviceCodeResponse,
	DeviceInfo,
	DeviceLookupResponse,
	InviteAcceptRequest,
	InviteCreated,
	InviteCreateRequest,
	InvitesResponse,
	MembersResponse,
	MeResponse,
	Role,
	SessionResponse,
	User,
	WorkspaceSummary,
	WorkspacesResponse,
} from "@arcasync/shared";
import { DEVICE_CODE_INTERVAL_S, DEVICE_CODE_TTL_S, WS_TOKEN_TTL_SECONDS } from "@arcasync/shared";
import type { z } from "zod";
import {
	constantTimeEqual,
	hashSecret,
	newOpaqueToken,
	newUserCode,
	normalizeUserCode,
	sha256,
} from "./accounts/tokens";
import type { Env } from "./env";
import { signWsToken } from "./jwt";

export const SESSION_TTL_SECONDS = 90 * 24 * 60 * 60;
const DEV_WORKSPACE_SLUG = "dev";
const BOOTSTRAP_INVITE_TTL_MS = 24 * 60 * 60 * 1000;
const MIN_BOOTSTRAP_TOKEN_LENGTH = 32;
const ROLE_RANK: Record<Role, number> = { viewer: 1, editor: 2, owner: 3 };
const DEVICE_LOOKUPS_PER_MINUTE = 5;
const REENTRY_INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

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
	/** Set on a re-entry invite (`enableUser`): accepting it signs in as this existing user. */
	user_id: string | null;
}

interface DeviceCodeRow extends Record<string, SqlStorageValue> {
	id: string;
	user_code: string;
	device: string;
	status: string;
	user_id: string | null;
	expires_at: number;
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
	/** RPC calls since this wake (dev readout for the `me` cache; `debug*` calls not counted). */
	private calls = 0;
	/** Device-code id → last accepted poll (ms). Memory only: polls never write rows. */
	private readonly lastPoll = new Map<string, number>();
	/** Session id → recent device lookups (ms), for the per-minute limit. */
	private readonly lookups = new Map<string, number[]>();

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
		// Added after the table shipped to dev state: re-entry invites carry the user they sign in.
		try {
			this.sql.exec("ALTER TABLE invites ADD COLUMN user_id TEXT");
		} catch (err) {
			if (!String(err).includes("duplicate column")) throw err;
		}
	}

	private hashToken(token: string): Promise<string> {
		return hashSecret(this.env.ARCASYNC_SECRET, token);
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
		userId: string | null = null,
	): string {
		const id = crypto.randomUUID();
		this.sql.exec(
			`INSERT INTO invites (id, token_hash, workspace_id, role, admin, max_uses, expires_at,
			 created_by, created_at, user_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			id,
			tokenHash,
			workspaceId,
			role,
			admin ? 1 : 0,
			maxUses,
			expiresAt,
			createdBy,
			Date.now(),
			userId,
		);
		return id;
	}

	/**
	 * A usable invite for `tokenHash`, or why not (404 unknown/revoked, 410 expired/used).
	 * Re-entry invites have no workspace (`workspace_id = ''`), hence the LEFT JOIN.
	 */
	private usableInvite(tokenHash: string): Result<InviteRow> {
		const invite = this.sql
			.exec<InviteRow>(
				`SELECT i.* FROM invites i LEFT JOIN workspaces w ON w.id = i.workspace_id
				 WHERE i.token_hash = ? AND (i.user_id IS NOT NULL OR w.id IS NOT NULL)
				 AND w.deleted_at IS NULL`,
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

	/**
	 * Tells the workspace relay that `userId`'s membership changed (D5). Called after the DB change
	 * commits; one retry, then the change stands and only the ≤ 15 min JWT expiry bounds it.
	 */
	private async revokeSockets(workspaceId: string, userId: string): Promise<void> {
		for (let attempt = 1; ; attempt++) {
			try {
				await this.env.RELAY.getByName(workspaceId).revoke(userId);
				return;
			} catch (err) {
				if (attempt >= 2) {
					console.error(`accounts: revoke RPC to workspace ${workspaceId} failed`, err);
					return;
				}
			}
		}
	}

	private isLastOwner(workspaceId: string, userId: string): boolean {
		const owners = this.sql
			.exec<{ user_id: string }>(
				"SELECT user_id FROM memberships WHERE workspace_id = ? AND role = 'owner'",
				workspaceId,
			)
			.toArray();
		return owners.length === 1 && owners[0]?.user_id === userId;
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
		this.calls += 1;
		if (this.env.ARCASYNC_DEV_OPEN_LOGIN !== "1") {
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
		this.calls += 1;
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
		this.calls += 1;
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
				this.env.ARCASYNC_SECRET,
				WS_TOKEN_TTL_SECONDS,
			),
		);
	}

	async logout(token: string | null): Promise<Result<{ ok: true }>> {
		this.calls += 1;
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
		this.calls += 1;
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
		this.calls += 1;
		const expected = this.env.ARCASYNC_BOOTSTRAP_TOKEN ?? "";
		if (!expected) return fail(404, "not_found", "Bootstrap is not enabled");
		if (
			expected.length < MIN_BOOTSTRAP_TOKEN_LENGTH &&
			this.env.ARCASYNC_ALLOW_DEV_SECRET !== "1"
		) {
			return fail(503, "misconfigured", "ARCASYNC_BOOTSTRAP_TOKEN is too short");
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
		this.calls += 1;
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
		this.calls += 1;
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
		this.calls += 1;
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
		this.calls += 1;
		const inviteHash = await this.hashToken(req.token);
		const sessionToken = newOpaqueToken();
		const sessionHash = await this.hashToken(sessionToken);
		const color = await userColor(req.name);

		// Synchronous from here: the use count cannot be double-spent.
		const found = this.usableInvite(inviteHash);
		if (!found.ok) return found;
		const invite = found.value;
		if (invite.user_id !== null) return this.reenter(invite, req.device, sessionHash, sessionToken);
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

	/** A re-entry invite signs in as its user (the request's `name` is ignored); synchronous. */
	private reenter(
		invite: InviteRow,
		device: DeviceInfo,
		sessionHash: string,
		sessionToken: string,
	): Result<SessionResponse> {
		const user = invite.user_id === null ? undefined : this.userById(invite.user_id);
		if (!user) return fail(404, "not_found", "Unknown invite");
		if (user.disabled_at) return fail(403, "forbidden", "Account disabled");
		this.insertSession(user.id, this.deviceFor(user.id, device), sessionHash);
		this.sql.exec("UPDATE invites SET uses = uses + 1 WHERE id = ?", invite.id);
		this.audit(user.id, "user.reenter", user.id, { inviteId: invite.id });
		return ok({ sessionToken, user: toApiUser(user), workspaces: this.workspacesFor(user.id) });
	}

	/** Authenticated: an existing user joins another workspace; an existing role never drops. */
	async redeemInvite(
		token: string | null,
		inviteToken: string,
	): Promise<Result<WorkspacesResponse>> {
		this.calls += 1;
		const inviteHash = await this.hashToken(inviteToken);
		const s = await this.session(token);
		if (!s.ok) return s;
		const { user } = s.value;
		const found = this.usableInvite(inviteHash);
		if (!found.ok) return found;
		const invite = found.value;
		// Re-entry invites only sign their user in; they grant no workspace.
		if (invite.user_id !== null) return fail(404, "not_found", "Unknown invite");
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
		const workspaces = this.workspacesFor(user.id);
		if (current && current !== role) await this.revokeSockets(invite.workspace_id, user.id);
		return ok({ workspaces });
	}

	/** Admin only; the creator owns the new workspace. */
	async createWorkspace(token: string | null, name: string): Promise<Result<WorkspaceSummary>> {
		this.calls += 1;
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

	// --- P2 members, admin, audit ---

	async members(token: string | null, workspaceId: string): Promise<Result<MembersResponse>> {
		this.calls += 1;
		const s = await this.session(token);
		if (!s.ok) return s;
		const { user } = s.value;
		if (user.is_admin !== 1 && !this.roleIn(user.id, workspaceId)) {
			return fail(403, "forbidden", "Not a member of that workspace");
		}
		const members = this.sql
			.exec<{ id: string; name: string; color: string; role: string }>(
				`SELECT u.id, u.name, u.color, m.role FROM memberships m JOIN users u ON u.id = m.user_id
				 WHERE m.workspace_id = ? ORDER BY u.name`,
				workspaceId,
			)
			.toArray()
			.map((r) => ({ user: { id: r.id, name: r.name, color: r.color }, role: r.role as Role }));
		return ok({ members });
	}

	async setRole(
		token: string | null,
		workspaceId: string,
		userId: string,
		role: Role,
	): Promise<Result<{ ok: true }>> {
		this.calls += 1;
		const s = await this.session(token);
		if (!s.ok) return s;
		const { user } = s.value;
		if (!this.canManage(user, workspaceId)) return fail(403, "forbidden", "Owner or admin only");
		const current = this.roleIn(userId, workspaceId);
		if (!current) return fail(404, "not_found", "Not a member of that workspace");
		if (current === role) return ok({ ok: true });
		if (current === "owner" && this.isLastOwner(workspaceId, userId)) {
			return fail(409, "last_owner", "A workspace needs at least one owner");
		}
		this.sql.exec(
			"UPDATE memberships SET role = ? WHERE workspace_id = ? AND user_id = ?",
			role,
			workspaceId,
			userId,
		);
		this.audit(user.id, "member.role", userId, { workspaceId, role, previousRole: current });
		await this.revokeSockets(workspaceId, userId);
		return ok({ ok: true });
	}

	/** Owners and admins remove anyone; any member may remove themselves. */
	async removeMember(
		token: string | null,
		workspaceId: string,
		userId: string,
	): Promise<Result<{ ok: true }>> {
		this.calls += 1;
		const s = await this.session(token);
		if (!s.ok) return s;
		const { user } = s.value;
		if (user.id !== userId && !this.canManage(user, workspaceId)) {
			return fail(403, "forbidden", "Owner or admin only");
		}
		const current = this.roleIn(userId, workspaceId);
		if (!current) return fail(404, "not_found", "Not a member of that workspace");
		if (current === "owner" && this.isLastOwner(workspaceId, userId)) {
			return fail(409, "last_owner", "A workspace needs at least one owner");
		}
		this.sql.exec(
			"DELETE FROM memberships WHERE workspace_id = ? AND user_id = ?",
			workspaceId,
			userId,
		);
		this.audit(user.id, "member.remove", userId, { workspaceId, previousRole: current });
		await this.revokeSockets(workspaceId, userId);
		return ok({ ok: true });
	}

	/** Admin only: blocks sign-in, revokes every session and closes the user's sockets. */
	async disableUser(token: string | null, userId: string): Promise<Result<{ ok: true }>> {
		this.calls += 1;
		const s = await this.session(token);
		if (!s.ok) return s;
		const { user } = s.value;
		if (user.is_admin !== 1) return fail(403, "forbidden", "Admin only");
		if (userId === user.id)
			return fail(409, "cannot_disable_self", "Admins cannot disable themselves");
		const target = this.userById(userId);
		if (!target) return fail(404, "not_found", "Unknown user");
		const now = Date.now();
		this.sql.exec("UPDATE users SET disabled_at = ? WHERE id = ?", now, userId);
		this.sql.exec(
			"UPDATE sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL",
			now,
			userId,
		);
		this.audit(user.id, "user.disable", userId);
		const workspaceIds = this.sql
			.exec<{ workspace_id: string }>(
				"SELECT workspace_id FROM memberships WHERE user_id = ?",
				userId,
			)
			.toArray()
			.map((r) => r.workspace_id);
		for (const workspaceId of workspaceIds) await this.revokeSockets(workspaceId, userId);
		return ok({ ok: true });
	}

	/**
	 * Admin only. Sessions revoked by the disable stay revoked, so this returns a single-use
	 * re-entry invite bound to the user (no workspace, no membership change): accepting it signs
	 * that user in on a new session. A user who is not disabled gets 409 `not_disabled`.
	 */
	async enableUser(
		token: string | null,
		userId: string,
		publicUrl: string,
	): Promise<Result<InviteCreated>> {
		this.calls += 1;
		const inviteToken = newOpaqueToken();
		const inviteHash = await this.hashToken(inviteToken);
		const s = await this.session(token);
		if (!s.ok) return s;
		const { user } = s.value;
		if (user.is_admin !== 1) return fail(403, "forbidden", "Admin only");
		const target = this.userById(userId);
		if (!target) return fail(404, "not_found", "Unknown user");
		if (!target.disabled_at) return fail(409, "not_disabled", "That user is not disabled");
		this.sql.exec("UPDATE users SET disabled_at = NULL WHERE id = ?", userId);
		const expiresAt = Date.now() + REENTRY_INVITE_TTL_MS;
		const id = this.insertInvite(inviteHash, "", "viewer", false, 1, expiresAt, user.id, userId);
		this.audit(user.id, "user.enable", userId, { inviteId: id });
		return ok({
			id,
			token: inviteToken,
			url: inviteUrl(publicUrl, inviteToken),
			role: "viewer",
			admin: false,
			maxUses: 1,
			expiresAt,
		});
	}

	/** Admin only; newest first. `next` is the `before` cursor of the following page. */
	async auditLog(
		token: string | null,
		{ before, limit }: { before?: number; limit: number },
	): Promise<Result<AuditResponse>> {
		this.calls += 1;
		const s = await this.session(token);
		if (!s.ok) return s;
		if (s.value.user.is_admin !== 1) return fail(403, "forbidden", "Admin only");
		const rows = this.sql
			.exec<{
				id: number;
				at: number;
				actor_id: string | null;
				action: string;
				target: string;
				details: string;
			}>(
				"SELECT * FROM audit_log WHERE id < ? ORDER BY id DESC LIMIT ?",
				before ?? Number.MAX_SAFE_INTEGER,
				limit,
			)
			.toArray();
		const entries = rows.map((r) => ({
			id: r.id,
			at: r.at,
			actorId: r.actor_id,
			action: r.action,
			target: r.target,
			details: JSON.parse(r.details) as unknown,
		}));
		const last = entries[entries.length - 1];
		return ok({ entries, next: entries.length === limit && last ? last.id : null });
	}

	// --- P2 device-code sign-in (D2) ---

	private deviceCodeTtlS(): number {
		const override = Number(this.env.ARCASYNC_DEVICE_CODE_TTL_S);
		return Number.isInteger(override) && override > 0 ? override : DEVICE_CODE_TTL_S;
	}

	/** Unauthenticated: a new device asks for a code that a signed-in device approves. */
	async deviceStart(device: DeviceInfo): Promise<Result<DeviceCodeResponse>> {
		this.calls += 1;
		const deviceCode = newOpaqueToken();
		const codeHash = await this.hashToken(deviceCode);
		const now = Date.now();
		const ttl = this.deviceCodeTtlS();
		this.sql.exec("DELETE FROM device_codes WHERE expires_at <= ?", now);
		let userCode = newUserCode();
		while (this.sql.exec("SELECT 1 FROM device_codes WHERE user_code = ?", userCode).toArray()[0]) {
			userCode = newUserCode();
		}
		this.sql.exec(
			`INSERT INTO device_codes (id, code_hash, user_code, device, expires_at, created_at)
			 VALUES (?, ?, ?, ?, ?, ?)`,
			crypto.randomUUID(),
			codeHash,
			userCode,
			JSON.stringify(device),
			now + ttl * 1000,
			now,
		);
		return ok({
			deviceCode,
			userCode,
			verificationUri: `obsidian://teamsync?approve=${userCode}`,
			interval: DEVICE_CODE_INTERVAL_S,
			expiresIn: ttl,
		});
	}

	/**
	 * RFC 8628-style poll: 400 `authorization_pending` / `slow_down` / `access_denied` /
	 * `expired_token`, or the new device's session once approved (then the code is spent).
	 */
	async devicePoll(deviceCode: string): Promise<Result<SessionResponse>> {
		this.calls += 1;
		const codeHash = await this.hashToken(deviceCode);
		const sessionToken = newOpaqueToken();
		const sessionHash = await this.hashToken(sessionToken);
		const now = Date.now();
		const row = this.sql
			.exec<DeviceCodeRow>("SELECT * FROM device_codes WHERE code_hash = ?", codeHash)
			.toArray()[0];
		if (!row || row.status === "used" || row.expires_at <= now) {
			if (row) this.lastPoll.delete(row.id);
			return fail(400, "expired_token", "The device code expired; start again");
		}
		const last = this.lastPoll.get(row.id);
		if (last !== undefined && now - last < DEVICE_CODE_INTERVAL_S * 1000) {
			return fail(400, "slow_down", `Poll at most every ${DEVICE_CODE_INTERVAL_S} s`);
		}
		this.lastPoll.set(row.id, now);
		if (row.status === "denied") return fail(400, "access_denied", "The sign-in was denied");
		if (row.status !== "approved" || !row.user_id) {
			return fail(400, "authorization_pending", "Waiting for approval");
		}
		const user = this.userById(row.user_id);
		if (!user || user.disabled_at) return fail(400, "access_denied", "The sign-in was denied");
		const device = JSON.parse(row.device) as DeviceInfo;
		this.insertSession(user.id, this.deviceFor(user.id, device), sessionHash);
		this.sql.exec("UPDATE device_codes SET status = 'used' WHERE id = ?", row.id);
		this.lastPoll.delete(row.id);
		return ok({ sessionToken, user: toApiUser(user), workspaces: this.workspacesFor(user.id) });
	}

	/** A pending, unexpired code by its user code, or null. */
	private pendingCode(userCode: string): DeviceCodeRow | null {
		const code = normalizeUserCode(userCode);
		if (!code) return null;
		const row = this.sql
			.exec<DeviceCodeRow>("SELECT * FROM device_codes WHERE user_code = ?", code)
			.toArray()[0];
		return row && row.status === "pending" && row.expires_at > Date.now() ? row : null;
	}

	/** Shows the approver which device asks; ≤ 5 per minute per session. */
	async deviceLookup(
		token: string | null,
		userCode: string,
	): Promise<Result<DeviceLookupResponse>> {
		this.calls += 1;
		const s = await this.session(token);
		if (!s.ok) return s;
		const sessionId = s.value.row.session_id;
		const now = Date.now();
		const recent = (this.lookups.get(sessionId) ?? []).filter((t) => now - t < 60_000);
		if (recent.length >= DEVICE_LOOKUPS_PER_MINUTE) {
			this.lookups.set(sessionId, recent);
			return fail(429, "rate_limited", "Too many lookups; wait a minute");
		}
		recent.push(now);
		this.lookups.set(sessionId, recent);
		const row = this.pendingCode(userCode);
		if (!row) return fail(404, "not_found", "Unknown or expired code");
		const device = JSON.parse(row.device) as DeviceInfo;
		return ok({
			device: { name: device.name, platform: device.platform },
			expiresAt: row.expires_at,
		});
	}

	/** Approve (the device signs in as the caller) or deny a pending code. */
	async deviceApprove(
		token: string | null,
		userCode: string,
		approve: boolean,
	): Promise<Result<{ ok: true }>> {
		this.calls += 1;
		const s = await this.session(token);
		if (!s.ok) return s;
		const { user } = s.value;
		const row = this.pendingCode(userCode);
		if (!row) return fail(404, "not_found", "Unknown or expired code");
		this.sql.exec(
			"UPDATE device_codes SET status = ?, user_id = ? WHERE id = ?",
			approve ? "approved" : "denied",
			approve ? user.id : null,
			row.id,
		);
		const device = JSON.parse(row.device) as DeviceInfo;
		this.audit(user.id, approve ? "device.approve" : "device.deny", row.id, {
			device: { name: device.name, platform: device.platform },
		});
		return ok({ ok: true });
	}

	// --- dev-only (worker gates these on ARCASYNC_DEBUG_STATS) ---

	async debugAccounts(): Promise<{ calls: number }> {
		return { calls: this.calls };
	}

	async debugExpireInvite(id: string): Promise<{ ok: boolean }> {
		const changed = this.sql
			.exec("UPDATE invites SET expires_at = ? WHERE id = ? RETURNING id", Date.now() - 1, id)
			.toArray().length;
		return { ok: changed > 0 };
	}
}
