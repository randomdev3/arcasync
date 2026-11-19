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
	LoginRequest,
	MembersResponse,
	MeResponse,
	PinAcceptRequest,
	PinCreateRequest,
	PinSummary,
	PinsResponse,
	Role,
	SessionResponse,
	User,
	WorkspaceSummary,
	WorkspacesResponse,
} from "@arcasync/shared";
import {
	DEVICE_CODE_INTERVAL_S,
	DEVICE_CODE_TTL_S,
	passwordProblem,
	WS_TOKEN_TTL_SECONDS,
} from "@arcasync/shared";
import type { z } from "zod";
import {
	type Limit,
	LOGIN_FAILURE_ROWS_MAX,
	LOGIN_IP_LIMIT,
	LOGIN_NAME_LIMIT,
	nameKey,
	PIN_GLOBAL_LIMIT,
	PIN_IP_LIMIT,
	PIN_LOCK_MS,
	retryAfter,
} from "./accounts/limits";
import { dummyVerify, hashPassword, type PasswordHash, verifyPassword } from "./accounts/passwords";
import { newPin } from "./accounts/pins";
import { migratePinsAndPasswords } from "./accounts/schema";
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
/** At most this many usable PINs server-wide. */
const PIN_MAX_ACTIVE = 10;
/** Used, revoked and expired PINs stay listed this long, then are deleted. */
const PIN_KEEP_MS = 7 * 24 * 60 * 60 * 1000;
const PINS_LOCKED_UNTIL = "pins_locked_until";

export interface ApiError {
	status: 400 | 401 | 403 | 404 | 409 | 410 | 411 | 413 | 423 | 429 | 503;
	code: string;
	message: string;
	/** Seconds; the Worker sends it as `Retry-After` (429, 423). */
	retryAfter?: number;
}
export type Result<T> = { ok: true; value: T } | { ok: false; error: ApiError };

const ok = <T>(value: T): Result<T> => ({ ok: true, value });
const fail = (
	status: ApiError["status"],
	code: string,
	message: string,
	retryAfter?: number,
): Result<never> => ({
	ok: false,
	error: { status, code, message, ...(retryAfter === undefined ? {} : { retryAfter }) },
});

const invalidPin = () => fail(404, "invalid_pin", "Wrong or expired PIN");
const invalidCredentials = () => fail(401, "invalid_credentials", "Wrong name or password");

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

/**
 * Where links point. `site` is the website (`ARCASYNC_PUBLIC_URL`, hosted on Cloudflare Pages),
 * `relay` this relay's own origin. Without a site, links fall back to the plugin's deep links.
 */
export interface LinkBase {
	site: string | null;
	relay: string;
}

/**
 * The website's join page (it offers "create your account here" and "open in Obsidian"), or,
 * without a site, the `obsidian://arcasync?server=…&invite=…` link the plugin's protocol handler
 * turns into a prefilled join. The plugin accepts both pasted into its settings.
 */
export function inviteUrl(links: LinkBase, token: string): string {
	if (links.site) return `${trimSlashes(links.site)}/join?invite=${token}`;
	return `obsidian://arcasync?server=${encodeURIComponent(links.relay)}&invite=${token}`;
}

/** A device code's `verificationUri`: the website's approve page, or the plugin's deep link. */
export function approveUrl(links: LinkBase, userCode: string): string {
	if (links.site) return `${trimSlashes(links.site)}/approve?code=${userCode}`;
	return `obsidian://arcasync?approve=${userCode}`;
}

