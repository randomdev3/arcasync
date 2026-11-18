// Proves the e2e harness itself: one Obsidian process per vault with a stable vault id across
// quit/relaunch (session and storage survive, a new run starts clean), focus emulation, real key
// events, screenshots, and what `app.emulateMobile` does to the page.
import assert from "node:assert/strict";
import { statSync } from "node:fs";
import { editorText, openFile, readPng, replaceRange, screenshot, typeKeys } from "./editor.mjs";
import {
	connectPlugin,
	launchObsidian,
	prepareVaults,
	sleep,
	waitConnected,
	waitFor,
} from "./obsidian.mjs";
import { startServer } from "./server.mjs";

const step = (msg) => console.log(`  ✓ ${msg}`);
const MARKER = "return 'teamsync-smoke:' + app.appId;";

const IDB_PUT = `
	const db = await new Promise((res, rej) => {
		const r = indexedDB.open("teamsync-smoke-" + app.appId, 1);
		r.onupgradeneeded = () => r.result.createObjectStore("kv");
		r.onsuccess = () => res(r.result);
		r.onerror = () => rej(r.error);
	});
	await new Promise((res, rej) => {
		const tx = db.transaction("kv", "readwrite");
		tx.objectStore("kv").put(args.value, "marker");
		tx.oncomplete = res;
		tx.onerror = () => rej(tx.error);
	});
	db.close();
	return true;
`;
const IDB_GET = `
	const db = await new Promise((res, rej) => {
		const r = indexedDB.open("teamsync-smoke-" + app.appId, 1);
		r.onupgradeneeded = () => r.result.createObjectStore("kv");
		r.onsuccess = () => res(r.result);
		r.onerror = () => rej(r.error);
	});
	const value = await new Promise((res, rej) => {
		const r = db.transaction("kv").objectStore("kv").get("marker");
		r.onsuccess = () => res(r.result ?? null);
		r.onerror = () => rej(r.error);
	});
	db.close();
	return value;
`;

const server = await startServer();
const [a, b] = prepareVaults(["smoke-alice", "smoke-bob"]);
const obsidian = await launchObsidian([a, b]);
const { "smoke-alice": alice, "smoke-bob": bob } = obsidian.vaults;

try {
	for (const v of [alice, bob]) {
		assert.equal(
			await v.eval("return app.isMobile;"),
			false,
			`${v.name} starts in mobile mode (an interrupted run left it on; delete ${v.profile})`,
		);
	}
	step("one Obsidian process per vault, both desktop");

	// --- quit / relaunch keeps the vault id, storage and session ---------------------------
	const r = await connectPlugin(bob, { serverUrl: server.url, name: "bob" });
	assert.equal(r.status, "connected", JSON.stringify(r));
	const bobUserId = await bob.eval("return app.plugins.plugins.teamsync.settings.user.id;");
	const idBefore = await bob.eval("return app.appId;");
	assert.equal(idBefore, bob.id);
	const markerKey = await bob.eval(MARKER);
	assert.equal(
		await bob.eval("return localStorage.getItem(args.k);", { k: markerKey }),
		null,
		"a fresh run must not see a previous run's storage",
	);
	await bob.eval("localStorage.setItem(args.k, 'kept'); return true;", { k: markerKey });
	await bob.eval(IDB_PUT, { value: "kept-idb" });

	await bob.quit();
	assert.equal(bob.running, false);
	await bob.relaunch();
	assert.equal(await bob.eval("return app.appId;"), idBefore, "vault id changed on relaunch");
	assert.equal(await bob.eval("return localStorage.getItem(args.k);", { k: markerKey }), "kept");
	assert.equal(await bob.eval(IDB_GET), "kept-idb");
	await waitConnected(bob);
	assert.equal(
		await bob.eval("return app.plugins.plugins.teamsync.settings.user.id;"),
		bobUserId,
		"relaunch should reuse the stored session",
	);
	step("bob quit + relaunch: same vault id, localStorage + IndexedDB kept, session reconnects");

	await bob.kill();
	assert.deepEqual(bob.processes(), [], "bob processes survived SIGKILL");
	await bob.relaunch();
	assert.equal(await bob.eval("return app.appId;"), idBefore, "vault id changed after kill");
	await waitConnected(bob);
	step("bob SIGKILL: no process left on its profile; relaunch keeps the id and reconnects");

	// --- focus emulation ------------------------------------------------------------------
	for (const v of [alice, bob]) {
		assert.equal(await v.eval("return document.hasFocus();"), true, `${v.name} hasFocus`);
	}
	step("document.hasFocus() is true in both windows");

	// --- real key events --------------------------------------------------------------------
	await alice.eval("await app.vault.create('typed.md', ''); return true;");
	await openFile(alice, "typed.md");
	await alice.eval(`
		window.__smokeKeydowns = 0;
		document.addEventListener("keydown", () => window.__smokeKeydowns++, true);
		app.workspace.activeEditor.editor.cm.focus();
		return true;
	`);
	const typed = "Hello world\nline 2";
	await typeKeys(alice, typed, { cps: 20 });
	await waitFor(async () => (await editorText(alice)) === typed, { label: "typed text" });
	assert.equal(await alice.eval("return window.__smokeKeydowns;"), typed.length);
	await replaceRange(alice, "!", { line: 1, ch: 6 });
	assert.equal(await editorText(alice), `${typed}!`);
	assert.equal(await alice.eval("return window.__smokeKeydowns;"), typed.length);
	step(`typeKeys fired ${typed.length} keydowns; replaceRange fired none`);

	// --- screenshot -----------------------------------------------------------------------
	const shot = await screenshot(alice, "smoke/alice.png");
	const png = readPng(shot);
	assert.ok(statSync(shot).size > 10_000, `screenshot is ${statSync(shot).size} bytes`);
	assert.ok(png.width > 100 && png.height > 100, `screenshot is ${png.width}x${png.height}`);
	step(`screenshot ${shot} (${png.width}x${png.height}, ${statSync(shot).size} bytes)`);

	// --- emulateMobile probe (last: it reloads bob's page) ---------------------------------
	await bob.cdp("Runtime.enable");
	let cleared = 0;
	const off = bob.on("Runtime.executionContextsCleared", () => cleared++);
	try {
		await bob.eval("setTimeout(() => app.emulateMobile(true), 0); return true;");
		await sleep(3000);
		await bob.waitLayoutReady();
		const afterToggle = await bob.eval("return app.isMobile;");
		await bob.relaunch();
		const afterRelaunch = await bob.eval("return app.isMobile;");
		console.log(
			`  emulateMobile probe: reloads page=${cleared > 0} (executionContextsCleared ×${cleared}), ` +
				`isMobile after toggle=${afterToggle}, isMobile after relaunch=${afterRelaunch}`,
		);
		assert.equal(afterToggle, true, "emulateMobile(true) did not take effect");
	} finally {
		off();
		if (!bob.running) await bob.launch();
		await bob.eval("setTimeout(() => app.emulateMobile(false), 0); return true;");
		await sleep(3000);
		await bob.waitLayoutReady();
		assert.equal(await bob.eval("return app.isMobile;"), false, "emulateMobile(false) failed");
	}
	step("emulateMobile probe done, bob back on desktop");
	console.log("smoke-harness: PASS");
} finally {
	await obsidian.close();
	await server.stop();
}
