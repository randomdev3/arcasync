// P1-7: jump to a user and follow them. alice jumps to bob's caret (API and avatar click), follows
// bob across notes and caret moves (shift-click and the "Follow user…" command), and the follow
// stops when alice types, when bob disconnects and when bob quits.
import assert from "node:assert/strict";
import { join } from "node:path";
import {
	activeFile,
	isLineVisible,
	notices,
	openFile,
	pressKey,
	screenshot,
	setCursor,
	typeKeys,
} from "../editor.mjs";
import { sleep, waitConnected, waitFor } from "../obsidian.mjs";

const NAME = "navigator";
const DIR = `Shared/${NAME}`;
const FAR = `${DIR}/far.md`;
const HOME = `${DIR}/home.md`;
const HOPS = [1, 2, 3].map((n) => `${DIR}/f${n}.md`);
const FAR_TEXT = Array.from({ length: 200 }, (_, i) => `Line ${i}`)
	.join("\n")
	.concat("\n");

const USER_ID = "return app.plugins.plugins.arcasync.settings.user.id;";
const HAS_FILE = "return !!app.vault.getAbstractFileByPath(args.path);";
const FOLLOWING = "return app.plugins.plugins.arcasync.session?.navigator?.following ?? null;";
const BADGE = 'return document.querySelector(".arcasync-follow-badge")?.textContent ?? null;';
/** Workspace path of `userId`'s note as this vault's presence sees it (null: none or offline). */
const PEER_FILE = `
	const devices = app.plugins.plugins.arcasync.session?.presence?.users().get(args.userId);
	return devices?.[0]?.file ?? null;
`;
const PEER_FOLLOWING = `
	const devices = app.plugins.plugins.arcasync.session?.presence?.users().get(args.userId);
	return devices?.[0]?.following ?? null;
`;
/** Where 0-based `line` sits in the active editor's viewport: 0 = top edge, 1 = bottom edge. */
const LINE_FRACTION = `
	const cm = app.workspace.activeEditor.editor.cm;
	const c = cm.coordsAtPos(cm.state.doc.line(args.line + 1).from);
	const r = cm.scrollDOM.getBoundingClientRect();
	return c ? ((c.top + c.bottom) / 2 - r.top) / r.height : null;
`;
/** Clicks the avatar of `userId` in the header of the active note's view. */
const CLICK_AVATAR = `
	const view = app.workspace.activeLeaf?.view;
	const sel = '.view-header .arcasync-facepile .arcasync-avatar[data-user-id="' + CSS.escape(args.userId) + '"]';
	const el = view?.containerEl.querySelector(sel);
	if (!el) return false;
	if (args.shift) el.dispatchEvent(new MouseEvent("click", { bubbles: true, shiftKey: true }));
	else el.click();
	return true;
`;
const LIVE =
	'return !!app.workspace.activeEditor?.editor?.cm?.dom.classList.contains("arcasync-live");';
/** Counts alice's own awareness changes on the index doc and on every attached note. */
const COUNT_OWN = `
	const s = app.plugins.plugins.arcasync.session;
	globalThis.__arcasyncOwn?.off();
	const c = { n: 0, offs: [] };
	const watch = (a) => {
		const on = ({ added, updated, removed }) => {
			if ([...added, ...updated, ...removed].includes(a.clientID)) c.n++;
		};
		a.on("change", on);
		c.offs.push(() => a.off("change", on));
	};
	watch(s.awareness);
	for (const h of app.plugins.plugins.arcasync.connections.docs.values()) if (h.provider.awareness) watch(h.provider.awareness);
	c.off = () => c.offs.forEach((f) => f());
	globalThis.__arcasyncOwn = c;
	return true;
`;
const OWN_COUNT = "const c = globalThis.__arcasyncOwn; c.off(); return c.n;";
/** Right-clicks `userId`'s avatar in the active view's header (dispatched on the element itself:
 * the notices in the top right may cover it). */
const AVATAR_MENU = `
	const view = app.workspace.activeLeaf?.view;
	const sel = '.view-header .arcasync-facepile .arcasync-avatar[data-user-id="' + CSS.escape(args.userId) + '"]';
	const el = view?.containerEl.querySelector(sel);
	if (!el) return false;
	const r = el.getBoundingClientRect();
	const init = { bubbles: true, cancelable: true, button: 2, clientX: r.x + r.width / 2, clientY: r.y + r.height / 2 };
	el.dispatchEvent(new MouseEvent("contextmenu", init));
	return true;
`;
const MENU_CLICK = `
	const item = [...document.querySelectorAll(".menu .menu-item")].find((i) => i.textContent.trim() === args.title);
	if (!item) return false;
	item.click();
	return true;
`;
const BADGE_STOP = `
	const b = document.querySelector(".arcasync-follow-badge .arcasync-follow-stop");
	if (!b) return false;
	b.click();
	return true;
`;
const FOCUS_EDITOR = "app.workspace.activeEditor.editor.cm.focus(); return true;";

