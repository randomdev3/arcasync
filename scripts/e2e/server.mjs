// Starts a throwaway sync backend for e2e tests (fresh data dir, its own port).
// This is the only e2e file that knows which backend implementation exists.
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ROOT, waitFor } from "./obsidian.mjs";

export async function startServer({ port = 8788, dataDir } = {}) {
	const dir = dataDir ?? mkdtempSync(join(tmpdir(), "teamsync-e2e-"));
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
