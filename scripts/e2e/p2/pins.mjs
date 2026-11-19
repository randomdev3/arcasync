// PIN invites and password sign-in. alice (dev-login owner of `dev`) creates an editor PIN in the
// invite modal; frank, a fresh vault, joins with the PIN, a name and a password in the settings
// tab; he signs out, a wrong password is refused, and he signs back in with name + password as
// the same user. The PIN then shows as used by frank in alice's modal.
import assert from "node:assert/strict";
import { inModal, modalText, notices } from "../editor.mjs";
import { waitFor } from "../obsidian.mjs";

const PASSWORD = "frank's long password";

/** Opens ArcaSync's settings tab and fills `steps` in order ([selector, value]), then clicks. */
async function settingsForm(v, steps, click) {
	await v.eval('app.setting.open(); app.setting.openTabById("arcasync"); return true;');
	try {
		for (const [selector, value] of steps) {
			// A field may only render after an earlier one (the PIN reveals the password fields).
			await waitFor(
				() =>
					v.eval(
						`const el = app.setting.activeTab?.id === "arcasync" ? app.setting.activeTab.containerEl : null;
						return !!el?.querySelector(args.selector);`,
						{ selector },
					),
				{ timeout: 10000, label: `${v.name}: settings tab shows ${selector}` },
			);
			await v.eval(
				`const input = app.setting.activeTab.containerEl.querySelector(args.selector);
				input.value = args.value;
				input.dispatchEvent(new Event("input", { bubbles: true }));
				await new Promise((r) => setTimeout(r, 50));
				return true;`,
				{ selector, value },
			);
		}
		await v.eval(
			"app.setting.activeTab.containerEl.querySelector(args.click).click(); return true;",
			{
				click,
			},
		);
	} finally {
		await v.eval("app.setting.close(); return true;");
	}
}

function plugin(v) {
	return v.eval(`const p = app.plugins.plugins.arcasync;
		return {
			status: p.connection?.status ?? null,
			signedIn: p.signedIn,
			me: p.me ? { id: p.me.user.id, name: p.me.user.name, hasPassword: p.me.hasPassword ?? null } : null,
			workspaces: p.settings.workspaces.map((w) => ({ id: w.id, role: w.role })),
		};`);
}

const connected = (v, label) =>
	waitFor(
		async () => {
			const s = await plugin(v);
			return s.status === "connected" && s.me ? s : null;
		},
		{ timeout: 20000, label },
	);

export default {
	name: "pins",
	needs: ["alice"],
	fresh: ["frank"],
	backends: ["cf"],
	async run({ vaults, step }) {
		const { alice, frank } = vaults;
		// The workspace the invite modal opens on (alice owns `dev`).
		const devId = await alice.eval(
			"return app.plugins.plugins.arcasync.ownerToolTarget()?.workspaceId ?? null;",
		);
		assert.ok(devId, "alice owns a workspace");

		// 1. alice creates an editor PIN in the invite modal.
		await alice.eval(`app.commands.executeCommandById("arcasync:create-invite"); return true;`);
		await waitFor(() => modalText(alice, ".arcasync-pin-create"), {
			timeout: 5000,
			label: "alice's invite modal shows the PINs section",
		});
		await inModal(
			alice,
			".arcasync-pin-role",
			`const select = root.querySelector(args.selector);
			select.value = "editor";
			select.dispatchEvent(new Event("change", { bubbles: true }));
			root.querySelector(".arcasync-pin-create").click();
			return true;`,
		);
		const pin = await waitFor(() => modalText(alice, ".arcasync-pin .arcasync-pin-value"), {
			timeout: 5000,
			label: "alice's modal lists the new PIN",
		});
		assert.match(pin, /^[0-9]{4}$/);
		const desc = await modalText(alice, ".arcasync-pin .setting-item-description");
		assert.match(desc, /^editor · expires /, `PIN row: ${desc}`);
		await alice.eval(
			`for (const m of app.plugins.plugins.arcasync.modals) m.close(); return true;`,
		);
		step(`alice created editor PIN ${pin} in the invite modal (${desc})`);

		// 2. frank joins with the PIN, a name and a password.
		await waitFor(
			() =>
				frank.eval(
					"return (await app.plugins.plugins.arcasync.refreshServerInfo())?.features?.pins === true;",
				),
			{
				timeout: 10000,
				label: "frank's plugin sees features.pins",
			},
		);
		await settingsForm(
			frank,
			[
				[".arcasync-invite-input", pin],
				[".arcasync-invite-name", "frank"],
				[".arcasync-invite-password", PASSWORD],
				[".arcasync-invite-password-confirm", PASSWORD],
			],
			".arcasync-invite-join",
		);
		const joined = await connected(frank, "frank connected after joining with the PIN");
		assert.equal(joined.me.name, "frank");
		assert.equal(joined.me.hasPassword, true, "frank has a password");
		assert.deepEqual(joined.workspaces, [{ id: devId, role: "editor" }]);
		step(`frank joined dev as editor with PIN ${pin} and a password`);

		// 3. Sign out, a wrong password is refused, then name + password signs back in.
		await frank.eval(`app.commands.executeCommandById("arcasync:sign-out"); return true;`);
		await waitFor(async () => !(await plugin(frank)).signedIn, {
			timeout: 5000,
			label: "frank signed out",
		});
		await settingsForm(
			frank,
			[
				[".arcasync-signin-name", "Frank"],
				[".arcasync-signin-password", "not frank's password"],
			],
			".arcasync-signin-submit",
		);
		await waitFor(
			async () => (await notices(frank)).some((n) => n.includes("Wrong name or password")),
			{ timeout: 5000, label: "frank sees 'Wrong name or password'" },
		);
		assert.equal((await plugin(frank)).signedIn, false, "a wrong password does not sign in");
		await settingsForm(
			frank,
			[
				[".arcasync-signin-name", "Frank"],
				[".arcasync-signin-password", PASSWORD],
			],
			".arcasync-signin-submit",
		);
		const back = await connected(frank, "frank connected after name + password sign-in");
		assert.equal(back.me.id, joined.me.id, "the same user signed back in");
		step("frank signed out, a wrong password was refused, name + password signed him back in");

		// 4. alice's modal shows the PIN as used by frank.
		await alice.eval(`app.commands.executeCommandById("arcasync:create-invite"); return true;`);
		const used = await waitFor(
			async () => {
				const t = await modalText(alice, ".arcasync-pin .setting-item-description");
				return t?.includes("used by frank") ? t : null;
			},
			{ timeout: 5000, label: "alice's modal shows the PIN used by frank" },
		);
		await alice.eval(
			`for (const m of app.plugins.plugins.arcasync.modals) m.close(); return true;`,
		);
		step(`alice's invite modal: ${pin} ${used}`);
	},
};
