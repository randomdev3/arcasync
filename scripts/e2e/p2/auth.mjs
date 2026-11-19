// P2-9: real-user sign-in. The bootstrap invite, pasted into the settings tab, makes dave the
// admin owner of `Team`; alice (dev-login) redeems an editor invite there; dave-phone signs in
// with a device code that dave approves (polling no faster than every 5 s); sign-out revokes the
// session on the relay, past the Worker's `/me` cache.
import assert from "node:assert/strict";
import { inModal, modalText } from "../editor.mjs";
import { waitFor } from "../obsidian.mjs";

const STATUS = `return document.querySelector(".teamsync-status-bar")?.textContent ?? null;`;

/** Opens TeamSync's settings tab; `fill` maps selectors to values, then `click` is clicked. */
async function settingsForm(v, { fill = {}, click, keepOpen = false }) {
	await v.eval('app.setting.open(); app.setting.openTabById("teamsync"); return true;');
	try {
		await waitFor(
			() =>
				v.eval(
					`const el = app.setting.activeTab?.id === "teamsync" ? app.setting.activeTab.containerEl : null;
					return !!el?.querySelector(args.click);`,
					{ click },
				),
			{ timeout: 10000, label: `${v.name}: settings tab shows ${click}` },
		);
		await v.eval(
			`const el = app.setting.activeTab.containerEl;
			for (const [selector, value] of Object.entries(args.fill)) {
				const input = el.querySelector(selector);
				if (!input) throw new Error("no " + selector);
				input.value = value;
				input.dispatchEvent(new Event("input", { bubbles: true }));
			}
			// Let Svelte apply the bound values before the click reads them.
			await new Promise((r) => setTimeout(r, 50));
			el.querySelector(args.click).click();
			return true;`,
			{ fill, click },
		);
	} finally {
		if (!keepOpen) await v.eval("app.setting.close(); return true;");
	}
}

function plugin(v) {
	return v.eval(`const p = app.plugins.plugins.teamsync;
		return {
			status: p.connection?.status ?? null,
			message: p.connection?.message ?? null,
			signedIn: p.signedIn,
			me: p.me ? { id: p.me.user.id, name: p.me.user.name, isAdmin: p.me.user.isAdmin } : null,
			workspaces: p.settings.workspaces.map((w) => ({ id: w.id, name: w.name, role: w.role })),
		};`);
}

