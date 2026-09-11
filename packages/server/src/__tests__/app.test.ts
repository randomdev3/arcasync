import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MeResponse, ServerInfo, SessionResponse, WsTokenResponse } from "@teamsync/shared";
import type { Hono } from "hono";
import { createApp } from "../app.js";
import { verifyWsToken } from "../auth/tokens.js";
import type { DbHandle } from "../db/index.js";
import { ensureDevWorkspace } from "../seed.js";
import type { AppEnv, Deps } from "../types.js";
import { createTestDeps } from "./helpers.js";

let deps: Deps;
let handle: DbHandle;
let app: Hono<AppEnv>;

const device = { name: "test-mac", platform: "macos" as const, vaultId: "vault-a" };

beforeAll(async () => {
	({ deps, handle } = await createTestDeps());
	await ensureDevWorkspace(deps.db);
	app = createApp(deps);
});

afterAll(async () => {
	await handle.close();
});

function post(path: string, body: unknown, token?: string) {
	return app.request(path, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			...(token ? { Authorization: `Bearer ${token}` } : {}),
		},
		body: JSON.stringify(body),
	});
}

describe("ops routes", () => {
	it("reports health", async () => {
		const res = await app.request("/api/health");
		expect(res.status).toBe(200);
		expect(await res.json()).toMatchObject({ ok: true });
	});

	it("reports readiness once db and blob store answer", async () => {
		const res = await app.request("/api/ready");
		expect(res.status).toBe(200);
		expect(await res.json()).toMatchObject({ ok: true, checks: { db: true, blobs: true } });
	});

	it("advertises dev open login in server-info", async () => {
		const res = await app.request("/api/server-info");
		expect(res.status).toBe(200);
		const info = ServerInfo.parse(await res.json());
		expect(info.features.devOpenLogin).toBe(true);
	});

	it("404s unknown routes with the api error shape", async () => {
		const res = await app.request("/api/nope");
		expect(res.status).toBe(404);
		expect(await res.json()).toMatchObject({ error: { code: "not_found" } });
	});
});

describe("dev-login -> me -> ws-token", () => {
	it("issues a session, resolves it, and mints a workspace JWT", async () => {
		const loginRes = await post("/api/auth/dev-login", { name: "alice", device });
		expect(loginRes.status).toBe(200);
		const session = SessionResponse.parse(await loginRes.json());
		expect(session.user.name).toBe("alice");
		expect(session.workspaces).toHaveLength(1);
		const workspace = session.workspaces[0];
		if (!workspace) throw new Error("expected a workspace");
		expect(workspace.slug).toBe("dev");
		expect(workspace.role).toBe("owner");

		const meRes = await app.request("/api/auth/me", {
			headers: { Authorization: `Bearer ${session.sessionToken}` },
		});
		expect(meRes.status).toBe(200);
		const me = MeResponse.parse(await meRes.json());
		expect(me.user.id).toBe(session.user.id);
		expect(me.device.name).toBe(device.name);

		const wsRes = await post(
			"/api/auth/ws-token",
			{ workspaceId: workspace.id },
			session.sessionToken,
		);
		expect(wsRes.status).toBe(200);
		const wsToken = WsTokenResponse.parse(await wsRes.json());
		const claims = await verifyWsToken(wsToken.token, deps.config.secret);
		expect(claims.sub).toBe(session.user.id);
		expect(claims.ws).toBe(workspace.id);
		expect(claims.role).toBe("owner");
		expect(wsToken.expiresAt).toBeGreaterThan(Date.now());

		const listRes = await app.request("/api/workspaces", {
			headers: { Authorization: `Bearer ${session.sessionToken}` },
		});
		expect(listRes.status).toBe(200);
		expect((await listRes.json()).workspaces).toHaveLength(1);
	});

	it("gives the second user editor rather than owner", async () => {
		const res = await post("/api/auth/dev-login", {
			name: "bob",
			device: { ...device, vaultId: "vault-b" },
		});
		const session = SessionResponse.parse(await res.json());
		expect(session.workspaces[0]?.role).toBe("editor");
	});

	it("rejects requests without a session", async () => {
		expect((await app.request("/api/auth/me")).status).toBe(401);
		expect(
			(await app.request("/api/auth/me", { headers: { Authorization: "Bearer nope" } })).status,
		).toBe(401);
	});

	it("rejects a malformed dev-login body", async () => {
		const res = await post("/api/auth/dev-login", { name: "", device: {} });
		expect(res.status).toBe(400);
	});

	it("revokes the session on logout", async () => {
		const res = await post("/api/auth/dev-login", {
			name: "carol",
			device: { ...device, vaultId: "vault-c" },
		});
		const session = SessionResponse.parse(await res.json());
		expect((await post("/api/auth/logout", {}, session.sessionToken)).status).toBe(200);
		const after = await app.request("/api/auth/me", {
			headers: { Authorization: `Bearer ${session.sessionToken}` },
		});
		expect(after.status).toBe(401);
	});
});
