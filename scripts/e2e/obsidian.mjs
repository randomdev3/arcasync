// Drives a real, isolated Obsidian instance for end-to-end tests.
//
// A separate --user-data-dir gives us our own Electron single-instance lock, so this runs
// alongside the user's normal Obsidian without touching its vaults or settings. Each vault
// window is a Chrome DevTools Protocol page target; `Vault.eval` runs async JS inside it with
// the global `app` available.
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const OBSIDIAN_BIN =
	process.env.OBSIDIAN_BIN ?? "/Applications/Obsidian.app/Contents/MacOS/Obsidian";

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function waitFor(fn, { timeout = 15000, interval = 200, label = "condition" } = {}) {
	const deadline = Date.now() + timeout;
	let last;
	while (Date.now() < deadline) {
		last = await fn();
		if (last) return last;
		await sleep(interval);
	}
	throw new Error(`timed out waiting for ${label} (last: ${JSON.stringify(last)})`);
}

/** Creates fresh vault folders under `.e2e/vaults` with the built plugin symlinked in. */
export function prepareVaults(names, { seed = {} } = {}) {
	const base = join(ROOT, ".e2e", "vaults");
	rmSync(base, { recursive: true, force: true });
	return names.map((name) => {
		const path = join(base, name);
		mkdirSync(join(path, ".obsidian", "plugins"), { recursive: true });
		writeFileSync(join(path, ".obsidian", "community-plugins.json"), '["teamsync"]');
		symlinkSync(join(ROOT, "packages", "plugin", "dist"), join(path, ".obsidian/plugins/teamsync"));
		for (const [rel, content] of Object.entries(seed[name] ?? {})) {
			mkdirSync(dirname(join(path, rel)), { recursive: true });
			writeFileSync(join(path, rel), content);
		}
		return { name, path };
	});
}

class Vault {
	constructor(name, wsUrl) {
		this.name = name;
		this.wsUrl = wsUrl;
		this.nextId = 1;
		this.pending = new Map();
	}

	async open() {
		this.ws = new WebSocket(this.wsUrl);
		await new Promise((res, rej) => {
			this.ws.addEventListener("open", res, { once: true });
			this.ws.addEventListener("error", rej, { once: true });
		});
		this.ws.addEventListener("message", (ev) => {
			const msg = JSON.parse(ev.data);
			const p = this.pending.get(msg.id);
			if (!p) return;
			this.pending.delete(msg.id);
			if (msg.error) p.reject(new Error(msg.error.message));
			else p.resolve(msg.result);
		});
		return this;
	}

	send(method, params) {
		const id = this.nextId++;
		this.ws.send(JSON.stringify({ id, method, params }));
		return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
	}

	/** Runs `body` (the inside of an async function; `app` is in scope) and returns its JSON value. */
	async eval(body, args = {}) {
		const expression = `(async (args) => { ${body} })(${JSON.stringify(args)})`;
		const r = await this.send("Runtime.evaluate", {
			expression,
			awaitPromise: true,
			returnByValue: true,
		});
		if (r.exceptionDetails) {
			const d = r.exceptionDetails;
			throw new Error(`[${this.name}] ${d.exception?.description ?? d.text}`);
		}
		return r.result.value;
	}

	close() {
		this.ws?.close();
	}
}

/**
 * Launches Obsidian with the given vaults open and returns `{vaults: {[name]: Vault}, close}`.
 * Uses a persistent profile in `.e2e/profile` so Obsidian's app-update download happens once.
 */
export async function launchObsidian(
	vaultDirs,
	{ port = Number(process.env.CDP_PORT ?? 9333) } = {},
) {
	const profile = join(ROOT, ".e2e", "profile");
	mkdirSync(profile, { recursive: true });
	const vaults = {};
	for (const v of vaultDirs) {
		// A fresh vault id per run keeps per-vault localStorage (session tokens) from leaking across runs.
		vaults[randomBytes(8).toString("hex")] = { path: v.path, ts: Date.now(), open: true };
	}
	writeFileSync(join(profile, "obsidian.json"), JSON.stringify({ vaults }));

	const child = spawn(
		OBSIDIAN_BIN,
		[`--user-data-dir=${profile}`, `--remote-debugging-port=${port}`],
		{
			stdio: "ignore",
			detached: false,
		},
	);
	const close = async () => {
		for (const v of Object.values(handles)) v.close();
		child.kill("SIGTERM");
		await sleep(500);
	};
	const handles = {};
	try {
		const targets = await waitFor(
			async () => {
				try {
					const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
					const pages = list.filter((t) => t.type === "page");
					const all = vaultDirs.every((v) =>
						pages.some((t) => t.title.includes(` - ${v.name} - `)),
					);
					return all ? pages : null;
				} catch {
					return null;
				}
			},
			{ timeout: 45000, label: "Obsidian windows" },
		);
		for (const v of vaultDirs) {
			const t = targets.find((p) => p.title.includes(` - ${v.name} - `));
			handles[v.name] = await new Vault(v.name, t.webSocketDebuggerUrl).open();
			await waitFor(() => handles[v.name].eval("return !!app?.workspace?.layoutReady"), {
				label: `${v.name} layout ready`,
			});
		}
	} catch (error) {
		await close();
		throw error;
	}
	return { vaults: handles, close };
}

/** Turns off restricted mode, loads the plugin, points it at `serverUrl`, logs in as `name`, connects. */
export async function connectPlugin(vault, { serverUrl, name }) {
	return vault.eval(
		`
		if (!app.plugins.isEnabled()) await app.plugins.setEnable(true);
		if (!app.plugins.plugins.teamsync) await app.plugins.enablePluginAndSave("teamsync");
		const p = app.plugins.plugins.teamsync;
		if (!p) throw new Error("teamsync plugin did not load");
		p.settings.serverUrl = args.serverUrl;
		p.settings.devLoginName = args.name;
		await p.saveSettings();
		await p.connect();
		for (let i = 0; i < 75 && p.connection?.status !== "connected"; i++) await new Promise(r => setTimeout(r, 200));
		return { status: p.connection?.status, message: p.connection?.message ?? null, user: p.settings.user?.name ?? null };
	`,
		{ serverUrl, name },
	);
}
