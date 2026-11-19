/**
 * Front Worker: REST `/api/*` (backed by the `Accounts` DO) and `/ws?ws=<workspaceId>`
 * (routed to that workspace's `WorkspaceRelay` DO). Response shapes match the Node server.
 */
import {
	API_PREFIX,
	BootstrapRequest,
	DeviceApproveRequest,
	DeviceCodePollRequest,
	DeviceCodeStartRequest,
	DevLoginRequest,
	InviteAcceptRequest,
	InviteCreateRequest,
	InviteRedeemRequest,
	ME_CACHE_TTL_MS,
	MemberUpdateRequest,
	type MeResponse,
	parseDocName,
	WorkspaceCreateRequest,
	WS_PATH,
	WsTokenRequest,
} from "@teamsync/shared";
import { type Context, Hono } from "hono";
import { cors } from "hono/cors";
import type { z } from "zod";
import type { ApiError, Result } from "./AccountsDO";
import { chunks } from "./chunks";
import { configError } from "./config";
import type { Env } from "./env";
import { errorBody } from "./errors";
import { cachedResult, createMeCache } from "./meCache";
import { RELAY_VERSION, serverInfo } from "./serverInfo";
import { chunkPrefix } from "./wsAuth";

export { AccountsDO } from "./AccountsDO";
export { WorkspaceRelay } from "./WorkspaceRelay";

const ACCOUNTS_NAME = "accounts";
const WORKSPACE_ID = /^[A-Za-z0-9_-]{1,64}$/;

/** Obsidian desktop is `app://obsidian.md`, mobile is `capacitor://localhost`. */
const ALLOWED_ORIGINS = ["app://obsidian.md", "capacitor://localhost", "http://localhost"];
function isAllowedOrigin(origin: string): boolean {
	if (ALLOWED_ORIGINS.includes(origin)) return true;
	return /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin);
}

function bearerToken(header: string | undefined): string | null {
	if (!header) return null;
	const [scheme, value] = header.split(" ");
	if (scheme?.toLowerCase() !== "bearer" || !value) return null;
	return value.trim() || null;
}

const app = new Hono<{ Bindings: Env }>();

app.use(
	"*",
	cors({
		origin: (origin) => (origin && isAllowedOrigin(origin) ? origin : ALLOWED_ORIGINS[0]),
		allowHeaders: ["Authorization", "Content-Type", "X-Workspace-Id"],
		allowMethods: ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"],
		credentials: true,
		maxAge: 600,
	}),
);

let configErrorLogged = false;

/**
 * A deployment without a usable secret serves nothing: 503 everywhere (WebSocket upgrades
 * included), except `/api/health`, which reports `{ok:false, error}` so the cause is visible.
 */
app.use("*", async (c, next) => {
	const error = configError(c.env);
	if (!error) return next();
	if (!configErrorLogged) {
		configErrorLogged = true;
		console.error(`relay misconfigured: ${error}`);
	}
	if (c.req.path === `${API_PREFIX}/health`) {
		return c.json({ ok: false, version: RELAY_VERSION, error });
	}
	return c.json(errorBody("misconfigured", error), 503);
});

function reply<T>(c: { json: (body: unknown, status?: number) => Response }, result: Result<T>) {
	if (result.ok) return c.json(result.value);
	const e: ApiError = result.error;
	return c.json(errorBody(e.code, e.message), e.status);
}

async function jsonBody(req: Request): Promise<unknown> {
	try {
		return await req.json();
	} catch {
		return undefined;
	}
}

type Ctx = Context<{ Bindings: Env }>;

/** The body parsed with `schema`, or null (the caller answers 400 `bad_request`). */
async function parseBody<T>(
	c: Ctx,
	schema: { safeParse: (v: unknown) => { success: true; data: T } | { success: false } },
): Promise<T | null> {
	const body = schema.safeParse(await jsonBody(c.req.raw));
	return body.success ? body.data : null;
}

const badRequest = (c: Ctx) => c.json(errorBody("bad_request", "Invalid request"), 400);
const bearer = (c: Ctx) => bearerToken(c.req.header("authorization"));
const publicUrl = (c: Ctx) => c.env.TEAMSYNC_PUBLIC_URL || new URL(c.req.url).origin;

