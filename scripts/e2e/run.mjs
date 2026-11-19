// Scenario runner: `node scripts/e2e/run.mjs --suite p1 [--only a,b] [--keep-open]`.
//
// Starts the backend, prepares the vaults in `VAULTS`, launches and connects alice and bob, then
// runs every `scripts/e2e/<suite>/*.mjs` scenario (alphabetical). A scenario module exports (as its
// default export or as named exports)
// `{name, needs: ["alice", "bob", ...], fresh?: [...], backends?: ["cf", ...],
//   seed?: {[vault]: {[path]: content}}, run(ctx)}` with
// `ctx = {vaults, server, backend, api, folder, step, artifacts, restartServer()}`.
// - Other vaults are launched only when a scenario needs them; carol joins as a viewer.
// - `fresh` vaults are launched with the plugin installed, enabled and pointed at the backend, but
//   not logged in or connected (sign-in tests). A vault that an earlier scenario connected cannot
//   be fresh.
// - `backends` limits a scenario to those `E2E_BACKEND` values; elsewhere it prints SKIP.
// - `ctx.api` holds the HTTP helpers from api.mjs.
// Each scenario works in its own folder `Shared/<name>/` (`ctx.folder`). On failure every window
// is screenshotted; the exit code is non-zero if any scenario fails. A step that throws SkipError
// marks the scenario SKIP.
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { createApi } from "./api.mjs";
import { ARTIFACTS, screenshot } from "./editor.mjs";
import {
	connectPlugin,
	installPlugin,
	prepareVaults,
	ROOT,
	VaultHandle,
	waitConnected,
} from "./obsidian.mjs";
import { BACKEND, restartServer, SkipError, startServer } from "./server.mjs";

const { values: opts } = parseArgs({
	options: {
		suite: { type: "string", default: "p1" },
		only: { type: "string" },
		"keep-open": { type: "boolean", default: false },
	},
});

const VAULTS = ["alice", "bob", "carol", "dave", "dave-phone", "erin"];
const ROLES = { carol: "viewer" };
/** Every vault maps this folder; each scenario works in `Shared/<name>/`. */
const SHARED_FOLDER = "Shared";
const CDP_PORT_BASE = Number(process.env.E2E_CDP_PORT ?? 9333);

const dir = join(ROOT, "scripts", "e2e", opts.suite);
let files;
try {
	files = readdirSync(dir)
		.filter((f) => f.endsWith(".mjs"))
		.sort();
} catch {
	files = [];
}
let scenarios = await Promise.all(
	files.map(async (f) => {
		const m = await import(join(dir, f));
		return m.default ?? m;
	}),
);
if (opts.only) {
	const wanted = opts.only.split(",").map((s) => s.trim());
	const missing = wanted.filter((w) => !scenarios.some((s) => s.name === w));
	if (missing.length) {
		console.error(`e2e ${opts.suite}: unknown scenario(s): ${missing.join(", ")}`);
		process.exit(1);
	}
	scenarios = scenarios.filter((s) => wanted.includes(s.name));
}
if (scenarios.length === 0) {
	// The p2 suite starts empty (P2-0) and fills up lane by lane.
	if (opts.suite === "p2") {
		console.log("e2e p2: no scenarios");
		process.exit(0);
	}
	console.error(`e2e ${opts.suite}: no scenarios in ${dir}`);
	process.exit(1);
}

const seed = {};
for (const s of scenarios) {
	for (const [vault, entries] of Object.entries(s.seed ?? {})) {
		seed[vault] = { ...seed[vault], ...entries };
	}
}

let server = await startServer();
const dirs = prepareVaults(VAULTS, { seed });
const vaults = Object.fromEntries(
	dirs.map((d, i) => [d.name, new VaultHandle(d, { port: CDP_PORT_BASE + i })]),
);
const connected = new Set();
const installed = new Set();
const api = createApi(() => server.url);

/** Launches (or relaunches after a crash/quit) and connects every vault a scenario needs. */
async function ensure(names) {
	for (const name of names) {
		const v = vaults[name];
		if (!v) throw new Error(`unknown vault ${name}`);
		const relaunched = !v.running;
		if (relaunched) await v.launch();
		if (connected.has(name)) {
			// autoConnect reconnects a relaunched vault with its stored session.
			if (relaunched) await waitConnected(v);
			continue;
		}
		const r = await connectPlugin(v, {
			serverUrl: server.url,
			name,
			role: ROLES[name],
			sharedFolder: SHARED_FOLDER,
		});
		if (r.status !== "connected") throw new Error(`${name} did not connect: ${JSON.stringify(r)}`);
		connected.add(name);
	}
}

/** Launches each vault with the plugin installed and pointed at the backend, not connected. */
async function ensureFresh(names) {
	for (const name of names) {
		const v = vaults[name];
		if (!v) throw new Error(`unknown vault ${name}`);
		if (connected.has(name)) throw new Error(`${name} was connected earlier and cannot be fresh`);
		if (!v.running) await v.launch();
		if (installed.has(name)) continue;
		await installPlugin(v, { serverUrl: server.url });
		installed.add(name);
	}
}

const results = [];
try {
	await ensure(["alice", "bob"]);
	for (const scenario of scenarios) {
		if (scenario.backends && !scenario.backends.includes(BACKEND)) {
			results.push([scenario.name, "SKIP"]);
			console.log(`SKIP ${scenario.name} (backend)`);
			continue;
		}
		console.log(`${scenario.name}:`);
		const ctx = {
			vaults,
			get server() {
				return server;
			},
			backend: BACKEND,
			api,
			folder: `Shared/${scenario.name}`,
			artifacts: join(ARTIFACTS, opts.suite, scenario.name),
			step: (msg) => console.log(`  ✓ ${msg}`),
			restartServer: async ({ pauseMs = 3000 } = {}) => {
				server = await restartServer(server, { pauseMs });
				return server;
			},
		};
		try {
			const fresh = scenario.fresh ?? [];
			await ensure((scenario.needs ?? ["alice", "bob"]).filter((n) => !fresh.includes(n)));
			await ensureFresh(fresh);
			await scenario.run(ctx);
			results.push([scenario.name, "PASS"]);
			console.log(`${scenario.name}: PASS`);
		} catch (error) {
			if (error instanceof SkipError) {
				results.push([scenario.name, "SKIP"]);
				console.log(`${scenario.name}: SKIP (${error.message})`);
				continue;
			}
			results.push([scenario.name, "FAIL"]);
			console.error(`${scenario.name}: FAIL\n${error?.stack ?? error}`);
			for (const v of Object.values(vaults)) {
				if (!v.running) continue;
				try {
					const file = await screenshot(v, join(ctx.artifacts, `failure-${v.name}.png`));
					console.error(`  screenshot: ${file}`);
				} catch (e) {
					console.error(`  screenshot of ${v.name} failed: ${e.message}`);
				}
			}
		}
	}
	if (opts["keep-open"]) {
		console.log("--keep-open: Obsidian and the backend stay up; Ctrl-C to stop.");
		await new Promise((r) => process.once("SIGINT", r));
	}
} finally {
	await Promise.all(Object.values(vaults).map((v) => v.quit()));
	await server.stop();
}

const failed = results.filter(([, r]) => r === "FAIL");
console.log(
	`e2e ${opts.suite}: ${results.length - failed.length}/${results.length} passed or skipped` +
		(failed.length ? `; failed: ${failed.map(([n]) => n).join(", ")}` : ""),
);
process.exit(failed.length ? 1 : 0);
