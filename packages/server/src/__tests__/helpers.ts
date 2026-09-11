import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pino } from "pino";
import { type Config, loadConfig } from "../config.js";
import { type DbHandle, createDb } from "../db/index.js";
import { FsBlobStore } from "../storage/FsBlobStore.js";
import type { Deps } from "../types.js";

export function testConfig(): Config {
	const dataDir = mkdtempSync(path.join(tmpdir(), "teamsync-test-"));
	return loadConfig(
		{ NODE_ENV: "test", LOG_FORMAT: "json", LOG_LEVEL: "silent" },
		{ dataDir, secret: "test-secret-0123456789", devOpenLogin: true, pgliteDir: "memory://" },
	);
}

/**
 * One PGlite instance per test file — never create two concurrently in a process.
 */
export async function createTestDeps(): Promise<{ deps: Deps; handle: DbHandle }> {
	const config = testConfig();
	const handle = createDb(config);
	await handle.migrate();
	const deps: Deps = {
		db: handle.db,
		config,
		blobs: new FsBlobStore(config.blobDir),
		log: pino({ level: "silent" }),
	};
	return { deps, handle };
}
