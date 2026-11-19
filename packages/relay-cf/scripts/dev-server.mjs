// Starts `wrangler dev` for the relay with local state persisted under `persistTo`, and stops it
// by killing the whole process group (wrangler's workerd child is orphaned otherwise).
import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const PACKAGE_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");
const WRANGLER = join(
	dirname(createRequire(join(PACKAGE_DIR, "package.json")).resolve("wrangler/package.json")),
	"bin",
	"wrangler.js",
);

const SITE_DIST = join(PACKAGE_DIR, "..", "site", "dist");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * wrangler refuses to start without the assets directory (`../site/dist`). Turbo builds the site
 * first for `pnpm dev`/`build`/`test`; vitest integration runs and the e2e harness do not go
 * through turbo, so build it here when it is missing. An existing build is reused as is.
 */
export function ensureSiteBuilt() {
	if (existsSync(join(SITE_DIST, "index.html"))) return;
	const result = spawnSync("pnpm", ["-F", "@arcasync/site", "build"], {
		cwd: PACKAGE_DIR,
		stdio: "inherit",
	});
	if (result.status !== 0) throw new Error(`building @arcasync/site failed (${result.status})`);
}

/**
 * @param {{ port: number, persistTo: string, env?: string, vars?: Record<string, string>, log?: boolean }} options
 * @returns {Promise<{ url: string, pid: number, stop: () => Promise<void> }>}
 */
export async function startRelayDev({ port, persistTo, env = "dev", vars = {}, log = false }) {
	ensureSiteBuilt();
	const url = `http://localhost:${port}`;
	// Invite and device-code links point at this relay, whatever port it is on.
	if (env === "dev") vars = { ARCASYNC_PUBLIC_URL: url, ...vars };
	const args = [
		WRANGLER,
		"dev",
		"--env",
		env,
		"--port",
		String(port),
		// Distinct per relay so parallel lanes do not collide on wrangler's default 9229.
		"--inspector-port",
		String(port + 10_000),
		"--ip",
		"localhost",
		"--persist-to",
		persistTo,
		"--show-interactive-dev-session=false",
		...Object.entries(vars).flatMap(([k, v]) => ["--var", `${k}:${v}`]),
	];
	const child = spawn(process.execPath, args, {
		cwd: PACKAGE_DIR,
		detached: true,
		env: { ...process.env, WRANGLER_SEND_METRICS: "false", CI: "1" },
		stdio: log ? "inherit" : "ignore",
	});
	const exited = new Promise((r) => child.once("exit", r));

	const stop = async () => {
		if (child.exitCode !== null || child.signalCode !== null) return;
		try {
			process.kill(-child.pid, "SIGTERM");
		} catch {
			return;
		}
		const done = await Promise.race([exited.then(() => true), sleep(5000).then(() => false)]);
		if (!done) {
			try {
				process.kill(-child.pid, "SIGKILL");
			} catch {}
			await exited;
		}
		// Let workerd release the port before a restart on the same one.
		for (let i = 0; i < 50; i++) {
			try {
				await fetch(`${url}/api/health`);
				await sleep(100);
			} catch {
				return;
			}
		}
	};

	const deadline = Date.now() + 60_000;
	for (;;) {
		if (child.exitCode !== null) throw new Error(`wrangler dev exited with ${child.exitCode}`);
		try {
			if ((await fetch(`${url}/api/health`)).ok) break;
		} catch {}
		if (Date.now() > deadline) {
			await stop();
			throw new Error("timed out waiting for wrangler dev");
		}
		await sleep(250);
	}
	return { url, pid: child.pid, stop };
}
