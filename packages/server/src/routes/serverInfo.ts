import { CHUNK_BYTES } from "@teamsync/shared";
import { Hono } from "hono";
import type { AppEnv, Deps } from "../types.js";

export function serverInfoRoutes(deps: Deps) {
	const app = new Hono<AppEnv>();

	app.get("/server-info", (c) =>
		c.json({
			name: "TeamSync",
			version: deps.config.version,
			publicUrl: deps.config.publicUrl,
			features: {
				devOpenLogin: deps.config.devOpenLogin,
				presign: deps.config.presign,
				excalidraw: false,
			},
			limits: { maxFileBytes: deps.config.maxFileBytes, chunkBytes: CHUNK_BYTES },
		}),
	);

	return app;
}