/** Waits until the active editor is bound to its note (y-codemirror publishes carets from then). */
function waitLive(v) {
	return waitFor(() => v.eval(LIVE), {
		timeout: 5000,
		interval: 50,
		label: `${v.name} editor bound`,
	});
}

/**
 * Puts `v`'s caret on `line` of its bound editor and waits out the provider's awareness batch
 * (FLUSH_DELAY_MS = 1 s), so peers have the caret before the step goes on.
 */
async function placeCaret(v, line) {
	await waitLive(v);
	await setCursor(v, { line, ch: 0 });
	await sleep(1500);
}

async function waitActive(v, path, { timeout = 3000 } = {}) {
	const t0 = Date.now();
	await waitFor(async () => (await activeFile(v)) === path, {
		timeout,
		interval: 50,
		label: `${v.name} shows ${path}`,
	});
	return Date.now() - t0;
}

async function waitLine(v, line, { timeout = 3000 } = {}) {
	const t0 = Date.now();
	await waitFor(() => isLineVisible(v, line), {
		timeout,
		interval: 50,
		label: `${v.name} shows line ${line}`,
	});
	return Date.now() - t0;
}

async function waitFollowing(v, expected, { timeout = 3000, label } = {}) {
	const t0 = Date.now();
	await waitFor(async () => (await v.eval(FOLLOWING)) === expected, {
		timeout,
		interval: 50,
		label: label ?? `${v.name} following ${expected}`,
	});
	return Date.now() - t0;
}

/** Waits until `v`'s presence sees `userId` on `vaultPath`. */
function waitPeerOn(v, userId, vaultPath) {
	const file = vaultPath.slice("Shared/".length);
	return waitFor(async () => (await v.eval(PEER_FILE, { userId })) === file, {
		timeout: 5000,
		interval: 50,
		label: `${v.name} sees ${userId} on ${file}`,
	});
}