const accounts = (env: Env) => env.ACCOUNTS.getByName(ACCOUNTS_NAME);
/** Per isolate (D10); dropped for the caller on logout and invite redeem. */
const meCache = createMeCache<z.infer<typeof MeResponse>>({ ttlMs: ME_CACHE_TTL_MS, max: 256 });
const api = new Hono<{ Bindings: Env }>();

api.get("/health", (c) => c.json({ ok: true, version: RELAY_VERSION }));

api.get("/server-info", (c) => c.json(serverInfo(c.env, publicUrl(c))));

api.route("/chunks", chunks);

api.post("/auth/dev-login", async (c) => {
	const body = DevLoginRequest.safeParse(await jsonBody(c.req.raw));
	if (!body.success) return c.json(errorBody("bad_request", "Invalid request"), 400);
	const { name, device, role, workspace } = body.data;
	return reply(c, await accounts(c.env).devLogin(name, device, role, workspace));
});

api.get("/auth/me", async (c) => {
	const token = bearer(c);
	if (!token) return reply(c, await accounts(c.env).me(null));
	return reply(c, await cachedResult(meCache, token, () => accounts(c.env).me(token)));
});

api.post("/auth/ws-token", async (c) => {
	const token = bearerToken(c.req.header("authorization"));
	if (!token) return c.json(errorBody("unauthorized", "Missing bearer token"), 401);
	const body = WsTokenRequest.safeParse(await jsonBody(c.req.raw));
	if (!body.success) return c.json(errorBody("bad_request", "Invalid request"), 400);
	return reply(c, await accounts(c.env).wsToken(token, body.data.workspaceId));
});

api.post("/auth/logout", async (c) => {
	const token = bearer(c);
	if (token) meCache.drop(token);
	const result = await accounts(c.env).logout(token);
	// Again after the DO call: a `/me` in flight meanwhile may have re-cached the old value.
	if (token) meCache.drop(token);
	return reply(c, result);
});

api.get("/workspaces", async (c) =>
	reply(c, await accounts(c.env).workspaces(bearerToken(c.req.header("authorization")))),
);

api.post("/auth/bootstrap", async (c) => {
	const body = await parseBody(c, BootstrapRequest);
	if (!body) return badRequest(c);
	return reply(c, await accounts(c.env).bootstrap(bearer(c), body.workspaceName, publicUrl(c)));
});

api.post("/auth/invite/accept", async (c) => {
	const body = await parseBody(c, InviteAcceptRequest);
	if (!body) return badRequest(c);
	return reply(c, await accounts(c.env).acceptInvite(body));
});

api.post("/invites/redeem", async (c) => {
	const body = await parseBody(c, InviteRedeemRequest);
	if (!body) return badRequest(c);
	const token = bearer(c);
	if (token) meCache.drop(token);
	const result = await accounts(c.env).redeemInvite(token, body.token);
	if (token) meCache.drop(token);
	return reply(c, result);
});

api.post("/workspaces", async (c) => {
	const body = await parseBody(c, WorkspaceCreateRequest);
	if (!body) return badRequest(c);
	return reply(c, await accounts(c.env).createWorkspace(bearer(c), body.name));
});

api.get("/workspaces/:id/invites", async (c) =>
	reply(c, await accounts(c.env).listInvites(bearer(c), c.req.param("id"))),
);

api.post("/workspaces/:id/invites", async (c) => {
	const body = await parseBody(c, InviteCreateRequest);
	if (!body) return badRequest(c);
	return reply(
		c,
		await accounts(c.env).createInvite(bearer(c), c.req.param("id"), body, publicUrl(c)),
	);
});

api.delete("/workspaces/:id/invites/:inviteId", async (c) =>
	reply(
		c,
		await accounts(c.env).revokeInvite(bearer(c), c.req.param("id"), c.req.param("inviteId")),
	),
);

/**
 * Files listing and bulk clone are answered by the workspace's DO, which verifies the WS-JWT
 * (D6); the Worker forwards the raw request, so it parses no JSON and streams the response.
 */
