/**
 * Front Worker: REST `/api/*` (backed by the `Accounts` DO) and `/ws?ws=<workspaceId>`
 * (routed to that workspace's `WorkspaceRelay` DO). Response shapes match the Node server.
 */
import {
	API_PREFIX,
	BootstrapRequest,
	CHUNK_BYTES,
	DevLoginRequest,
	InviteAcceptRequest,
	InviteCreateRequest,
	InviteRedeemRequest,
	PRESENCE_RENEWAL_MS,
	parseDocName,
	type ServerInfo,
	WorkspaceCreateRequest,
	WS_PATH,
	WsTokenRequest,
} from "@teamsync/shared";
import { type Context, Hono } from "hono";
import { cors } from "hono/cors";
import type { ApiError, Result } from "./AccountsDO";
import { configError } from "./config";
import type { Env } from "./env";

export { AccountsDO } from "./AccountsDO";
export { WorkspaceRelay } from "./WorkspaceRelay";

const RELAY_VERSION = "0.0.1-cf";
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

const errorBody = (code: string, message: string, details?: unknown) => ({
	error: { code, message, ...(details === undefined ? {} : { details }) },
});

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
const api = new Hono<{ Bindings: Env }>();

api.get("/health", (c) => c.json({ ok: true, version: RELAY_VERSION }));

api.get("/server-info", (c) =>
	c.json({
		name: "TeamSync",
		version: RELAY_VERSION,
		publicUrl: publicUrl(c),
		features: {
			devOpenLogin: c.env.TEAMSYNC_DEV_OPEN_LOGIN === "1",
			presign: false,
			excalidraw: false,
			textKeepalive: true,
			presenceRenewalMs: PRESENCE_RENEWAL_MS,
		},
		limits: { maxFileBytes: Number(c.env.TEAMSYNC_MAX_FILE_BYTES), chunkBytes: CHUNK_BYTES },
	} satisfies ServerInfo),
);

api.post("/auth/dev-login", async (c) => {
	const body = DevLoginRequest.safeParse(await jsonBody(c.req.raw));
	if (!body.success) return c.json(errorBody("bad_request", "Invalid request"), 400);
	const { name, device, role, workspace } = body.data;
	return reply(c, await accounts(c.env).devLogin(name, device, role, workspace));
});

api.get("/auth/me", async (c) =>
	reply(c, await accounts(c.env).me(bearerToken(c.req.header("authorization")))),
);

api.post("/auth/ws-token", async (c) => {
	const token = bearerToken(c.req.header("authorization"));
	if (!token) return c.json(errorBody("unauthorized", "Missing bearer token"), 401);
	const body = WsTokenRequest.safeParse(await jsonBody(c.req.raw));
	if (!body.success) return c.json(errorBody("bad_request", "Invalid request"), 400);
	return reply(c, await accounts(c.env).wsToken(token, body.data.workspaceId));
});

api.post("/auth/logout", async (c) =>
	reply(c, await accounts(c.env).logout(bearerToken(c.req.header("authorization")))),
);

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
	return reply(c, await accounts(c.env).redeemInvite(bearer(c), body.token));
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
