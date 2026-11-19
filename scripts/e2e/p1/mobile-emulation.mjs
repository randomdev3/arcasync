// P1-10: what desktop Obsidian's mobile emulation can prove. bob runs `app.emulateMobile(true)`
// (the page reloads, the plugin restarts with mobile limits and reconnects with its stored
// session), then: typing in both directions reaches the other editor and disk, presence avatars
// show both ways, 30 notes opened in sequence keep at most warmDocs + 1 docs attached, an IME
// composition commits once, and a note over the mobile size limit is skipped with a warning.
// Everything needing a real phone is listed in docs/testing.md.
//
// emulateMobile's flag lives in the Obsidian PROFILE, not the vault: `finally` always switches
// bob back, and an interrupted run needs `.e2e/profiles/bob` deleted.
import assert from "node:assert/strict";
import { join } from "node:path";
import { diskText, editorText, openFile, screenshot, setCursor, typeKeys } from "../editor.mjs";
import { sleep, waitConnected, waitFor } from "../obsidian.mjs";

const NAME = "mobile-emulation";
const DIR = `Shared/${NAME}`;
const M = `${DIR}/m.md`;
const BIG = `${DIR}/big.md`;
const SEED = "Mobile line\n";
const NOTES = Array.from({ length: 30 }, (_, i) => `${DIR}/n/n${String(i).padStart(2, "0")}.md`);
const MOBILE_LIMITS = {
	warmDocs: 5,
	bgConcurrency: 1,
	maxMdBytes: 2 * 1024 * 1024,
	maxBaseBytes: 256 * 1024,
	maxBinaryBytes: 50 * 1024 * 1024,
};
/** Over the 2 MiB mobile limit. */
const BIG_BYTES = 2.5 * 1024 * 1024;

const LIVE = `return !!app.workspace.activeEditor?.editor?.cm?.dom.classList.contains("teamsync-live")
	&& app.workspace.getActiveFile()?.path === args.path;`;
const AVATAR = `
	const leaf = app.workspace.getLeavesOfType("markdown").find((l) => l.view.file?.path === args.path);
	const sel = '.view-header .teamsync-facepile .teamsync-avatar[data-user-id="' + CSS.escape(args.userId) + '"]';
	return leaf?.view.containerEl.querySelector(sel)?.dataset.state ?? null;
`;
const USER_ID = "return app.plugins.plugins.teamsync.settings.user.id;";
const HEAP = "return performance.memory?.usedJSHeapSize ?? null;";
const ATTACHED = "return app.plugins.plugins.teamsync.session.docs.attachedCount();";

function waitLive(v, path) {
	return waitFor(() => v.eval(LIVE, { path }), {
		timeout: 15000,
		label: `${v.name}: bound editor on ${path}`,
	});
}

async function waitText(vaults, path, ok, label, { timeout = 5000, disk = false } = {}) {
	await waitFor(
		async () => {
			for (const v of vaults) {
				const text = await v.eval(
					`return app.workspace.getLeavesOfType("markdown")
						.find((l) => l.view.file?.path === args.path)?.view.editor.getValue() ?? null;`,
					{ path },
				);
				if (text === null || !ok(text)) return false;
				if (disk && !ok(diskText(v.path, path) ?? "")) return false;
			}
			return true;
		},
		{
			timeout,
			label: `${vaults.map((v) => v.name)} ${disk ? "editors and disks" : "editors"}: ${label}`,
		},
	);
}

function closeLeaves(v) {
	return v.eval(
		`for (const leaf of app.workspace.getLeavesOfType("markdown")) leaf.detach(); return true;`,
	);
}

function count(text, word) {
	return text.split(word).length - 1;
}

/**
 * Toggles `app.emulateMobile` and waits for the reload it causes, the layout and the plugin's
 * reconnect (autoConnect with the stored session). Returns how many contexts were cleared.
 */
async function emulateMobile(v, on) {
	await v.cdp("Runtime.enable");
	let cleared = 0;
	const off = v.on("Runtime.executionContextsCleared", () => cleared++);
	try {
		// Deferred: the reload must not tear down the context while this evaluation answers.
		await v.eval("setTimeout(() => app.emulateMobile(args.on), 0); return true;", { on });
		await waitFor(() => cleared > 0, { timeout: 15000, label: `${v.name} page reload` });
		await sleep(1000);
		await v.waitLayoutReady();
		await waitConnected(v, { timeout: 30000 });
		assert.equal(await v.eval("return app.isMobile;"), on, `${v.name} app.isMobile`);
		return cleared;
	} finally {
		off();
	}
}

/** Collects TeamSync console errors (call after the reload); returns `stop()` which yields them. */
async function watchErrors(v) {
	const errors = [];
	await v.cdp("Runtime.enable");
	const off = v.on("Runtime.consoleAPICalled", (e) => {
		const text = e.args.map((a) => a.value ?? a.description ?? "").join(" ");
		if (e.type === "error" && text.includes("TeamSync")) errors.push(text);
	});
	return () => {
		off();
		return errors;
	};
}