function trimSlashes(url: string): string {
	return url.replace(/\/+$/, "");
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

interface PinRow extends Record<string, SqlStorageValue> {
	id: string;
	pin: string;
	workspace_id: string;
	role: string;
	admin: number;
	expires_at: number;
	created_by: string;
	created_at: number;
	used_at: number | null;
	used_by: string | null;
	revoked_at: number | null;
}

interface PasswordRow extends Record<string, SqlStorageValue> {
	hash: string;
	salt: string;
	iterations: number;
	rounds: number;
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
		migratePinsAndPasswords(this.sql);
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
	 * The user a sign-in name means: the exact name, else the one user whose name matches it
	 * case-insensitively (`nameKey`; SQLite's NOCASE is ASCII-only, so this scans the few users).
	 * Two users differing only in case (possible before names were checked case-insensitively)
	 * match only by their exact names.
	 */
	private userBySignInName(name: string): UserRow | undefined {
		const key = nameKey(name);
		const matches = this.sql
			.exec<UserRow>("SELECT * FROM users")
			.toArray()
			.filter((u) => nameKey(u.name) === key);
		return matches.find((u) => u.name === name) ?? (matches.length === 1 ? matches[0] : undefined);
	}

	/** A new account's name is taken if any user has it up to case. */
	private nameTaken(name: string): boolean {
		const key = nameKey(name);
		return this.sql
			.exec<{ name: string }>("SELECT name FROM users")
			.toArray()
			.some((u) => nameKey(u.name) === key);
	}

	private passwordOf(userId: string): PasswordRow | undefined {
		return this.sql
			.exec<PasswordRow>(
				"SELECT hash, salt, iterations, rounds FROM user_passwords WHERE user_id = ?",
				userId,
			)
			.toArray()[0];
	}

	private setPasswordRow(userId: string, hash: PasswordHash): void {
		this.sql.exec(
			`INSERT INTO user_passwords (user_id, hash, salt, iterations, rounds, updated_at)
			 VALUES (?, ?, ?, ?, ?, ?)
			 ON CONFLICT (user_id) DO UPDATE SET hash = excluded.hash, salt = excluded.salt,
			 iterations = excluded.iterations, rounds = excluded.rounds, updated_at = excluded.updated_at`,
			userId,
			hash.hash,
			hash.salt,
			hash.iterations,
			hash.rounds,
			Date.now(),
		);
	}

	/** Limit buckets store a peppered hash of the client IP, never the address. */
	private async ipKey(ip: string): Promise<string> {
		return (await hashSecret(this.env.ARCASYNC_SECRET, `ip:${ip}`)).slice(0, 32);
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
			hasPassword: this.passwordOf(user.id) !== undefined,
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
		links: LinkBase,
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
				url: inviteUrl(links, inviteToken),
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
		links: LinkBase,
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
			url: inviteUrl(links, inviteToken),
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
		if (this.nameTaken(req.name)) return fail(409, "name_taken", "That name is taken");
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

	/**
	 * A re-entry invite signs in as its user (the request's `name` is ignored); synchronous. It
	 * also clears the user's password, so a locked-out user sets a new one without the old.
	 */
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
		const passwordCleared =
			this.sql
				.exec("DELETE FROM user_passwords WHERE user_id = ? RETURNING user_id", user.id)
				.toArray().length > 0;
		this.audit(user.id, "user.reenter", user.id, { inviteId: invite.id, passwordCleared });
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
		links: LinkBase,
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
			url: inviteUrl(links, inviteToken),
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

	// --- PIN invites ---

	/** Lock end (ms) while PIN entry is locked server-wide, else null. */
	private pinsLockedUntil(now: number): number | null {
		const row = this.sql
			.exec<{ value: string }>("SELECT value FROM server_settings WHERE key = ?", PINS_LOCKED_UNTIL)
			.toArray()[0];
		const until = row ? Number(row.value) : 0;
		return until > now ? until : null;
	}

	/**
	 * Before any PIN is looked up: 423 while locked, 429 when this IP already has
	 * `PIN_IP_LIMIT.max` wrong PINs in the window. Shared by accept and redeem.
	 */
	private pinGate(ip: string, now: number): Result<null> {
		const until = this.pinsLockedUntil(now);
		if (until !== null) {
			return fail(
				423,
				"pins_locked",
				"PIN entry is locked after too many wrong PINs; ask an admin",
				Math.ceil((until - now) / 1000),
			);
		}
		const times = this.sql
			.exec<{ at: number }>(
				"SELECT at FROM pin_failures WHERE ip = ? AND at > ?",
				ip,
				now - PIN_IP_LIMIT.windowMs,
			)
			.toArray()
			.map((r) => r.at);
		const wait = retryAfter(times, now, PIN_IP_LIMIT);
		if (wait !== null)
			return fail(429, "rate_limited", "Too many wrong PINs; try again later", wait);
		return ok(null);
	}

	/** A wrong PIN: counted per IP, and server-wide toward the lock (audited when it trips). */
	private recordPinFailure(ip: string, now: number): void {
		this.sql.exec("DELETE FROM pin_failures WHERE at <= ?", now - PIN_GLOBAL_LIMIT.windowMs);
		this.sql.exec("INSERT INTO pin_failures (at, ip) VALUES (?, ?)", now, ip);
		const count = (where: string, ...args: SqlStorageValue[]) =>
			this.sql
				.exec<{ n: number }>(`SELECT COUNT(*) AS n FROM pin_failures WHERE ${where}`, ...args)
				.one().n;
		const forIp = count("ip = ? AND at > ?", ip, now - PIN_IP_LIMIT.windowMs);
		if (forIp === PIN_IP_LIMIT.max) this.audit(null, "pin.limited", "ip", { failures: forIp });
		const total = count("at > ?", now - PIN_GLOBAL_LIMIT.windowMs);
		if (total >= PIN_GLOBAL_LIMIT.max) {
			const until = now + PIN_LOCK_MS;
			this.sql.exec(
				`INSERT INTO server_settings (key, value) VALUES (?, ?)
				 ON CONFLICT (key) DO UPDATE SET value = excluded.value`,
				PINS_LOCKED_UNTIL,
				String(until),
			);
			// The lock now governs; a fresh window starts when it ends.
			this.sql.exec("DELETE FROM pin_failures");
			this.audit(null, "pin.lock", "pins", { failures: total, until });
		}
	}

	/** The usable PIN with these digits (unused, unrevoked, unexpired, workspace alive). */
	private activePin(pin: string, now: number): PinRow | undefined {
		return this.sql
			.exec<PinRow>(
				`SELECT p.* FROM invite_pins p JOIN workspaces w ON w.id = p.workspace_id
				 WHERE p.pin = ? AND p.used_at IS NULL AND p.revoked_at IS NULL AND p.expires_at > ?
				 AND w.deleted_at IS NULL`,
				pin,
				now,
			)
			.toArray()[0];
	}

	private toPinSummary(row: PinRow & { used_by_name?: string | null }): PinSummary {
		return {
			id: row.id,
			pin: row.pin,
			workspaceId: row.workspace_id,
			role: row.role as Role,
			admin: row.admin === 1,
			createdAt: row.created_at,
			createdBy: row.created_by,
			expiresAt: row.expires_at,
			usedAt: row.used_at,
			usedBy: row.used_by_name ?? null,
			revoked: row.revoked_at !== null,
		};
	}

	/** Owner or admin; `admin` PINs only for server admins. At most 10 usable server-wide. */
	async createPin(
		token: string | null,
		workspaceId: string,
		req: PinCreateRequest,
	): Promise<Result<PinSummary>> {
		this.calls += 1;
		const s = await this.session(token);
		if (!s.ok) return s;
		const { user } = s.value;
		if (!this.canManage(user, workspaceId)) return fail(403, "forbidden", "Owner or admin only");
		if (req.admin && user.is_admin !== 1) {
			return fail(403, "forbidden", "Only server admins create admin PINs");
		}
		const now = Date.now();
		const keepSince = now - PIN_KEEP_MS;
		this.sql.exec(
			"DELETE FROM invite_pins WHERE expires_at < ? OR used_at < ? OR revoked_at < ?",
			keepSince,
			keepSince,
			keepSince,
		);
		const active = this.sql
			.exec<{ n: number }>(
				`SELECT COUNT(*) AS n FROM invite_pins
				 WHERE used_at IS NULL AND revoked_at IS NULL AND expires_at > ?`,
				now,
			)
			.one().n;
		if (active >= PIN_MAX_ACTIVE) {
			return fail(409, "too_many_pins", `At most ${PIN_MAX_ACTIVE} PINs can be open at once`);
		}
		const pin = newPin((candidate) => this.activePin(candidate, now) !== undefined);
		if (!pin) return fail(409, "too_many_pins", "No free PIN; revoke one first");
		const row: PinRow = {
			id: crypto.randomUUID(),
			pin,
			workspace_id: workspaceId,
			role: req.role,
			admin: req.admin ? 1 : 0,
			expires_at: now + req.expiresInSec * 1000,
			created_by: user.id,
			created_at: now,
			used_at: null,
			used_by: null,
			revoked_at: null,
		};
		this.sql.exec(
			`INSERT INTO invite_pins (id, pin, workspace_id, role, admin, expires_at, created_by,
			 created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
			row.id,
			row.pin,
			row.workspace_id,
			row.role,
			row.admin,
			row.expires_at,
			row.created_by,
			row.created_at,
		);
		// Never the digits: the audit log outlives the PIN.
		this.audit(user.id, "pin.create", row.id, {
			workspaceId,
			role: req.role,
			admin: req.admin,
			expiresAt: row.expires_at,
		});
		return ok(this.toPinSummary(row));
	}

	/** The workspace's PINs, newest first, with the server-wide lock state. */
	async listPins(token: string | null, workspaceId: string): Promise<Result<PinsResponse>> {
		this.calls += 1;
		const s = await this.session(token);
		if (!s.ok) return s;
		if (!this.canManage(s.value.user, workspaceId)) {
			return fail(403, "forbidden", "Owner or admin only");
		}
		const pins = this.sql
			.exec<PinRow & { used_by_name: string | null }>(
				`SELECT p.*, u.name AS used_by_name FROM invite_pins p LEFT JOIN users u ON u.id = p.used_by
				 WHERE p.workspace_id = ? ORDER BY p.created_at DESC`,
				workspaceId,
			)
			.toArray()
			.map((r) => this.toPinSummary(r));
		const lockedUntil = this.pinsLockedUntil(Date.now());
		return ok({ pins, locked: lockedUntil !== null, lockedUntil });
	}

	async revokePin(
		token: string | null,
		workspaceId: string,
		pinId: string,
	): Promise<Result<{ ok: true }>> {
		this.calls += 1;
		const s = await this.session(token);
		if (!s.ok) return s;
		const { user } = s.value;
		if (!this.canManage(user, workspaceId)) return fail(403, "forbidden", "Owner or admin only");
		const row = this.sql
			.exec<PinRow>(
				"SELECT * FROM invite_pins WHERE id = ? AND workspace_id = ?",
				pinId,
				workspaceId,
			)
			.toArray()[0];
		if (!row) return fail(404, "not_found", "Unknown PIN");
		if (row.revoked_at === null && row.used_at === null) {
			this.sql.exec("UPDATE invite_pins SET revoked_at = ? WHERE id = ?", Date.now(), pinId);
			this.audit(user.id, "pin.revoke", pinId, { workspaceId });
		}
		return ok({ ok: true });
	}

	/** Admin only: lifts the server-wide PIN lock and forgets the counted failures. */
	async unlockPins(token: string | null): Promise<Result<{ ok: true }>> {
		this.calls += 1;
		const s = await this.session(token);
		if (!s.ok) return s;
		const { user } = s.value;
		if (user.is_admin !== 1) return fail(403, "forbidden", "Admin only");
		const wasLocked = this.pinsLockedUntil(Date.now()) !== null;
		this.sql.exec("DELETE FROM server_settings WHERE key = ?", PINS_LOCKED_UNTIL);
		this.sql.exec("DELETE FROM pin_failures");
		this.audit(user.id, "pin.unlock", "pins", { wasLocked });
		return ok({ ok: true });
	}

	/**
	 * Unauthenticated: a new user joins with a PIN and sets a password. The body's shape and the
	 * password rules are checked before the PIN, so a 400 says nothing about it; every wrong,
	 * used, revoked or expired PIN is the same 404 `invalid_pin`.
	 */
	async acceptPin(req: PinAcceptRequest, clientIp: string): Promise<Result<SessionResponse>> {
		this.calls += 1;
		const problem = passwordProblem(req.password);
		if (problem) return fail(400, "weak_password", problem);
		const ip = await this.ipKey(clientIp);
		const sessionToken = newOpaqueToken();
		const sessionHash = await this.hashToken(sessionToken);
		const color = await userColor(req.name);

		// Synchronous: lock, IP limit and PIN lookup (a wrong PIN never costs a hash).
		const now = Date.now();
		const gate = this.pinGate(ip, now);
		if (!gate.ok) return gate;
		const found = this.activePin(req.pin, now);
		if (!found) {
			this.recordPinFailure(ip, now);
			return invalidPin();
		}
		if (this.nameTaken(req.name)) return fail(409, "name_taken", "That name is taken");

		const password = await hashPassword(this.env.ARCASYNC_SECRET, req.password);

		// Synchronous again: other requests ran during the hash, so check the PIN and name anew.
		const pin = this.activePin(req.pin, Date.now());
		if (!pin || pin.id !== found.id) return invalidPin();
		if (this.nameTaken(req.name)) return fail(409, "name_taken", "That name is taken");
		const userId = crypto.randomUUID();
		this.sql.exec(
			"INSERT INTO users (id, name, color, is_admin) VALUES (?, ?, ?, ?)",
			userId,
			req.name,
			color,
			pin.admin,
		);
		this.sql.exec(
			"INSERT INTO memberships (workspace_id, user_id, role) VALUES (?, ?, ?)",
			pin.workspace_id,
			userId,
			pin.role,
		);
		this.setPasswordRow(userId, password);
		this.insertSession(userId, this.deviceFor(userId, req.device), sessionHash);
		this.sql.exec(
			"UPDATE invite_pins SET used_at = ?, used_by = ? WHERE id = ?",
			Date.now(),
			userId,
			pin.id,
		);
		this.audit(userId, "pin.accept", pin.id, {
			workspaceId: pin.workspace_id,
			role: pin.role,
			admin: pin.admin === 1,
		});
		const user = this.userById(userId);
		if (!user) return fail(400, "bad_request", "Could not create user");
		return ok({ sessionToken, user: toApiUser(user), workspaces: this.workspacesFor(userId) });
	}

	/** Authenticated: joins the PIN's workspace (a role never drops); same limits as accept. */
	async redeemPin(
		token: string | null,
		pinDigits: string,
		clientIp: string,
	): Promise<Result<WorkspacesResponse>> {
		this.calls += 1;
		const ip = await this.ipKey(clientIp);
		const s = await this.session(token);
		if (!s.ok) return s;
		const { user } = s.value;
		const now = Date.now();
		const gate = this.pinGate(ip, now);
		if (!gate.ok) return gate;
		const pin = this.activePin(pinDigits, now);
		if (!pin) {
			this.recordPinFailure(ip, now);
			return invalidPin();
		}
		const offered = pin.role as Role;
		const current = this.roleIn(user.id, pin.workspace_id);
		const role = current && ROLE_RANK[current] >= ROLE_RANK[offered] ? current : offered;
		this.sql.exec(
			`INSERT INTO memberships (workspace_id, user_id, role) VALUES (?, ?, ?)
			 ON CONFLICT (workspace_id, user_id) DO UPDATE SET role = excluded.role`,
			pin.workspace_id,
			user.id,
			role,
		);
		if (pin.admin === 1) this.sql.exec("UPDATE users SET is_admin = 1 WHERE id = ?", user.id);
		this.sql.exec(
			"UPDATE invite_pins SET used_at = ?, used_by = ? WHERE id = ?",
			now,
			user.id,
			pin.id,
		);
		this.audit(user.id, "pin.redeem", pin.id, {
			workspaceId: pin.workspace_id,
			role,
			previousRole: current ?? null,
			admin: pin.admin === 1,
		});
		const workspaces = this.workspacesFor(user.id);
		if (current && current !== role) await this.revokeSockets(pin.workspace_id, user.id);
		return ok({ workspaces });
	}

	// --- passwords ---

	/**
	 * Sign-in limits before any hash: 429 while the name or the IP has its maximum of failures in
	 * the window. Old rows are pruned and the table is capped here.
	 */
	private loginGate(key: string, ip: string, now: number): Result<null> {
		const since = now - LOGIN_NAME_LIMIT.windowMs;
		this.sql.exec("DELETE FROM login_failures WHERE at <= ?", since);
		this.sql.exec(
			"DELETE FROM login_failures WHERE id <= (SELECT MAX(id) FROM login_failures) - ?",
			LOGIN_FAILURE_ROWS_MAX,
		);
		const times = (column: "name_key" | "ip", value: string) =>
			this.sql
				.exec<{ at: number }>(
					`SELECT at FROM login_failures WHERE ${column} = ? AND at > ?`,
					value,
					since,
				)
				.toArray()
				.map((r) => r.at);
		const waits = [
			retryAfter(times("name_key", key), now, LOGIN_NAME_LIMIT),
			retryAfter(times("ip", ip), now, LOGIN_IP_LIMIT),
		].filter((w): w is number => w !== null);
		if (waits.length > 0) {
			return fail(
				429,
				"rate_limited",
				"Too many failed sign-ins; try again later",
				Math.max(...waits),
			);
		}
		return ok(null);
	}

	/**
	 * Counts an attempt before its (slow, async) hash, so parallel guesses all see each other.
	 * A successful attempt deletes its own row only.
	 */
	private recordLoginAttempt(key: string, ip: string, now: number): number {
		return this.sql
			.exec<{ id: number }>(
				"INSERT INTO login_failures (at, name_key, ip) VALUES (?, ?, ?) RETURNING id",
				now,
				key,
				ip,
			)
			.one().id;
	}

	/** Failures are audited in aggregate: one row when a name or IP reaches its limit. */
	private auditLoginFailure(key: string, ip: string, now: number, actorId: string | null): void {
		const count = (column: "name_key" | "ip", value: string, limit: Limit) =>
			this.sql
				.exec<{ n: number }>(
					`SELECT COUNT(*) AS n FROM login_failures WHERE ${column} = ? AND at > ?`,
					value,
					now - limit.windowMs,
				)
				.one().n;
		const byName = count("name_key", key, LOGIN_NAME_LIMIT);
		if (byName === LOGIN_NAME_LIMIT.max) {
			this.audit(actorId, "auth.login.limited", key, { scope: "name", failures: byName });
		}
		const byIp = count("ip", ip, LOGIN_IP_LIMIT);
		if (byIp === LOGIN_IP_LIMIT.max) {
			this.audit(actorId, "auth.login.limited", "ip", { scope: "ip", failures: byIp });
		}
	}

	/**
	 * Unauthenticated name + password sign-in. Unknown name, no password, wrong password and a
	 * disabled account are all 401 `invalid_credentials`, after the same hashing work.
	 */
	async login(req: LoginRequest, clientIp: string): Promise<Result<SessionResponse>> {
		this.calls += 1;
		const key = nameKey(req.name);
		const ip = await this.ipKey(clientIp);
		const sessionToken = newOpaqueToken();
		const sessionHash = await this.hashToken(sessionToken);

		const now = Date.now();
		const gate = this.loginGate(key, ip, now);
		if (!gate.ok) return gate;
		const attempt = this.recordLoginAttempt(key, ip, now);
		const found = this.userBySignInName(req.name);
		const stored = found ? this.passwordOf(found.id) : undefined;
		const pepper = this.env.ARCASYNC_SECRET;
		const good = stored
			? await verifyPassword(pepper, req.password, stored)
			: await dummyVerify(pepper, req.password);

		// Re-read after the hash: the account may have been disabled or its password changed.
		const user = found ? this.userById(found.id) : undefined;
		const current = user ? this.passwordOf(user.id) : undefined;
		if (!good || !user || user.disabled_at || !current || current.hash !== stored?.hash) {
			this.auditLoginFailure(key, ip, Date.now(), null);
			return invalidCredentials();
		}
		this.sql.exec("DELETE FROM login_failures WHERE id = ?", attempt);
		this.insertSession(user.id, this.deviceFor(user.id, req.device), sessionHash);
		this.audit(user.id, "user.login", user.id, {
			device: { name: req.device.name, platform: req.device.platform },
		});
		return ok({ sessionToken, user: toApiUser(user), workspaces: this.workspacesFor(user.id) });
	}

	/**
	 * Sets a password (none yet) or changes it (`current` must match; a wrong one is 403
	 * `invalid_credentials`, not 401, which clients read as a dead session). Revokes the user's
	 * other sessions. Wrong `current` values count toward the name's sign-in limit.
	 */
	async changePassword(
		token: string | null,
		current: string | undefined,
		next: string,
		clientIp: string,
	): Promise<Result<{ ok: true; userId: string }>> {
		this.calls += 1;
		const ip = await this.ipKey(clientIp);
		const s = await this.session(token);
		if (!s.ok) return s;
		const { user, row } = s.value;
		const problem = passwordProblem(next);
		if (problem) return fail(400, "weak_password", problem);
		const pepper = this.env.ARCASYNC_SECRET;
		const stored = this.passwordOf(user.id);
		if (stored) {
			const key = nameKey(user.name);
			const now = Date.now();
			const gate = this.loginGate(key, ip, now);
			if (!gate.ok) return gate;
			if (current === undefined) {
				return fail(403, "invalid_credentials", "Enter your current password");
			}
			const attempt = this.recordLoginAttempt(key, ip, now);
			if (!(await verifyPassword(pepper, current, stored))) {
				this.auditLoginFailure(key, ip, Date.now(), user.id);
				return fail(403, "invalid_credentials", "Wrong current password");
			}
			this.sql.exec("DELETE FROM login_failures WHERE id = ?", attempt);
		}
		const hash = await hashPassword(pepper, next);

		// Re-check after the hashes: a concurrent change must not be silently overwritten.
		const fresh = this.userById(user.id);
		if (!fresh || fresh.disabled_at) return fail(403, "forbidden", "Account disabled");
		if (this.passwordOf(user.id)?.hash !== stored?.hash) {
			return fail(409, "conflict", "The password changed meanwhile; try again");
		}
		this.setPasswordRow(user.id, hash);
		const revoked = this.sql
			.exec(
				`UPDATE sessions SET revoked_at = ? WHERE user_id = ? AND id != ? AND revoked_at IS NULL
				 RETURNING id`,
				Date.now(),
				user.id,
				row.session_id,
			)
			.toArray().length;
		this.audit(user.id, stored ? "user.password.change" : "user.password.set", user.id, {
			revokedSessions: revoked,
		});
		return ok({ ok: true, userId: user.id });
	}

	// --- P2 device-code sign-in (D2) ---

	private deviceCodeTtlS(): number {
		const override = Number(this.env.ARCASYNC_DEVICE_CODE_TTL_S);
		return Number.isInteger(override) && override > 0 ? override : DEVICE_CODE_TTL_S;
	}

	/** Unauthenticated: a new device asks for a code that a signed-in device approves. */
	async deviceStart(device: DeviceInfo, links: LinkBase): Promise<Result<DeviceCodeResponse>> {
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
			verificationUri: approveUrl(links, userCode),
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

	/** Moves every limit row and the PIN lock `ms` into the past, as if that much time passed. */
	async debugAgeLimits(ms: number): Promise<{ ok: true }> {
		this.sql.exec("UPDATE pin_failures SET at = at - ?", ms);
		this.sql.exec("UPDATE login_failures SET at = at - ?", ms);
		this.sql.exec(
			"UPDATE server_settings SET value = CAST(CAST(value AS INTEGER) - ? AS TEXT) WHERE key = ?",
			ms,
			PINS_LOCKED_UNTIL,
		);
		return { ok: true };
	}

	async debugExpirePin(id: string): Promise<{ ok: boolean }> {
		const changed = this.sql
			.exec("UPDATE invite_pins SET expires_at = ? WHERE id = ? RETURNING id", Date.now() - 1, id)
			.toArray().length;
		return { ok: changed > 0 };
	}

	/** Dev measurement: `n` password hashes inside this object (time it from the caller). */
	async debugHashTiming(n: number): Promise<{ n: number }> {
		for (let i = 0; i < n; i++) {
			await hashPassword(this.env.ARCASYNC_SECRET, "correct horse battery staple");
		}
		return { n };
	}

	async debugExpireInvite(id: string): Promise<{ ok: boolean }> {
		const changed = this.sql
			.exec("UPDATE invites SET expires_at = ? WHERE id = ? RETURNING id", Date.now() - 1, id)
			.toArray().length;
		return { ok: changed > 0 };
	}
}
