/**
 * Accounts, devices, sessions, workspaces and memberships for the whole deployment, in one
 * SQLite Durable Object (singleton by name). Mirrors the behaviour of the Node server's
 * `routes/auth.ts`, `routes/workspaces.ts` and `seed.ts`; responses use the shared zod shapes.
 */

import { DurableObject } from "cloudflare:workers";
import type {
	DeviceInfo,
	MeResponse,
	Role,
	SessionResponse,
	User,
	WorkspaceSummary,
} from "@teamsync/shared";
import { WS_TOKEN_TTL_SECONDS } from "@teamsync/shared";
import type { z } from "zod";
import type { Env } from "./env";
import { signWsToken } from "./jwt";

export const SESSION_TTL_SECONDS = 90 * 24 * 60 * 60;
const DEV_WORKSPACE_SLUG = "dev";

export interface ApiError {
	status: 400 | 401 | 403 | 404;
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

async function sha256(input: string): Promise<Uint8Array> {
	return new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input)));
}

function hex(data: Uint8Array): string {
	return [...data].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Same deterministic colour as the Node server (`sha256(name)[0] % palette`). */
async function userColor(seed: string): Promise<string> {
	const digest = await sha256(seed);
	return PALETTE[(digest[0] ?? 0) % PALETTE.length] ?? "#2f90d0";
}

function newOpaqueToken(): string {
	const raw = crypto.getRandomValues(new Uint8Array(32));
	return btoa(String.fromCharCode(...raw))
		.replace(/\+/g, "-")
		.replace(/\//g, "_")
		.replace(/=+$/, "");
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
		`);
	}

	private async hashToken(token: string): Promise<string> {
		return hex(await sha256(`${this.env.TEAMSYNC_SECRET}:${token}`));
	}

	private ensureDevWorkspace(): string {
		const existing = this.sql
			.exec<{ id: string }>("SELECT id FROM workspaces WHERE slug = ?", DEV_WORKSPACE_SLUG)
			.toArray()[0];
		if (existing) return existing.id;
		const id = crypto.randomUUID();
		this.sql.exec(
			"INSERT INTO workspaces (id, slug, name) VALUES (?, ?, ?)",
			id,
			DEV_WORKSPACE_SLUG,
			"Dev",
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

	/** `role` applies only when this creates the membership; existing memberships keep theirs. */
	async devLogin(name: string, device: DeviceInfo, role?: Role): Promise<Result<SessionResponse>> {
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

		const workspaceId = this.ensureDevWorkspace();
		const firstMember = this.sql
			.exec("SELECT user_id FROM memberships WHERE workspace_id = ? LIMIT 1", workspaceId)
			.toArray()[0];
		this.sql.exec(
			"INSERT INTO memberships (workspace_id, user_id, role) VALUES (?, ?, ?) ON CONFLICT DO NOTHING",
			workspaceId,
			user.id,
			role ?? (firstMember ? "editor" : "owner"),
		);

		let deviceRow = this.sql
			.exec<{ id: string }>(
				"SELECT id FROM devices WHERE user_id = ? AND vault_id = ?",
				user.id,
				device.vaultId,
			)
			.toArray()[0];
		if (!deviceRow) {
			deviceRow = { id: crypto.randomUUID() };
			this.sql.exec(
				"INSERT INTO devices (id, user_id, name, platform, vault_id) VALUES (?, ?, ?, ?, ?)",
				deviceRow.id,
				user.id,
				device.name,
				device.platform,
				device.vaultId,
			);
		}

		this.sql.exec(
			"INSERT INTO sessions (id, user_id, device_id, token_hash, expires_at) VALUES (?, ?, ?, ?, ?)",
			crypto.randomUUID(),
			user.id,
			deviceRow.id,
			tokenHash,
			Date.now() + SESSION_TTL_SECONDS * 1000,
		);

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
}
