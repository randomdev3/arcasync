import { API_PREFIX } from "@teamsync/shared";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { HTTPException } from "hono/http-exception";
import { ZodError } from "zod";
import { ApiException } from "./errors.js";
import { httpDuration, httpRequests, registry } from "./metrics.js";
import { authRoutes } from "./routes/auth.js";
import { healthRoutes } from "./routes/health.js";
import { serverInfoRoutes } from "./routes/serverInfo.js";
import { workspaceRoutes } from "./routes/workspaces.js";
import type { AppEnv, Deps } from "./types.js";

/** Obsidian desktop is `app://obsidian.md`, mobile is `capacitor://localhost`. */
const ALLOWED_ORIGINS = ["app://obsidian.md", "capacitor://localhost", "http://localhost"];

function isAllowedOrigin(origin: string): boolean {
	if (ALLOWED_ORIGINS.includes(origin)) return true;
	// Any localhost/127.0.0.1 port (dev servers, admin SPA).
	return /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin);
}

export function createApp(deps: Deps) {
	const app = new Hono<AppEnv>();

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

	app.use("*", async (c, next) => {
		const start = performance.now();
		await next();
		const route = c.req.routePath ?? c.req.path;
		httpRequests.inc({ method: c.req.method, route, status: String(c.res.status) });
		httpDuration.observe({ method: c.req.method, route }, (performance.now() - start) / 1000);
	});

	app.route(API_PREFIX, healthRoutes(deps));
	app.route(API_PREFIX, serverInfoRoutes(deps));
	app.route(API_PREFIX, authRoutes(deps));
	app.route(API_PREFIX, workspaceRoutes(deps));

	app.get("/metrics", async (c) => {
		const token = deps.config.adminBootstrapToken;
		if (deps.config.isProduction && token) {
			const header = c.req.header("authorization");
			if (header !== `Bearer ${token}`) return c.text("Unauthorized", 401);
		}
		c.header("Content-Type", registry.contentType);
		return c.body(await registry.metrics());
	});

	app.notFound((c) =>
		c.json({ error: { code: "not_found", message: `No route for ${c.req.path}` } }, 404),
	);

	app.onError((err, c) => {
		if (err instanceof ApiException) {
			return c.json(
				{ error: { code: err.code, message: err.message, details: err.details } },
				err.status,
			);
		}
		if (err instanceof ZodError) {
			return c.json(
				{ error: { code: "bad_request", message: "Invalid request", details: err.issues } },
				400,
			);
		}
		if (err instanceof HTTPException) {
			// `zValidator` rejects with a 400 HTTPException carrying a JSON body.
			const res = err.getResponse();
			if (res.status === 400) {
				return c.json({ error: { code: "bad_request", message: "Invalid request" } }, 400);
			}
			return c.json({ error: { code: "http_error", message: err.message } }, err.status);
		}
		deps.log.error({ err }, "unhandled error");
		return c.json({ error: { code: "internal", message: "Internal server error" } }, 500);
	});

	return app;
}

export type App = ReturnType<typeof createApp>;
