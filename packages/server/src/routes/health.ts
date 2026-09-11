import { Hono } from "hono";
import { pingDb } from "../db/index.js";
import type { AppEnv, Deps } from "../types.js";

export function healthRoutes(deps: Deps) {
	const app = new Hono<AppEnv>();

	app.get("/health", (c) => c.json({ ok: true, version: deps.config.version }));

	app.get("/ready", async (c) => {
		const checks: Record<string, boolean> = { db: false, blobs: false };
		try {
			await pingDb(deps.db);
			checks.db = true;
		} catch (err) {
			deps.log.error({ err }, "readiness: db ping failed");
		}
		try {
			await deps.blobs.ping();
			checks.blobs = true;
		} catch (err) {
			deps.log.error({ err }, "readiness: blob store ping failed");
		}
		const ok = checks.db === true && checks.blobs === true;
		return c.json({ ok, checks }, ok ? 200 : 503);
	});

	return app;
}
