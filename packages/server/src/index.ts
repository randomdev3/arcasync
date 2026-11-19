import { createHocuspocus, destroyHocuspocus } from "./collab/hocuspocus.js";
import { loadConfig } from "./config.js";
import { createDb } from "./db/index.js";
import { createLogger } from "./log.js";
import { ensureDevWorkspace } from "./seed.js";
import { createHttpServer } from "./server.js";
import { createBlobStore } from "./storage/index.js";
import type { Deps } from "./types.js";

async function main(): Promise<void> {
	const config = loadConfig();
	const log = createLogger({ level: config.logLevel, format: config.logFormat });
	const dbHandle = createDb(config);
	await dbHandle.migrate();

	const blobs = createBlobStore(config);
	await blobs.ping();

	const deps: Deps = { db: dbHandle.db, config, blobs, log };
	if (config.devOpenLogin) await ensureDevWorkspace(dbHandle.db);

	const hocuspocus = createHocuspocus(deps);
	const { httpServer } = createHttpServer(deps, hocuspocus);

	await new Promise<void>((resolve) => httpServer.listen(config.port, resolve));
	log.info(
		{
			port: config.port,
			db: dbHandle.kind,
			blobs: blobs.backend,
			devOpenLogin: config.devOpenLogin,
		},
		`ArcaSync server listening on ${config.publicUrl}`,
	);

	let shuttingDown = false;
	const shutdown = async (signal: string) => {
		if (shuttingDown) return;
		shuttingDown = true;
		log.info({ signal }, "shutting down");
		const timer = setTimeout(() => {
			log.error("graceful shutdown timed out");
			process.exit(1);
		}, 15_000);
		timer.unref();
		try {
			await new Promise<void>((resolve) => httpServer.close(() => resolve()));
			await destroyHocuspocus(hocuspocus);
			await dbHandle.close();
		} catch (err) {
			log.error({ err }, "error during shutdown");
		}
		clearTimeout(timer);
		process.exit(0);
	};

	process.on("SIGTERM", () => void shutdown("SIGTERM"));
	process.on("SIGINT", () => void shutdown("SIGINT"));
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