const toRelay = (c: Ctx) => {
	const id = c.req.param("id") ?? "";
	if (!WORKSPACE_ID.test(id)) return badRequest(c);
	return c.env.RELAY.getByName(id).fetch(c.req.raw);
};
api.get("/workspaces/:id/files", toRelay);
api.post("/workspaces/:id/docs", toRelay);

api.get("/workspaces/:id/members", async (c) =>
	reply(c, await accounts(c.env).members(bearer(c), c.req.param("id"))),
);

api.patch("/workspaces/:id/members/:userId", async (c) => {
	const body = await parseBody(c, MemberUpdateRequest);
	if (!body) return badRequest(c);
	const { id, userId } = c.req.param();
	return reply(c, await accounts(c.env).setRole(bearer(c), id, userId, body.role));
});

api.delete("/workspaces/:id/members/:userId", async (c) => {
	const { id, userId } = c.req.param();
	return reply(c, await accounts(c.env).removeMember(bearer(c), id, userId));
});

api.post("/admin/users/:id/:op{disable|enable}", async (c) => {
	const { id, op } = c.req.param();
	const a = accounts(c.env);
	if (op === "disable") return reply(c, await a.disableUser(bearer(c), id));
	return reply(c, await a.enableUser(bearer(c), id, publicUrl(c)));
});

const AUDIT_DEFAULT_LIMIT = 50;
const AUDIT_MAX_LIMIT = 100;

api.get("/admin/audit", async (c) => {
	const before = c.req.query("before");
	const limit = c.req.query("limit");
	const beforeN = before === undefined ? undefined : Number(before);
	const limitN = limit === undefined ? AUDIT_DEFAULT_LIMIT : Number(limit);
	if (
		(beforeN !== undefined && !(Number.isSafeInteger(beforeN) && beforeN > 0)) ||
		!(Number.isInteger(limitN) && limitN >= 1 && limitN <= AUDIT_MAX_LIMIT)
	) {
		return badRequest(c);
	}
	return reply(c, await accounts(c.env).auditLog(bearer(c), { before: beforeN, limit: limitN }));
});

api.post("/auth/device/start", async (c) => {
	const body = await parseBody(c, DeviceCodeStartRequest);
	if (!body) return badRequest(c);
	return reply(c, await accounts(c.env).deviceStart(body.device));
});

api.post("/auth/device/poll", async (c) => {
	const body = await parseBody(c, DeviceCodePollRequest);
	if (!body) return badRequest(c);
	return reply(c, await accounts(c.env).devicePoll(body.deviceCode));
});

api.get("/auth/device/lookup", async (c) =>
	reply(c, await accounts(c.env).deviceLookup(bearer(c), c.req.query("userCode") ?? "")),
);

api.post("/auth/device/approve", async (c) => {
	const body = await parseBody(c, DeviceApproveRequest);
	if (!body) return badRequest(c);
	return reply(c, await accounts(c.env).deviceApprove(bearer(c), body.userCode, body.approve));
});

/** Dev-only: AccountsDO RPC calls since its last wake (the `me` cache test reads it). */
api.get("/debug/accounts", async (c) => {
	if (c.env.TEAMSYNC_DEBUG_STATS !== "1") return c.json(errorBody("not_found", "Not found"), 404);
	return c.json(await accounts(c.env).debugAccounts());
});

/** Dev-only: expire an invite now, so tests reach 410 `invite_expired` without waiting. */
api.post("/debug/accounts/expire-invite", async (c) => {
	if (c.env.TEAMSYNC_DEBUG_STATS !== "1") return c.json(errorBody("not_found", "Not found"), 404);
	return c.json(await accounts(c.env).debugExpireInvite(c.req.query("id") ?? ""));
});

