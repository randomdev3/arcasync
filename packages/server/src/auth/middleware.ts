import type { Role } from "@teamsync/shared";
import { and, eq, isNull } from "drizzle-orm";
import { createMiddleware } from "hono/factory";
import type { Db } from "../db/index.js";
import { devices, memberships, sessions, users } from "../db/schema.js";
import { forbidden, unauthorized } from "../errors.js";
import type { AppEnv, Deps } from "../types.js";
import { hashToken } from "./tokens.js";

const TOUCH_INTERVAL_MS = 60_000;

export function bearerToken(header: string | undefined): string | null {
	if (!header) return null;
	const [scheme, value] = header.split(" ");
	if (!scheme || scheme.toLowerCase() !== "bearer" || !value) return null;
	return value.trim() || null;
}

/** Resolves the caller from `Authorization: Bearer <sessionToken>`. */
export function requireSession(deps: Deps) {
	return createMiddleware<AppEnv>(async (c, next) => {
		const token = bearerToken(c.req.header("authorization"));
		if (!token) throw unauthorized("Missing bearer token");

		const tokenHash = hashToken(token, deps.config.secret);
		const [row] = await deps.db
			.select({ session: sessions, user: users, device: devices })
			.from(sessions)
			.innerJoin(users, eq(users.id, sessions.userId))
			.innerJoin(devices, eq(devices.id, sessions.deviceId))
			.where(and(eq(sessions.tokenHash, tokenHash), isNull(sessions.revokedAt)))
			.limit(1);

		if (!row) throw unauthorized("Invalid session");
		if (row.session.expiresAt.getTime() <= Date.now()) throw unauthorized("Session expired");
		if (row.user.disabledAt) throw forbidden("Account disabled");

		if (Date.now() - row.session.lastSeenAt.getTime() > TOUCH_INTERVAL_MS) {
			const now = new Date();
			await deps.db
				.update(sessions)
				.set({ lastSeenAt: now })
				.where(eq(sessions.id, row.session.id));
			await deps.db.update(devices).set({ lastSeenAt: now }).where(eq(devices.id, row.device.id));
		}

		c.set("user", row.user);
		c.set("session", row.session);
		c.set("device", row.device);
		await next();
	});
}

const ROLE_RANK: Record<Role, number> = { viewer: 0, editor: 1, owner: 2 };

export function roleAtLeast(role: Role, min: Role): boolean {
	return ROLE_RANK[role] >= ROLE_RANK[min];
}

export async function getMembershipRole(
	db: Db,
	workspaceId: string,
	userId: string,
): Promise<Role | null> {
	const [row] = await db
		.select({ role: memberships.role })
		.from(memberships)
		.where(and(eq(memberships.workspaceId, workspaceId), eq(memberships.userId, userId)))
		.limit(1);
	return (row?.role as Role | undefined) ?? null;
}

/** Requires a membership of at least `min` in the `:id` (or `:workspaceId`) route param. */
export function requireWorkspaceRole(deps: Deps, min: Role) {
	return createMiddleware<AppEnv>(async (c, next) => {
		const user = c.get("user");
		if (!user) throw unauthorized();
		const workspaceId = c.req.param("workspaceId") ?? c.req.param("id");
		if (!workspaceId) throw forbidden("Missing workspace");
		const role = await getMembershipRole(deps.db, workspaceId, user.id);
		if (!role || (!user.isAdmin && !roleAtLeast(role, min))) throw forbidden("Insufficient role");
		await next();
	});
}
