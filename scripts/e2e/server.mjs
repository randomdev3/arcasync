// Starts a throwaway sync backend for e2e tests (fresh data dir, its own port).
// This is the only e2e file that knows which backend implementation exists:
// - E2E_BACKEND=cf (default) runs packages/relay-cf under `wrangler dev --env dev`, with its local
//   state persisted inside the data dir.
// - E2E_BACKEND=node runs packages/server (the conformance oracle).
// - E2E_BACKEND=remote uses an already-running backend at E2E_REMOTE_URL; it cannot be stopped or
//   restarted, so restart legs are skipped.
// The port comes from E2E_PORT (default 8788).
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startRelayDev } from "../../packages/relay-cf/scripts/dev-server.mjs";
import { ROOT, sleep, waitFor } from "./obsidian.mjs";

export const BACKEND = process.env.E2E_BACKEND ?? "cf";

/** Thrown by steps that cannot run against the current backend; runners print SKIP. */
export class SkipError extends Error {}

export async function startServer({ port = Number(process.env.E2E_PORT ?? 8788), dataDir } = {}) {
	if (BACKEND === "remote") return remoteServer();
	const dir = dataDir ?? mkdtempSync(join(tmpdir(), "teamsync-e2e-"));
	if (BACKEND === "cf") return startCfRelay({ port, dir });
	if (BACKEND !== "node") throw new Error(`unknown E2E_BACKEND=${BACKEND} (cf|node|remote)`);
	const child = spawn("pnpm", ["--filter", "@arcasync/server", "exec", "tsx", "src/index.ts"], {
		cwd: ROOT,
		env: {
			...process.env,
			ARCASYNC_PORT: String(port),
			ARCASYNC_DATA_DIR: dir,
			ARCASYNC_DB_URL: "",
			ARCASYNC_DEV_OPEN_LOGIN: "1",
			ARCASYNC_PUBLIC_URL: `http://localhost:${port}`,
			LOG_LEVEL: process.env.E2E_SERVER_LOG ?? "warn",
		},
		stdio: process.env.E2E_SERVER_LOG ? "inherit" : "ignore",
	});
	const url = `http://localhost:${port}`;
	await waitFor(
		async () => {
			try {
				return (await fetch(`${url}/api/health`)).ok;
			} catch {
				return false;
			}
		},
		{ timeout: 30000, label: "server health" },
	);
	const stop = async ({ keepData = false } = {}) => {
		if (child.exitCode === null && child.signalCode === null) {
			child.kill("SIGTERM");
			await new Promise((r) => child.once("exit", r));
		}
		if (!keepData) rmSync(dir, { recursive: true, force: true });
	};
	return { backend: BACKEND, url, port, dataDir: dir, stop };
}

async function startCfRelay({ port, dir }) {
	const relay = await startRelayDev({
		port,
		persistTo: join(dir, "wrangler-state"),
		log: Boolean(process.env.E2E_SERVER_LOG),
	});
	const stop = async ({ keepData = false } = {}) => {
		await relay.stop();
		if (!keepData) rmSync(dir, { recursive: true, force: true });
	};
	return { backend: BACKEND, url: relay.url, port, dataDir: dir, stop };
}

function remoteServer() {
	const url = process.env.E2E_REMOTE_URL?.replace(/\/+$/, "");
	if (!url) throw new Error("E2E_BACKEND=remote needs E2E_REMOTE_URL");
	return { backend: BACKEND, url, port: null, dataDir: null, stop: async () => {} };
}

/**
 * Stops the backend (keeping its data), waits `pauseMs`, and starts it again on the same port and
 * data dir. Returns the new server. Throws SkipError for a remote backend.
 */
export async function restartServer(server, { pauseMs = 0 } = {}) {
	if (server.backend === "remote") throw new SkipError("server restart needs a local backend");
	await server.stop({ keepData: true });
	await sleep(pauseMs);
	return startServer({ port: server.port, dataDir: server.dataDir });
}