/** Dev-only relay instrumentation (G4). Each call is itself one DO request. */
api.on(["GET", "POST"], "/debug/:op{stats|reset}", async (c) => {
	if (c.env.TEAMSYNC_DEBUG_STATS !== "1") return c.json(errorBody("not_found", "Not found"), 404);
	const ws = c.req.query("ws") ?? "";
	if (!WORKSPACE_ID.test(ws)) return c.json(errorBody("bad_request", "Missing ?ws="), 400);
	const relay = c.env.RELAY.getByName(ws);
	const op = c.req.param("op");
	if (op === "reset") return c.json(await relay.debugReset());
	return c.json(await relay.debugStats());
});

const DEBUG_CHUNKS_MAX = 1000;

/** Dev-only: the workspace's R2 objects (≤ 1000), so tests see what is stored. */
api.get("/debug/chunks", async (c) => {
	if (c.env.TEAMSYNC_DEBUG_STATS !== "1") return c.json(errorBody("not_found", "Not found"), 404);
	const ws = c.req.query("ws") ?? "";
	if (!WORKSPACE_ID.test(ws)) return c.json(errorBody("bad_request", "Missing ?ws="), 400);
	if (!c.env.CHUNKS) return c.json(errorBody("chunks_unavailable", "No chunk storage"), 503);
	const listed = await c.env.CHUNKS.list({ prefix: chunkPrefix(ws), limit: DEBUG_CHUNKS_MAX });
	return c.json({
		objects: listed.objects.map((o) => ({
			key: o.key,
			size: o.size,
			uploaded: o.uploaded.getTime(),
		})),
	});
});

/** Dev-only chunk GC: run it now (`graceMs` defaults to 0), or read the pending alarm. */
api.post("/debug/gc", async (c) => {
	if (c.env.TEAMSYNC_DEBUG_STATS !== "1") return c.json(errorBody("not_found", "Not found"), 404);
	const ws = c.req.query("ws") ?? "";
	const graceMs = Number(c.req.query("graceMs") ?? 0);
	if (!WORKSPACE_ID.test(ws) || !(Number.isFinite(graceMs) && graceMs >= 0)) {
		return c.json(errorBody("bad_request", "Missing ?ws= or bad ?graceMs="), 400);
	}
	return c.json(await c.env.RELAY.getByName(ws).debugGc(ws, graceMs));
});

api.get("/debug/alarm", async (c) => {
	if (c.env.TEAMSYNC_DEBUG_STATS !== "1") return c.json(errorBody("not_found", "Not found"), 404);
	const ws = c.req.query("ws") ?? "";
	if (!WORKSPACE_ID.test(ws)) return c.json(errorBody("bad_request", "Missing ?ws="), 400);
	return c.json(await c.env.RELAY.getByName(ws).debugAlarm());
});

/** Dev-only attribution readout of one doc (P1-8): rows per user, client ids, tail, state size. */
api.get("/debug/doc", async (c) => {
	if (c.env.TEAMSYNC_DEBUG_STATS !== "1") return c.json(errorBody("not_found", "Not found"), 404);
	const ws = c.req.query("ws") ?? "";
	const doc = c.req.query("doc") ?? "";
	if (!WORKSPACE_ID.test(ws)) return c.json(errorBody("bad_request", "Missing ?ws="), 400);
	if (parseDocName(doc)?.workspaceId !== ws) {
		return c.json(errorBody("bad_request", "?doc= must be a doc of ?ws="), 400);
	}
	return c.json(await c.env.RELAY.getByName(ws).debugDoc(doc));
});

app.route(API_PREFIX, api);

app.get(WS_PATH, (c) => {
	if (c.req.header("upgrade")?.toLowerCase() !== "websocket") {
		return c.json(errorBody("bad_request", "Expected a WebSocket upgrade"), 426);
	}
	const ws = c.req.query("ws") ?? "";
	if (!WORKSPACE_ID.test(ws)) {
		return c.json(errorBody("bad_request", "Missing or invalid ?ws=<workspaceId>"), 400);
	}
	return c.env.RELAY.getByName(ws).fetch(c.req.raw);
});

app.notFound((c) => c.json(errorBody("not_found", `No route for ${c.req.path}`), 404));
app.onError((err, c) => {
	console.error("unhandled error", err);
	return c.json(errorBody("internal", "Internal server error"), 500);
});

export default app;
