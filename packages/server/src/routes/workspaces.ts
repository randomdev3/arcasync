import { Hono } from "hono";
import { requireSession } from "../auth/middleware.js";
import type { AppEnv, Deps } from "../types.js";
import { workspacesForUser } from "./mappers.js";

export function workspaceRoutes(deps: Deps) {
	const app = new Hono<AppEnv>();

	app.use("/workspaces", requireSession(deps));
	app.get("/workspaces", async (c) => {
		const user = c.get("user");
		return c.json({ workspaces: await workspacesForUser(deps.db, user.id) });
	});

	return app;
}
