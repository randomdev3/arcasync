import { DevLoginRequest, WS_TOKEN_TTL_SECONDS, WsTokenRequest } from "@teamsync/shared";
import { zValidator } from "@hono/zod-validator";
import { and, eq } from "drizzle-orm";
import { Hono } from "hono";
import {
	getMembershipRole,
	requireSession,
} from "../auth/middleware.js";
import {
	SESSION_TTL_SECONDS,
	hashToken,
	newOpaqueToken,
	signWsToken,
	userColor,
} from "../auth/tokens.js";
import { devices, memberships, sessions, users } from "../db/schema.js";
import type { UserRow } from "../db/schema.js";
import { badRequest, forbidden, notFound } from "../errors.js";
import { ensureDevWorkspace, ensureMembership } from "../seed.js";
import type { AppEnv, Deps } from "../types.js";
import { toApiUser, workspacesForUser } from "./mappers.js";

export function authRoutes(deps: Deps) {
	const app = new Hono<AppEnv>();

	/**
	 * P0 convenience login. Identity is the supplied name; only available when
	 * `TEAMSYNC_DEV_OPEN_LOGIN=1` (the default for a zero-config PGlite server).
	 */
	app.post("/auth/dev-login", zValidator("json", DevLoginRequest), async (c) => {
		if (!deps.config.devOpenLogin) throw forbidden("Dev login is disabled");
		const { name, device } = c.req.valid("json");

		let [user] = await deps.db.select().from(users).where(eq(users.name, name)).limit(1);
		if (!user) {
			[user] = await deps.db
				.insert(users)
				.values({ name, color: userColor(name) })
				.returning();
		}
		if (!user) throw badRequest("Could not create user");
		const resolved: UserRow = user;

		const workspaceId = await ensureDevWorkspace(deps.db);
		const [firstMember] = await deps.db
			.select({ userId: memberships.userId })
			.from(memberships)
			.where(eq(memberships.workspaceId, workspaceId))
			.limit(1);
		await ensureMembership(deps.db, workspaceId, resolved.id, firstMember ? "editor" : "owner");

		let [deviceRow] = await deps.db
			.select()
			.from(devices)
			.where(and(eq(devices.userId, resolved.id), eq(devices.vaultId, device.vaultId)))
			.limit(1);
		if (!deviceRow) {
			[deviceRow] = await deps.db
				.insert(devices)
				.values({
					userId: resolved.id,
					name: device.name,
					platform: device.platform,
					vaultId: device.vaultId,
				})
				.returning();
		}
		if (!deviceRow) throw badRequest("Could not register device");

		const sessionToken = newOpaqueToken();
		await deps.db.insert(sessions).values({
			userId: resolved.id,
			deviceId: deviceRow.id,
			tokenHash: hashToken(sessionToken, deps.config.secret),
			expiresAt: new Date(Date.now() + SESSION_TTL_SECONDS * 1000),
		});

		return c.json({
			sessionToken,
			user: toApiUser(resolved),
			workspaces: await workspacesForUser(deps.db, resolved.id),
		});
	});

	app.use("/auth/me", requireSession(deps));
	app.get("/auth/me", async (c) => {
		const user = c.get("user");
		const device = c.get("device");
		return c.json({
			user: toApiUser(user),
			device: { id: device.id, name: device.name, platform: device.platform },
			workspaces: await workspacesForUser(deps.db, user.id),
		});
	});

	app.use("/auth/ws-token", requireSession(deps));
	app.post("/auth/ws-token", zValidator("json", WsTokenRequest), async (c) => {
		const user = c.get("user");
		const device = c.get("device");
		const { workspaceId } = c.req.valid("json");
		const role = await getMembershipRole(deps.db, workspaceId, user.id);
		if (!role) throw notFound("No membership in that workspace");
		const { token, expiresAt } = await signWsToken(
			{ userId: user.id, workspaceId, role, deviceId: device.id },
			deps.config.secret,
			WS_TOKEN_TTL_SECONDS,
		);
		return c.json({ token, expiresAt });
	});

	app.use("/auth/logout", requireSession(deps));
	app.post("/auth/logout", async (c) => {
		const session = c.get("session");
		await deps.db
			.update(sessions)
			.set({ revokedAt: new Date() })
			.where(eq(sessions.id, session.id));
		return c.json({ ok: true });
	});

	return app;
}