export default {
	name: "auth",
	needs: ["alice"],
	fresh: ["dave", "dave-phone"],
	backends: ["cf"],
	async run({ vaults, api, step }) {
		const { alice, dave } = vaults;
		const phone = vaults["dave-phone"];

		// 1. Bootstrap, then dave joins with the admin invite through the settings tab.
		const inv = await api.bootstrap({ workspaceName: "Team" });
		const teamId = inv.workspace.id;
		await settingsForm(dave, {
			fill: { ".teamsync-invite-input": inv.invite.url, ".teamsync-invite-name": "dave" },
			click: ".teamsync-invite-join",
		});
		const daveState = await waitFor(
			async () => {
				const s = await plugin(dave);
				return s.status === "connected" && s.me ? s : null;
			},
			{ timeout: 15000, label: "dave connected after joining with the bootstrap invite" },
		);
		assert.equal(daveState.me.isAdmin, true, "dave is an admin");
		assert.deepEqual(daveState.workspaces, [{ id: teamId, name: "Team", role: "owner" }]);
		const status = await waitFor(
			async () => {
				const t = await dave.eval(STATUS);
				return t?.includes("Team") ? t : null;
			},
			{ timeout: 5000, label: "dave's status bar names Team" },
		);
		step(`dave joined through the settings tab: admin owner of Team ("${status}")`);

		// 2. dave invites an editor (API only); alice, already signed in, redeems it in settings.
		const editorInvite = await dave.eval(
			`return await app.plugins.plugins.teamsync.api.createInvite(args.teamId, { role: "editor" });`,
			{ teamId },
		);
		await settingsForm(alice, {
			fill: { ".teamsync-invite-input": editorInvite.url },
			click: ".teamsync-invite-join",
		});
		await waitFor(
			async () => {
				const s = await plugin(alice);
				return s.workspaces.some((w) => w.id === teamId && w.role === "editor") ? s : null;
			},
			{ timeout: 5000, label: "alice's settings.workspaces lists Team as editor" },
		);
		step("alice redeemed an editor invite to Team through the settings tab");

		// 3. dave-phone signs in with a device code that dave approves.
		const started = Date.now();
		await settingsForm(phone, { click: ".teamsync-device-signin", keepOpen: true });
		const userCode = await waitFor(() => modalText(phone, ".teamsync-user-code"), {
			timeout: 10000,
			label: "dave-phone shows a user code",
		});
		assert.match(userCode, /^[A-Z]{4}-[A-Z]{4}$/);
		await dave.eval(`app.commands.executeCommandById("teamsync:approve-device"); return true;`);
		await waitFor(() => modalText(dave, ".teamsync-approve-lookup"), {
			timeout: 5000,
			label: "dave's approve modal is open",
		});
		await inModal(
			dave,
			".teamsync-approve-code",
			`const input = root.querySelector(args.selector);
			input.value = args.code;
			input.dispatchEvent(new Event("input", { bubbles: true }));
			root.querySelector(".teamsync-approve-lookup").click();
			return true;`,
			{ code: userCode },
		);
		const shown = await waitFor(() => modalText(dave, ".teamsync-approve-device-name"), {
			timeout: 5000,
			label: "dave's approve modal names the device",
		});
		const phoneVault = await phone.eval("return app.vault.getName();");
		assert.equal(shown, phoneVault, "the approve modal names dave-phone's vault");
		await inModal(
			dave,
			".teamsync-approve-accept",
			"root.querySelector(args.selector).click(); return true;",
		);
		const phoneState = await waitFor(
			async () => {
				const s = await plugin(phone);
				return s.status === "connected" && s.me ? s : null;
			},
			{ timeout: 15000, label: "dave-phone connected after approval" },
		);
		const elapsed = (Date.now() - started) / 1000;
		assert.equal(phoneState.me.id, daveState.me.id, "dave-phone is signed in as dave");
		const polls = await phone.eval(
			`return app.plugins.plugins.teamsync.api.requestCounts["/auth/device/poll"] ?? 0;`,
		);
		assert.ok(polls >= 1, "dave-phone polled");
		assert.ok(
			polls <= Math.ceil(elapsed / 5) + 1,
			`${polls} polls in ${elapsed.toFixed(1)} s is faster than every 5 s`,
		);
		assert.equal(await modalText(phone, ".teamsync-user-code"), null, "the code modal closed");
		await phone.eval("app.setting.close(); return true;");
		step(
			`dave approved dave-phone's code ${userCode}: signed in as dave, ${polls} polls in ${elapsed.toFixed(1)} s`,
		);

		// 4. Sign-out revokes the session on the relay. `/me` is read first so the Worker caches it:
		// the 401 afterwards proves logout dropped the cached entry too.
		const token = await phone.eval("return app.plugins.plugins.teamsync.secrets.get();");
		assert.ok(token, "dave-phone has a session token");
		const before = await api.request("/api/auth/me", { token });
		assert.equal(before.status, 200, "the session works before sign-out");
		await phone.eval(`app.commands.executeCommandById("teamsync:sign-out"); return true;`);
		await waitFor(async () => !(await plugin(phone)).signedIn, {
			timeout: 5000,
			label: "dave-phone signed out locally",
		});
		const after = await api.request("/api/auth/me", { token });
		assert.equal(after.status, 401, "the old session token is refused after sign-out");
		step("dave-phone signed out: GET /api/auth/me with its old token → 401 (cache dropped)");
	},
};
