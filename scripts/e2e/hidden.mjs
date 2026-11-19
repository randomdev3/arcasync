// Keeps e2e Obsidian windows out of the way: invisible, click-through, never focused, no Dock icon.
//
// Obsidian's launcher (Resources/app.asar) loads the newest `obsidian-<version>.asar` it finds in the
// user-data dir. Each test vault has its own user-data dir, so the harness drops a tiny shim asar
// there with a version no real release reaches. The shim runs first in the main process, patches
// BrowserWindow, then loads the real Obsidian package. The user's own Obsidian and profile are never
// touched; the shim's high version also stops the test profiles from downloading updates.
//
// The renderer still paints normally (background throttling is off), so CDP screenshots, typing
// and focus emulation behave as with a visible window. Set E2E_VISIBLE=1 to see the windows.
import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const HIDDEN = process.env.E2E_VISIBLE !== "1";
const SHIM_NAME = "obsidian-9999.0.0.asar";

const SHIM_MAIN = `
const { app, BrowserWindow } = require("electron");
for (const s of ["disable-backgrounding-occluded-windows", "disable-renderer-backgrounding", "disable-background-timer-throttling"]) {
	app.commandLine.appendSwitch(s);
}
if (app.dock) app.dock.hide();
const proto = BrowserWindow.prototype;
proto.show = function () {
	this.setOpacity(0);
	this.setIgnoreMouseEvents(true);
	this.setSkipTaskbar(true);
	this.showInactive();
};
proto.focus = function () {};
proto.moveTop = function () {};
app.focus = function () {};
const real = process.env.ARCASYNC_E2E_OBSIDIAN_ASAR;
module.exports = (_asarPath, updateEvents) => require(real + "/main.js")(real, updateEvents);
`;

/** Packs `{name: string}` into an asar archive (the Chromium-pickle header + concatenated files). */
function packAsar(files) {
	const entries = {};
	const bodies = [];
	let offset = 0;
	for (const [name, text] of Object.entries(files)) {
		const body = Buffer.from(text);
		entries[name] = { size: body.length, offset: String(offset) };
		bodies.push(body);
		offset += body.length;
	}
	const json = Buffer.from(JSON.stringify({ files: entries }));
	const padded = Math.ceil(json.length / 4) * 4;
	const header = Buffer.alloc(8 + padded);
	header.writeUInt32LE(4 + padded, 0); // pickle payload size
	header.writeInt32LE(json.length, 4); // string length
	json.copy(header, 8);
	const size = Buffer.alloc(8);
	size.writeUInt32LE(4, 0);
	size.writeUInt32LE(header.length, 4);
	return Buffer.concat([size, header, ...bodies]);
}

const versionOf = (file) => /^obsidian-(\d+(?:\.\d+)*)\.asar$/.exec(file)?.[1] ?? null;

function newer(a, b) {
	const pa = a.split(".").map(Number);
	const pb = b.split(".").map(Number);
	for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
		if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) > (pb[i] ?? 0);
	}
	return false;
}

/**
 * The real Obsidian package to run: the newest one the user's own Obsidian or this profile has
 * downloaded (read-only), else the one bundled with the app.
 */
function realAsar(profile, appResources) {
	const plist = readFileSync(join(appResources, "..", "Info.plist"), "utf8");
	const bundled =
		/<key>CFBundleShortVersionString<\/key>\s*<string>([^<]+)<\/string>/.exec(plist)?.[1] ?? "0";
	let best = { version: bundled, path: join(appResources, "obsidian.asar") };
	const dirs = [profile, join(homedir(), "Library", "Application Support", "obsidian")];
	for (const dir of dirs) {
		if (!existsSync(dir)) continue;
		for (const file of readdirSync(dir)) {
			const version = versionOf(file);
			if (!version || file === SHIM_NAME) continue;
			if (newer(version, best.version)) best = { version, path: join(dir, file) };
		}
	}
	return best.path;
}

/**
 * Installs (or, with E2E_VISIBLE=1, removes) the shim in `profile` and returns the env the
 * Obsidian process needs.
 */
export function prepareProfile(profile, obsidianBin) {
	const shim = join(profile, SHIM_NAME);
	if (!HIDDEN) {
		rmSync(shim, { force: true });
		return {};
	}
	writeFileSync(shim, packAsar({ "main.js": SHIM_MAIN }));
	const resources = join(obsidianBin, "..", "..", "Resources");
	return { ARCASYNC_E2E_OBSIDIAN_ASAR: realAsar(profile, resources) };
}
