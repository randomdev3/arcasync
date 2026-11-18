// Starts a throwaway sync backend for e2e tests (fresh data dir, its own port).
// This is the only e2e file that knows which backend implementation exists:
// E2E_BACKEND=node (default) runs packages/server, E2E_BACKEND=cf runs packages/relay-cf
// under `wrangler dev` with its local state persisted inside the data dir.
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startRelayDev } from "../../packages/relay-cf/scripts/dev-server.mjs";
import { ROOT, waitFor } from "./obsidian.mjs";

const BACKEND = process.env.E2E_BACKEND ?? "node";

export async function startServer({ port = 8788, dataDir } = {}) {
	const dir = dataDir ?? mkdtempSync(join(tmpdir(), "teamsync-e2e-"));
	if (BACKEND === "cf") return startCfRelay({ port, dir });
	if (BACKEND !== "node") throw new Error(`unknown E2E_BACKEND=${BACKEND} (node|cf)`);
	const child = spawn("pnpm", ["--filter", "@teamsync/server", "exec", "tsx", "src/index.ts"], {
		cwd: ROOT,
		env: {
			...process.env,
			TEAMSYNC_PORT: String(port),
			TEAMSYNC_DATA_DIR: dir,
			TEAMSYNC_DB_URL: "",
			TEAMSYNC_DEV_OPEN_LOGIN: "1",
			TEAMSYNC_PUBLIC_URL: `http://localhost:${port}`,
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
		child.kill("SIGTERM");
		await new Promise((r) => child.once("exit", r));
		if (!keepData) rmSync(dir, { recursive: true, force: true });
	};
	return { url, dataDir: dir, stop };
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
	return { url: relay.url, dataDir: dir, stop };
}