export default {
	name: NAME,
	needs: ["alice", "bob"],
	seed: {
		alice: {
			[FAR]: FAR_TEXT,
			[HOME]: "Home\n",
			...Object.fromEntries(HOPS.map((p, i) => [p, `Hop ${i + 1}\n`])),
		},
	},
	async run(ctx) {
		const { alice, bob } = ctx.vaults;
		const bobId = await bob.eval(USER_ID);
		const aliceId = await alice.eval(USER_ID);
		for (const path of [FAR, HOME, ...HOPS]) {
			await waitFor(() => bob.eval(HAS_FILE, { path }), {
				timeout: 10000,
				label: `bob has ${path}`,
			});
		}

		// 1. API jump: bob's caret on line 180 of far.md → alice shows far.md with line 180 centred.
		await openFile(alice, HOME);
		await openFile(bob, FAR);
		await placeCaret(bob, 180);
		await waitPeerOn(alice, bobId, FAR);
		const t1 = Date.now();
		await alice.eval(
			"await app.plugins.plugins.arcasync.session.navigator.jumpTo(args.bobId); return true;",
			{ bobId },
		);
		assert.ok(Date.now() - t1 <= 3000, `jumpTo resolved in ${Date.now() - t1} ms`);
		await waitActive(alice, FAR, { timeout: 200 });
		await waitLine(alice, 180, { timeout: 500 });
		const fraction = await alice.eval(LINE_FRACTION, { line: 180 });
		assert.ok(
			fraction > 0.3 && fraction < 0.7,
			`line 180 near the centre of alice's viewport (at ${fraction})`,
		);
		assert.ok(
			(await notices(alice)).some((n) => n.includes("Jumped to bob")),
			"alice sees the jump notice",
		);
		ctx.step(
			`jumpTo: far.md with line 180 at ${fraction.toFixed(2)} of the viewport in ${Date.now() - t1} ms`,
		);
		await screenshot(alice, join(ctx.artifacts, "jump.png"));

		// 2. Avatar click jumps too: bob's caret on line 60, alice back on home.md.
		await placeCaret(bob, 60);
		await openFile(alice, HOME);
		await waitFor(() => alice.eval(CLICK_AVATAR, { userId: bobId, shift: false }), {
			timeout: 3000,
			label: "bob's avatar in alice's home.md header",
		});
		const t2 = Date.now();
		await waitActive(alice, FAR);
		await waitLine(alice, 60);
		assert.equal(await alice.eval(FOLLOWING), null, "a click jumps, it does not follow");
		ctx.step(`avatar click: far.md with line 60 visible in ${Date.now() - t2} ms`);

		// 3. Shift-click follows: bob hops f1 → f2 → f3 (2 s apart) and alice keeps up.
		assert.ok(await alice.eval(CLICK_AVATAR, { userId: bobId, shift: true }), "bob's avatar");
		await waitFollowing(alice, bobId);
		const badge = await alice.eval(BADGE);
		assert.ok(badge?.includes("Following bob"), `badge "${badge}"`);
		await waitFor(async () => (await bob.eval(PEER_FOLLOWING, { userId: aliceId })) === bobId, {
			timeout: 3000,
			label: "bob sees alice following him",
		});
		ctx.step(`shift-click: following bob, badge "${badge.trim()}", bob sees alice following`);
		for (const path of HOPS) {
			const t = Date.now();
			await openFile(bob, path);
			const ms = await waitActive(alice, path);
			ctx.step(`bob → ${path.split("/").pop()}: alice follows in ${ms} ms`);
			await sleep(Math.max(0, 2000 - (Date.now() - t)));
		}
		await openFile(bob, FAR);
		await waitLive(bob);
		await setCursor(bob, { line: 10, ch: 0 });
		await waitActive(alice, FAR);
		await waitLine(alice, 10);
		assert.equal(await isLineVisible(alice, 150), false, "line 150 starts out of view");
		await alice.eval(COUNT_OWN);
		await setCursor(bob, { line: 150, ch: 0 });
		const caretMs = await waitLine(alice, 150, { timeout: 2000 });
		await sleep(1500);
		const own = await alice.eval(OWN_COUNT);
		assert.equal(own, 0, "alice publishes nothing while following a caret move");
		ctx.step(
			`bob's caret 10 → 150 in far.md: alice shows line 150 in ${caretMs} ms, publishing ${own} awareness changes`,
		);
		assert.equal(await alice.eval(FOLLOWING), bobId, "still following after the hops");
		await screenshot(alice, join(ctx.artifacts, "following.png"));

		// 4. alice types → the follow stops with a notice and the badge goes.
		await alice.eval(FOCUS_EDITOR);
		await typeKeys(alice, "q");
		await waitFollowing(alice, null, { label: "typing stops the follow" });
		await waitFor(
			async () => (await notices(alice)).some((n) => n.includes("Stopped following bob")),
			{
				timeout: 2000,
				label: "alice sees 'Stopped following bob'",
			},
		);
		assert.equal(await alice.eval(BADGE), null, "badge gone");
		await waitFor(async () => (await bob.eval(PEER_FOLLOWING, { userId: aliceId })) === null, {
			timeout: 3000,
			label: "bob sees alice no longer following",
		});
		ctx.step("alice typed: follow stopped, notice shown, badge gone, presence cleared");

		// 4b. The avatar menu follows; the badge's Stop button ends it without a notice.
		// Native (OS) menus are not in the DOM; use Obsidian's own menus for this step.
		const nativeMenus = await alice.eval('return app.vault.getConfig("nativeMenus") ?? null;');
		await alice.eval('app.vault.setConfig("nativeMenus", false); return true;');
		assert.ok(await alice.eval(AVATAR_MENU, { userId: bobId }), "bob's avatar");
		await waitFor(() => alice.eval(MENU_CLICK, { title: "Follow bob" }), {
			timeout: 2000,
			label: "menu item 'Follow bob'",
		});
		await waitFollowing(alice, bobId, { label: "menu follows bob" });
		await alice.eval('app.vault.setConfig("nativeMenus", args.v); return true;', {
			v: nativeMenus,
		});
		const before = (await notices(alice)).length;
		assert.ok(await alice.eval(BADGE_STOP), "badge Stop button");
		await waitFollowing(alice, null, { label: "badge Stop ends the follow" });
		assert.equal(await alice.eval(BADGE), null, "badge gone after Stop");
		assert.ok((await notices(alice)).length <= before, "Stop shows no notice");
		ctx.step("avatar menu → Follow bob; badge Stop → unfollowed");

		// 5. The "Follow user…" command (typing in its modal does not cancel), then bob disconnects.
		await alice.eval('app.commands.executeCommandById("arcasync:follow-user"); return true;');
		await waitFor(() => alice.eval('return !!document.querySelector(".prompt-input");'), {
			timeout: 3000,
			label: "user picker open",
		});
		await typeKeys(alice, "bob", { cps: 20 });
		await pressKey(alice, "Enter");
		await waitFollowing(alice, bobId, { label: "command follows bob" });
		const tDisconnect = Date.now();
		await bob.eval('app.commands.executeCommandById("arcasync:disconnect"); return true;');
		await waitFollowing(alice, null, { timeout: 5000, label: "bob's disconnect stops the follow" });
		ctx.step(`command follow; bob disconnected: follow stopped in ${Date.now() - tDisconnect} ms`);
		await bob.eval('app.commands.executeCommandById("arcasync:connect"); return true;');
		await waitConnected(bob);
		await openFile(bob, FAR);
		await waitPeerOn(alice, bobId, FAR);

		// 6. bob quits → the follow stops (relay close removes his presence).
		await alice.eval(
			"app.plugins.plugins.arcasync.session.navigator.follow(args.bobId); return true;",
			{
				bobId,
			},
		);
		await waitFollowing(alice, bobId);
		const tQuit = Date.now();
		const stopped = waitFollowing(alice, null, {
			timeout: 10000,
			label: "bob's quit stops the follow",
		});
		await bob.quit();
		await stopped;
		const quitMs = Date.now() - tQuit;
		ctx.step(`bob quit: follow stopped after ${quitMs} ms`);
		assert.ok(
			(await notices(alice)).some((n) => n.includes("bob went offline")),
			"alice sees the offline notice",
		);
		await bob.launch();
		await waitConnected(bob);
	},
};
