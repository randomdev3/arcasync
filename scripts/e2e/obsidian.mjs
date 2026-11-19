// Drives real, isolated Obsidian instances for end-to-end tests: one process per vault.
//
// Each vault gets its own --user-data-dir (`.e2e/profiles/<name>`), which gives it its own Electron
// single-instance lock. That lets the harness quit and relaunch one vault mid-test, and keeps every
// test process apart from the user's normal Obsidian, its vaults and its settings. Each window is
// a Chrome DevTools Protocol page target; `VaultHandle.eval` runs async JS inside it with the global
// `app` available.
import { spawn, spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
	existsSync,
	lstatSync,
	mkdirSync,
	readFileSync,
	rmSync,
	symlinkSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { prepareProfile } from "./hidden.mjs";

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const OBSIDIAN_BIN =
	process.env.OBSIDIAN_BIN ?? "/Applications/Obsidian.app/Contents/MacOS/Obsidian";
const CDP_PORT_BASE = Number(process.env.E2E_CDP_PORT ?? 9333);

// Created once per harness process: vault ids are stable across `relaunch()` (so the session token
// and IndexedDB keyed by `app.appId` survive) and fresh per run (so a new backend never sees a stale
// token from a previous run).
const RUN_NONCE = randomBytes(8).toString("hex");

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

export function vaultId(name) {
	return createHash("sha1")
		.update(name + RUN_NONCE)
		.digest("hex")
		.slice(0, 16);
}

/**
 * Creates vault folders under `.e2e/vaults`. Each vault is wiped first unless `keep` is set.
 * `seed` maps vault name → {relative path: content}.
 * The plugin is installed later by `connectPlugin`: a vault that already has plugins on its first
 * open makes Obsidian show a "trust the author" modal, which steals keyboard focus.
 */
export function prepareVaults(names, { seed = {}, keep = false } = {}) {
	const base = join(ROOT, ".e2e", "vaults");
	return names.map((name) => {
		const path = join(base, name);
		if (!keep) rmSync(path, { recursive: true, force: true });
		mkdirSync(join(path, ".obsidian"), { recursive: true });
		writeFileSync(
			join(path, ".obsidian", "app.json"),
			JSON.stringify({ trashOption: "local", livePreview: true }),
		);
		for (const [rel, content] of Object.entries(seed[name] ?? {})) {
			mkdirSync(dirname(join(path, rel)), { recursive: true });
			writeFileSync(join(path, rel), content);
		}
		return { name, path };
	});
}

const PLUGIN_FILES = ["main.js", "manifest.json", "styles.css"];

/**
 * Symlinks the built plugin files (`packages/plugin/dist/*`) into a real per-vault plugin folder.
 * Linking the whole `dist` folder would make every vault share one `data.json` (settings).
 */
function installPlugin(vaultPath) {
	const dir = join(vaultPath, ".obsidian", "plugins", "teamsync");
	if (existsSync(dir) && lstatSync(dir).isSymbolicLink()) unlinkSync(dir);
	mkdirSync(dir, { recursive: true });
	for (const file of PLUGIN_FILES) {
		const link = join(dir, file);
		if (!existsSync(link)) symlinkSync(join(ROOT, "packages", "plugin", "dist", file), link);
	}
}

/** True once Obsidian has flushed the vault's enabled-plugin list with `teamsync` in it. */
function pluginEnabledOnDisk(vaultPath) {
	try {
		const ids = JSON.parse(
			readFileSync(join(vaultPath, ".obsidian", "community-plugins.json"), "utf8"),
		);
		return Array.isArray(ids) && ids.includes("teamsync");
	} catch {
		return false;
	}
}

async function cdpAnswers(port) {
	try {
		return (await fetch(`http://127.0.0.1:${port}/json/version`)).ok;
	} catch {
		return false;
	}
}

/** One Obsidian process with one vault window, reachable over CDP. */
export class VaultHandle {
	constructor({ name, path }, { port }) {
		this.name = name;
		this.path = path;
		this.port = port;
		this.id = vaultId(name);
		this.profile = join(ROOT, ".e2e", "profiles", name);
		this.child = null;
		this.ws = null;
		this.nextId = 1;
		this.pending = new Map();
		this.listeners = new Map();
	}

	get running() {
		return this.child !== null && this.child.exitCode === null && this.child.signalCode === null;
	}

	/** Starts Obsidian on this vault's profile and waits for the vault's layout to be ready. */
	async launch() {
		if (this.running) throw new Error(`[${this.name}] already running`);
		if (await cdpAnswers(this.port)) {
			throw new Error(`[${this.name}] CDP port ${this.port} is already in use; set E2E_CDP_PORT`);
		}
		mkdirSync(this.profile, { recursive: true });
		writeFileSync(
			join(this.profile, "obsidian.json"),
			JSON.stringify({ vaults: { [this.id]: { path: this.path, ts: Date.now(), open: true } } }),
		);
		const env = { ...process.env, ...prepareProfile(this.profile, OBSIDIAN_BIN) };
		const child = spawn(
			OBSIDIAN_BIN,
			[
				`--user-data-dir=${this.profile}`,
				`--remote-debugging-port=${this.port}`,
				// Screenshots otherwise come back in the display's colour space (P3 on Macs), which
				// moves saturated colours like #1be7ff past the pixel checks' tolerance.
				"--force-color-profile=srgb",
			],
			{ stdio: "ignore", detached: false, env },
		);
		this.child = child;
		this.exited = new Promise((r) => child.once("exit", r));
		try {
			await this.attach();
		} catch (error) {
			await this.kill();
			throw error;
		}
		return this;
	}

	async attach() {
		const target = await waitFor(
			async () => {
				if (!this.running) throw new Error(`[${this.name}] Obsidian exited during launch`);
				try {
					const list = await (await fetch(`http://127.0.0.1:${this.port}/json/list`)).json();
					// One window per process; the vault window is index.html (the vault picker is starter.html).
					return list.find((t) => t.type === "page" && t.url.includes("/index.html"));
				} catch {
					return null;
				}
			},
			{ timeout: 60000, label: `${this.name} window` },
		);
		await this.connectSocket(target.webSocketDebuggerUrl);
		await this.waitLayoutReady();
		const actual = await this.eval("return { id: app.appId, path: app.vault.adapter.basePath };");
		if (actual.path !== this.path || actual.id !== this.id) {
			throw new Error(`[${this.name}] attached to the wrong vault: ${JSON.stringify(actual)}`);
		}
	}

	async connectSocket(url) {
		const ws = new WebSocket(url);
		await new Promise((res, rej) => {
			ws.addEventListener("open", res, { once: true });
			ws.addEventListener("error", rej, { once: true });
		});
		ws.addEventListener("message", (ev) => {
			const msg = JSON.parse(ev.data);
			if (msg.id === undefined) {
				for (const cb of this.listeners.get(msg.method) ?? []) cb(msg.params);
				return;
			}
			const p = this.pending.get(msg.id);
			if (!p) return;
			this.pending.delete(msg.id);
			if (msg.error) p.reject(new Error(`[${this.name}] ${msg.error.message}`));
			else p.resolve(msg.result);
		});
		ws.addEventListener("close", () => {
			for (const p of this.pending.values()) p.reject(new Error(`[${this.name}] CDP closed`));
			this.pending.clear();
		});
		this.ws = ws;
	}

	/**
	 * Waits for the vault's workspace layout, then enables focus emulation: y-codemirror.next only
	 * publishes a cursor while `document.hasFocus()`, which is false in a background window.
	 * Call again after anything that reloads the page.
	 */
	async waitLayoutReady({ timeout = 30000 } = {}) {
		await waitFor(
			async () => {
				try {
					return await this.eval("return !!globalThis.app?.workspace?.layoutReady");
				} catch {
					return false;
				}
			},
			{ timeout, label: `${this.name} layout ready` },
		);
		await this.cdp("Emulation.setFocusEmulationEnabled", { enabled: true });
	}

	/** Sends a raw CDP command to the vault's page target. */
	cdp(method, params = {}) {
		if (this.ws?.readyState !== WebSocket.OPEN) {
			return Promise.reject(new Error(`[${this.name}] not attached`));
		}
		const id = this.nextId++;
		this.ws.send(JSON.stringify({ id, method, params }));
		return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
	}

	/** Subscribes to a CDP event (enable its domain first); returns unsubscribe. */
	on(method, cb) {
		if (!this.listeners.has(method)) this.listeners.set(method, new Set());
		this.listeners.get(method).add(cb);
		return () => this.listeners.get(method).delete(cb);
	}

	/** Runs `body` (the inside of an async function; `app` and `args` are in scope) and returns its JSON value. */
	async eval(body, args = {}) {
		const expression = `(async (args) => { ${body} })(${JSON.stringify(args)})`;
		const r = await this.cdp("Runtime.evaluate", {
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

	detach() {
		this.ws?.close();
		this.ws = null;
	}

	async stopProcess(signal) {
		this.detach();
		if (!this.running) return;
		this.child.kill(signal);
		const done = await Promise.race([this.exited.then(() => true), sleep(15000).then(() => false)]);
		if (!done) {
			this.child.kill("SIGKILL");
			await this.exited;
		}
		await waitFor(async () => !(await cdpAnswers(this.port)), {
			timeout: 10000,
			label: `${this.name} CDP port released`,
		});
		// Electron helpers (renderer, GPU) can outlive a SIGKILLed main process for a moment.
		await waitFor(() => this.processes().length === 0, {
			timeout: 10000,
			label: `${this.name} helper processes gone`,
		});
	}

	/** Pids of every process (main and helpers) running on this vault's profile. */
	processes() {
		const r = spawnSync("pgrep", ["-f", `--user-data-dir=${this.profile}`], { encoding: "utf8" });
		return r.stdout.split("\n").filter(Boolean).map(Number);
	}

	/** Graceful quit (SIGTERM); waits for the process to exit. */
	quit() {
		return this.stopProcess("SIGTERM");
	}

	/** Hard kill (SIGKILL), e.g. to simulate a crash. */
	kill() {
		return this.stopProcess("SIGKILL");
	}

	/** Restarts the same profile with the same vault id, reattaches and waits for layoutReady. */
	async relaunch() {
		if (this.running) await this.quit();
		return this.launch();
	}
}

/** Launches one vault in its own Obsidian process. */
export function launchVault(vault, { port }) {
	return new VaultHandle(vault, { port }).launch();
}

/**
 * Launches one Obsidian process per vault (CDP port `E2E_CDP_PORT` + index) and returns
 * `{vaults: {[name]: VaultHandle}, close}`.
 */
export async function launchObsidian(vaultDirs, { port = CDP_PORT_BASE } = {}) {
	const handles = vaultDirs.map((v, i) => new VaultHandle(v, { port: port + i }));
	const close = async () => {
		await Promise.all(handles.map((h) => h.quit()));
	};
	const results = await Promise.allSettled(handles.map((h) => h.launch()));
	const failed = results.find((r) => r.status === "rejected");
	if (failed) {
		await close();
		throw failed.reason;
	}
	return { vaults: Object.fromEntries(handles.map((h) => [h.name, h])), close };
}

/** Waits until the plugin reports `connected`, e.g. after a relaunch with `autoConnect`. */
export async function waitConnected(vault, { timeout = 20000 } = {}) {
	let last = null;
	try {
		return await waitFor(
			async () => {
				last = await vault.eval(
					`const p = app.plugins.plugins.teamsync;
					return p ? { status: p.connection?.status ?? null, message: p.connection?.message ?? null,
						autoConnect: p.settings?.autoConnect, hasSession: !!p.secrets?.get?.() } : { plugin: "not loaded" };`,
				);
				return last?.status === "connected";
			},
			{ timeout, label: `${vault.name} connected` },
		);
	} catch {
		throw new Error(
			`timed out waiting for ${vault.name} connected (last state: ${JSON.stringify(last)})`,
		);
	}
}

/**
 * Installs the plugin, turns off restricted mode, loads the plugin, points it at `serverUrl`, logs in as `name`,
 * connects, and turns on `autoConnect` so a relaunch reconnects with the stored session.
 * `role` is written to `devLoginRole`. `sharedFolder` is a vault folder path (e.g. "Shared"),
 * written as `{path, workspaceId: ""}` so the plugin binds it to the workspace it connects to;
 * `null` unmaps. Leave either undefined to keep the vault's current setting.
 */
export async function connectPlugin(vault, { serverUrl, name, role, sharedFolder }) {
	installPlugin(vault.path);
	if (typeof sharedFolder === "string") sharedFolder = { path: sharedFolder, workspaceId: "" };
	const result = await vault.eval(
		`
		await app.plugins.loadManifests();
		if (!app.plugins.isEnabled()) await app.plugins.setEnable(true);
		if (!app.plugins.plugins.teamsync) await app.plugins.enablePluginAndSave("teamsync");
		const p = app.plugins.plugins.teamsync;
		if (!p) throw new Error("teamsync plugin did not load");
		p.settings.serverUrl = args.serverUrl;
		p.settings.devLoginName = args.name;
		p.settings.autoConnect = true;
		if (args.role !== undefined) p.settings.devLoginRole = args.role;
		if (args.sharedFolder !== undefined) p.settings.sharedFolder = args.sharedFolder;
		await p.saveSettings();
		await p.connect();
		for (let i = 0; i < 75 && p.connection?.status !== "connected"; i++) await new Promise(r => setTimeout(r, 200));
		return { status: p.connection?.status, message: p.connection?.message ?? null, user: p.settings.user?.name ?? null };
	`,
		{ serverUrl, name, role, sharedFolder },
	);
	// Obsidian writes `community-plugins.json` a few seconds after `enablePluginAndSave`. A quit
	// inside that window loses it, and the relaunched vault never loads the plugin.
	await waitFor(() => pluginEnabledOnDisk(vault.path), {
		timeout: 15000,
		label: `${vault.name} community-plugins.json lists teamsync`,
	});
	return result;
}
