// P1-5: workspace presence. bob's avatar appears in the header of alice's view of the note bob is
// on, dims when bob moves to another note, and disappears when bob disconnects or is killed; the
// status bar counts online users.
import assert from "node:assert/strict";
import { join } from "node:path";
import { openFile, screenshot } from "../editor.mjs";
import { waitConnected, waitFor } from "../obsidian.mjs";

const X = "Shared/presence/x.md";
const Y = "Shared/presence/y.md";

/** bob's avatar in the header of alice's view of `path`: `{state, title, opacity}` or null. */
const AVATAR = `
	const leaf = app.workspace.getLeavesOfType("markdown").find((l) => l.view.file?.path === args.path);
	const sel = '.view-header .teamsync-facepile .teamsync-avatar[data-user-id="' + CSS.escape(args.userId) + '"]';
	const el = leaf?.view.containerEl.querySelector(sel);
	return el ? { state: el.dataset.state, title: el.title, opacity: getComputedStyle(el).opacity } : null;
`;
const HEADER_RECT = `
	const leaf = app.workspace.getLeavesOfType("markdown").find((l) => l.view.file?.path === args.path);
	const r = leaf?.view.containerEl.querySelector(".view-header")?.getBoundingClientRect();
	return r ? { x: r.x, y: r.y, width: r.width, height: r.height } : null;
`;
const STATUS = `return document.querySelector(".teamsync-status-bar")?.textContent ?? "";`;
const USER_ID = "return app.plugins.plugins.teamsync.settings.user.id;";
const HAS_FILE = "return !!app.vault.getAbstractFileByPath(args.path);";

async function avatar(v, path, userId) {
	return v.eval(AVATAR, { path, userId });
}

/** Waits for `predicate(avatar)` and returns `{avatar, ms}`. */
async function waitAvatar(v, path, userId, predicate, { timeout, label }) {
	const t0 = Date.now();
	const found = await waitFor(
		async () => {
			const a = await avatar(v, path, userId);
			return predicate(a) ? { avatar: a } : null;
		},
		{ timeout, interval: 100, label },
	);
	return { avatar: found.avatar, ms: Date.now() - t0 };
}

async function waitStatus(v, re, label) {
	return waitFor(
		async () => {
			const t = await v.eval(STATUS);
			return re.test(t) ? t : null;
		},
		{ timeout: 5000, label },
	);
}

export default {
	name: "presence",
	needs: ["alice", "bob"],
	seed: { alice: { [X]: "Presence x\n", [Y]: "Presence y\n" } },
	async run(ctx) {
		const { alice, bob } = ctx.vaults;
		const bobId = await bob.eval(USER_ID);
		const aliceId = await alice.eval(USER_ID);
		for (const path of [X, Y]) {
			await waitFor(() => bob.eval(HAS_FILE, { path }), {
				timeout: 10000,
				label: `bob has ${path}`,
			});
		}

		// 1. Both on x.md → each sees the other `here`.
		await openFile(alice, X);
		await openFile(bob, X);
		const here = await waitAvatar(alice, X, bobId, (a) => a?.state === "here", {
			timeout: 3000,
			label: "alice shows bob here on x.md",
		});
		assert.equal(here.avatar.title, `bob — ${X}`);
		// Opacity animates (150 ms) from the `elsewhere` dimming bob had before he opened x.md.
		await waitAvatar(alice, X, bobId, (a) => Number(a?.opacity) === 1, {
			timeout: 1000,
			label: "bob's avatar at full opacity",
		});
		await waitAvatar(bob, X, aliceId, (a) => a?.state === "here", {
			timeout: 3000,
			label: "bob shows alice here on x.md",
		});
		ctx.step(
			`bob "here" in alice's x.md header after ${here.ms} ms (title "${here.avatar.title}")`,
		);
		const rect = await alice.eval(HEADER_RECT, { path: X });
		const shotHere = await screenshot(alice, join(ctx.artifacts, "header-here.png"), rect);

		// 5. Status bar counts users.
		const status = await waitStatus(alice, /\b2 online\b/, "alice status bar 2 online");
		ctx.step(`status bar: "${status}"`);

		// 2. bob moves to y.md → dimmed `elsewhere` in alice's x.md header.
		await openFile(bob, Y);
		const away = await waitAvatar(alice, X, bobId, (a) => a?.state === "elsewhere", {
			timeout: 3000,
			label: "alice shows bob elsewhere on x.md",
		});
		assert.equal(away.avatar.title, `bob — ${Y}`);
		const dimmed = await waitAvatar(alice, X, bobId, (a) => Number(a?.opacity) <= 0.5, {
			timeout: 1000,
			label: "bob's avatar dimmed",
		});
		const shotAway = await screenshot(alice, join(ctx.artifacts, "header-elsewhere.png"), rect);
		ctx.step(`bob "elsewhere" after ${away.ms} ms (opacity ${dimmed.avatar.opacity})`);
		ctx.step(`header screenshots: ${shotHere}, ${shotAway}`);

		// 3. bob disconnects → gone within 3 s; reconnects → back.
		await bob.eval('app.commands.executeCommandById("teamsync:disconnect"); return true;');
		const left = await waitAvatar(alice, X, bobId, (a) => a === null, {
			timeout: 3000,
			label: "bob's avatar gone after disconnect",
		});
		await waitStatus(alice, /\b1 online\b/, "alice status bar 1 online after bob disconnects");
		ctx.step(`bob disconnected: avatar gone after ${left.ms} ms, status "1 online"`);
		await bob.eval('app.commands.executeCommandById("teamsync:connect"); return true;');
		await waitConnected(bob);
		await openFile(bob, X);
		await waitAvatar(alice, X, bobId, (a) => a?.state === "here", {
			timeout: 5000,
			label: "bob here again after reconnect",
		});
		ctx.step("bob reconnected: here again");

		// Obsidian persists its own state (the vault's plugin trust) lazily; a SIGKILL soon after the
		// plugin was first enabled loses it. A graceful restart first makes the crash below test
		// only TeamSync.
		await bob.relaunch();
		await waitConnected(bob);
		await openFile(bob, X);
		await waitAvatar(alice, X, bobId, (a) => a?.state === "here", {
			timeout: 10000,
			label: "bob here after a graceful restart",
		});

		// 4. SIGKILL → the relay's close-driven removal clears bob within 10 s.
		const t0 = Date.now();
		const gone = waitFor(async () => (await avatar(alice, X, bobId)) === null, {
			timeout: 15000,
			interval: 100,
			label: "bob's avatar gone after kill",
		}).then(() => Date.now() - t0);
		await bob.kill();
		const killMs = await gone;
		assert.ok(killMs <= 10000, `avatar removed ${killMs} ms after SIGKILL (bound 10000)`);
		ctx.step(`bob killed: avatar gone after ${killMs} ms`);

		await bob.relaunch();
		await waitConnected(bob);
		await openFile(bob, X);
		await waitAvatar(alice, X, bobId, (a) => a?.state === "here", {
			timeout: 10000,
			label: "bob here after relaunch",
		});
		await waitStatus(alice, /\b2 online\b/, "alice status bar 2 online after relaunch");
		for (const v of [alice, bob]) {
			const s = await v.eval("return app.plugins.plugins.teamsync.connection.status;");
			assert.equal(s, "connected", `${v.name} still connected`);
		}
		ctx.step("bob relaunched: here again, 2 online, both connected");
	},
};