export default {
	name: NAME,
	needs: ["alice", "bob"],
	seed: {
		alice: {
			[M]: SEED,
			...Object.fromEntries(NOTES.map((p, i) => [p, `Note ${i}\n`])),
		},
	},
	async run({ vaults, step, artifacts, server }) {
		const { alice, bob } = vaults;
		await waitFor(
			() => diskText(bob.path, M) === SEED && NOTES.every((p) => diskText(bob.path, p) !== null),
			{ timeout: 30000, label: "bob has m.md and the 30 notes" },
		);
		const [aliceId, bobId] = [await alice.eval(USER_ID), await bob.eval(USER_ID)];
		let stopErrors = () => [];
		let mobile = false;
		try {
			// 1. Emulated mobile: reload, mobile limits, reconnect with the stored session.
			const heapDesktop = await bob.eval(HEAP);
			const cleared = await emulateMobile(bob, true);
			mobile = true;
			stopErrors = await watchErrors(bob);
			const state = await bob.eval(`
				const p = app.plugins.plugins.teamsync;
				return {
					bodyMobile: document.body.classList.contains("is-mobile"),
					status: p.connection.status,
					limits: p.limits(),
					warmDocs: p.session.docs.options.warmDocs,
					maxBytes: p.session.docs.options.maxBytes,
				};`);
			assert.equal(state.bodyMobile, true, "body.is-mobile");
			assert.equal(state.status, "connected");
			assert.deepEqual(state.limits, MOBILE_LIMITS);
			assert.equal(state.warmDocs, 5, "the session's DocManager runs with the mobile LRU");
			assert.equal(state.maxBytes, MOBILE_LIMITS.maxMdBytes, "and the mobile size limit");
			const heapMobile = await bob.eval(HEAP);
			step(
				`bob emulates mobile (page reloads: ${cleared} context(s) cleared), reconnected with its stored session, limits ${JSON.stringify(state.limits)}`,
			);

			// 2. Coedit both ways.
			await openFile(alice, M);
			await openFile(bob, M);
			await Promise.all([waitLive(alice, M), waitLive(bob, M)]);
			await setCursor(alice, { line: 0, ch: 11 });
			await typeKeys(alice, " alice");
			await waitText([alice, bob], M, (t) => t === "Mobile line alice\n", "alice's typing");
			await setCursor(bob, { line: 0, ch: 17 });
			await typeKeys(bob, " bob");
			let expected = "Mobile line alice bob\n";
			await waitText([alice, bob], M, (t) => t === expected, "bob's typing");
			await sleep(2500);
			await waitText([alice, bob], M, (t) => t === expected, "on disk", { disk: true });
			step("desktop alice → mobile bob and back: both editors and both disks converge");

			// 3. Presence both ways in the view header.
			await waitFor(async () => (await alice.eval(AVATAR, { path: M, userId: bobId })) === "here", {
				timeout: 5000,
				label: "alice sees mobile bob here",
			});
			await waitFor(async () => (await bob.eval(AVATAR, { path: M, userId: aliceId })) === "here", {
				timeout: 5000,
				label: "mobile bob sees alice here",
			});
			await screenshot(bob, join(artifacts, "bob-mobile.png"));
			step("presence: each sees the other's avatar 'here' in the m.md header (mobile layout too)");

			// 4. IME: a composition (preedit にほ) committed as 日本 lands exactly once.
			await bob.eval(`
				window.__tsIme = { start: 0, end: 0 };
				document.addEventListener("compositionstart", () => window.__tsIme.start++, true);
				document.addEventListener("compositionend", () => window.__tsIme.end++, true);
				return true;`);
			await setCursor(bob, { line: 0, ch: expected.length - 1 });
			await bob.cdp("Input.imeSetComposition", {
				text: "にほ",
				selectionStart: 2,
				selectionEnd: 2,
			});
			await sleep(300);
			await bob.cdp("Input.insertText", { text: "日本" });
			const ime = await bob.eval("return window.__tsIme;");
			assert.ok(ime.start >= 1 && ime.end >= 1, `composition events: ${JSON.stringify(ime)}`);
			expected = "Mobile line alice bob日本\n";
			await waitText([alice, bob], M, (t) => t === expected, "IME commit");
			await sleep(2500);
			await waitText([alice, bob], M, (t) => t === expected, "IME commit on disk", { disk: true });
			for (const v of [alice, bob]) {
				const text = await editorText(v);
				assert.equal(count(text, "日本"), 1, `${v.name}: 日本 once`);
				assert.equal(count(text, "にほ"), 0, `${v.name}: no preedit residue`);
			}
			step(
				`IME: compositionstart/end ${ime.start}/${ime.end}, 日本 exactly once in both editors and disks`,
			);

			// 5. 30 notes opened in sequence keep at most warmDocs + 1 attached.
			await closeLeaves(alice);
			await waitFor(async () => (await bob.eval(ATTACHED)) <= 6, {
				timeout: 15000,
				label: "bob's background sync settled",
			});
			let peak = 0;
			for (const path of NOTES) {
				await openFile(bob, path);
				await waitLive(bob, path);
				peak = Math.max(peak, await bob.eval(ATTACHED));
				// Eviction waits for the relay's ack, so a moment above the cap is allowed.
				await waitFor(async () => (await bob.eval(ATTACHED)) <= MOBILE_LIMITS.warmDocs + 1, {
					timeout: 5000,
					label: `bob attached ≤ 6 after opening ${path}`,
				});
			}
			const attached = await bob.eval(ATTACHED);
			assert.ok(attached <= 6, `attached ${attached} > 6`);
			step(
				`30 notes opened in sequence: ${attached} attached at the end (peak right after a bind: ${peak})`,
			);

			// 6. A note over the 2 MiB mobile limit is skipped with a warning, never uploaded.
			await bob.eval(
				`await app.vault.create(args.path, "x".repeat(args.n) + "\\n"); return true;`,
				{ path: BIG, n: BIG_BYTES },
			);
			await waitFor(
				async () =>
					(
						await bob.eval(
							'return [...document.querySelectorAll(".notice")].map((n) => n.textContent);',
						)
					).some((t) => t.includes(`${BIG} is larger than 2 MiB`)),
				{ timeout: 15000, label: "bob warns that big.md is too large" },
			);
			// The path syncs (index entry), the content does not: alice gets an empty file.
			await waitFor(() => diskText(alice.path, BIG) !== null, {
				timeout: 15000,
				label: "alice has big.md's index entry",
			});
			await openFile(bob, BIG);
			await sleep(3000);
			const big = await bob.eval(
				`const p = app.plugins.plugins.teamsync;
				const id = p.session.fileIdOf(args.path);
				return {
					id,
					attached: !!(id && p.session.docs.peek(id)),
					live: !!app.workspace.activeEditor?.editor?.cm?.dom.classList.contains("teamsync-live"),
					length: app.workspace.activeEditor?.editor?.getValue().length ?? null,
				};`,
				{ path: BIG },
			);
			assert.ok(big.id, "big.md is indexed");
			assert.equal(big.attached, false, "bob never attached big.md's doc");
			assert.equal(big.live, false, "bob's editor on big.md is not bound");
			assert.equal(big.length, BIG_BYTES + 1, "bob's editor shows the local file");
			assert.equal(diskText(alice.path, BIG), "", "alice's big.md stays empty");
			assert.equal(diskText(bob.path, BIG).length, BIG_BYTES + 1, "bob's big.md is untouched");
			if (server.backend === "cf") {
				const ws = await bob.eval("return app.plugins.plugins.teamsync.settings.workspaceId;");
				const r = await fetch(
					`${server.url}/api/debug/doc?ws=${encodeURIComponent(ws)}&doc=${encodeURIComponent(`ws:${ws}:md:${big.id}`)}`,
				);
				if (!r.ok) throw new Error(`debug doc: HTTP ${r.status}`);
				const doc = await r.json();
				// An empty doc's state is the 2-byte empty update.
				assert.ok(
					doc.tailRows === 0 && doc.stateBytes <= 2 && Object.keys(doc.rowsByUser).length === 0,
					`relay holds no big.md content: ${JSON.stringify(doc)}`,
				);
			}
			step("2.5 MiB note on mobile: Notice, no doc attached, editor unbound, nothing uploaded");

			// 7. Idle mobile: no polling traffic, no rows.
			await closeLeaves(bob);
			if (server.backend === "cf") {
				const ws = await bob.eval("return app.plugins.plugins.teamsync.settings.workspaceId;");
				const stats = async () => {
					const r = await fetch(`${server.url}/api/debug/stats?ws=${encodeURIComponent(ws)}`);
					if (!r.ok) throw new Error(`debug stats: HTTP ${r.status}`);
					return r.json();
				};
				await sleep(3000);
				const before = await stats();
				await sleep(15000);
				const after = await stats();
				const msgs = after.msgs_in - before.msgs_in;
				const rows = after.app_rows_written - before.app_rows_written;
				assert.equal(rows, 0, `rows written in 15 s idle: ${rows}`);
				// Presence renewals (120 s) may land in the window; polling would add far more.
				assert.ok(msgs <= 4, `inbound messages in 15 s idle: ${msgs}`);
				step(`idle 15 s with mobile bob: ${msgs} inbound messages, 0 rows`);
			}

			const heapAfter = await bob.eval(HEAP);
			const mb = (n) => (n === null ? "n/a" : `${(n / 1048576).toFixed(1)} MB`);
			step(
				`bob JS heap: desktop ${mb(heapDesktop)}, mobile after reload ${mb(heapMobile)}, after the scenario ${mb(heapAfter)}`,
			);
			assert.deepEqual(stopErrors(), [], "TeamSync console errors on mobile bob");
		} finally {
			stopErrors();
			for (const v of [alice, bob]) if (v.running) await closeLeaves(v).catch(() => {});
			if (bob.running && (mobile || (await bob.eval("return app.isMobile;").catch(() => false)))) {
				await emulateMobile(bob, false);
				assert.equal(
					(await bob.eval("return app.plugins.plugins.teamsync.limits();")).warmDocs,
					20,
				);
				step("bob back on desktop limits");
			}
		}
	},
};
