// P2-10: owner tools and membership changes on live sockets. alice (owner of `dev`) demotes bob
// to viewer in the members modal: the relay closes bob's socket with 4401 and his editor turns
// read-only. Promoting him back makes it writable; removing him stops his session for `dev`
// (Notice, files kept). The invite modal shows an `obsidian://teamsync` link.
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import {
	diskText,
	editorText,
	inModal,
	modalText,
	notices,
	openFile,
	replaceRange,
	setCursor,
	typeKeys,
} from "../editor.mjs";
import { sleep, waitFor } from "../obsidian.mjs";

const NAME = "members";
const NOTE = `Shared/${NAME}/r.md`;
const SEED = "roles\n";

/** Whether the active editor is bound to its note (`.teamsync-live`) and read-only. */
function editorState(v) {
	return v.eval(`const cm = app.workspace.activeEditor?.editor?.cm;
		return { live: !!cm?.dom.classList.contains("teamsync-live"), readOnly: cm?.state.readOnly ?? null };`);
}

/** Sets bob's role in alice's open members modal through its dropdown. */
async function setRole(alice, userId, role) {
	const done = await inModal(
		alice,
		`.teamsync-member[data-user-id="${userId}"] .teamsync-member-role`,
		`const select = root.querySelector(args.selector);
		select.value = args.role;
		select.dispatchEvent(new Event("change", { bubbles: true }));
		return true;`,
		{ role },
	);
	assert.equal(done, true, `alice's members modal lists ${userId}`);
}

function bobSessions(bob) {
	return bob.eval(`const p = app.plugins.plugins.teamsync;
		return { ids: p.sessions.map((s) => s.workspaceId), status: p.connection?.status ?? null };`);
}

export default {
	name: NAME,
	needs: ["alice", "bob"],
	backends: ["cf"],
	seed: { alice: { [NOTE]: SEED } },
	async run({ vaults, step }) {
		const { alice, bob } = vaults;
		const devId = await alice.eval(
			`return app.plugins.plugins.teamsync.settings.workspaces.find((w) => w.slug === "dev")?.id ?? null;`,
		);
		assert.ok(devId, "alice is in workspace dev");
		const bobId = await bob.eval("return app.plugins.plugins.teamsync.settings.user.id;");
		await waitFor(() => diskText(bob.path, NOTE) === SEED, {
			timeout: 15000,
			label: `bob has ${NOTE}`,
		});
		for (const v of [alice, bob]) {
			await openFile(v, NOTE);
			await waitFor(async () => (await editorState(v)).live, {
				timeout: 15000,
				label: `${v.name}: editor on ${NOTE} bound`,
			});
		}
		assert.equal((await editorState(bob)).readOnly, false, "bob starts as an editor");

		try {
			// 1. alice demotes bob to viewer in the members modal.
			await alice.eval(`app.commands.executeCommandById("teamsync:manage-members"); return true;`);
			await waitFor(() => modalText(alice, `.teamsync-member[data-user-id="${bobId}"]`), {
				timeout: 5000,
				label: "alice's members modal lists bob",
			});
			await setRole(alice, bobId, "viewer");
			await waitFor(async () => (await editorState(bob)).readOnly === true, {
				timeout: 5000,
				label: "bob's editor read-only within 5 s of the demotion",
			});
			await setCursor(bob, { line: 0, ch: 5 });
			await typeKeys(bob, "zz");
			await sleep(2000);
			assert.equal(await editorText(alice), SEED, "bob's typing as a viewer does not reach alice");
			const closeCode = await bob.eval(
				"return app.plugins.plugins.teamsync.connections?.lastCloseCode ?? null;",
			);
			assert.equal(closeCode, 4401, "bob's socket was closed with 4401");
			step("bob demoted to viewer: socket closed 4401, editor read-only, typing stays local");

			// 2. alice promotes bob back to editor. bob's first token invalidation (the 4401's) is
			// skipped, so the reconnect re-sends a token from before the revocation: the relay
			// refuses it and each doc takes ConnectionManager's one re-Auth retry.
			await bob.eval(`const t = app.plugins.plugins.teamsync.tokens;
				const real = t.invalidate;
				window.__tsInvalidations = 0;
				t.invalidate = function (ws) {
					if (window.__tsInvalidations++ === 0) return;
					return real.call(this, ws);
				};
				window.__tsRestoreInvalidate = () => { t.invalidate = real; };
				return true;`);
			await waitFor(
				() =>
					inModal(
						alice,
						`.teamsync-member[data-user-id="${bobId}"] .teamsync-member-role`,
						"return root.querySelector(args.selector).value === 'viewer';",
					),
				{ timeout: 5000, label: "alice's members modal shows bob as viewer" },
			);
			await setRole(alice, bobId, "editor");
			await waitFor(async () => (await editorState(bob)).readOnly === false, {
				timeout: 5000,
				label: "bob's editor writable within 5 s of the promotion",
			});
			const invalidations = await bob.eval(
				"window.__tsRestoreInvalidate(); return window.__tsInvalidations;",
			);
			assert.ok(invalidations >= 2, `the stale token was refused (${invalidations} invalidations)`);
			await waitFor(
				() =>
					bob.eval(
						`const s = app.plugins.plugins.teamsync.session;
						const note = await s.docs.peek(s.fileIdOf(args.path));
						return s.indexProvider.synced && !!note?.provider.synced;`,
						{ path: NOTE },
					),
				{ timeout: 5000, label: "bob's index and note providers synced after the retry" },
			);
			await setCursor(bob, { line: 0, ch: 5 });
			await typeKeys(bob, " ok");
			await waitFor(async () => (await editorText(alice)) === "roles ok\n", {
				timeout: 5000,
				label: `alice sees bob's " ok" (has ${JSON.stringify(await editorText(alice))})`,
			});
			// alice's members modal has the keyboard: her edit goes through the editor API.
			await replaceRange(alice, "!", { line: 0, ch: 8 });
			await waitFor(async () => (await editorText(bob)) === "roles ok!\n", {
				timeout: 5000,
				label: `bob sees alice's "!" (has ${JSON.stringify(await editorText(bob))})`,
			});
			step(
				`bob promoted back to editor through a refused stale token and one re-Auth: writable, edits flow both ways`,
			);

			// 3. alice removes bob from dev (with confirmation).
			await waitFor(
				() =>
					inModal(
						alice,
						`.teamsync-member[data-user-id="${bobId}"] .teamsync-member-role`,
						"return root.querySelector(args.selector).value === 'editor';",
					),
				{ timeout: 5000, label: "alice's members modal shows bob as editor" },
			);
			await inModal(
				alice,
				`.teamsync-member[data-user-id="${bobId}"] .teamsync-member-remove`,
				"root.querySelector(args.selector).click(); return true;",
			);
			const confirmed = await waitFor(
				() =>
					inModal(
						alice,
						".teamsync-confirm",
						"root.querySelector(args.selector).click(); return true;",
					),
				{ timeout: 5000, label: "alice confirms the removal" },
			);
			assert.equal(confirmed, true);
			const notice = await waitFor(
				async () => (await notices(bob)).find((n) => /removed from/.test(n)) ?? null,
				{ timeout: 5000, label: "bob's Notice: removed from" },
			);
			await waitFor(async () => (await bobSessions(bob)).ids.every((id) => id !== devId), {
				timeout: 5000,
				label: "bob has no session for dev",
			});
			assert.match(notice, /removed from Dev$/i, "the Notice names the workspace");
			assert.ok(existsSync(join(bob.path, NOTE)), `bob keeps ${NOTE} on disk`);
			await sleep(2000);
			const after = await bobSessions(bob);
			assert.ok(!after.ids.includes(devId), "bob does not reconnect to dev");
			step(`bob removed: "${notice}", no dev session, ${NOTE} kept`);
		} finally {
			await alice.eval(
				"for (const m of [...app.plugins.plugins.teamsync.modals]) m.close(); return true;",
			);
			// 4. bob signs in again through dev-login, which re-adds his membership as an editor.
			await bob.eval(
				"const p = app.plugins.plugins.teamsync; await p.signOut(); await p.connect(); return true;",
			);
			await waitFor(
				async () => {
					const s = await bobSessions(bob);
					return s.status === "connected" && s.ids.includes(devId) ? s : null;
				},
				{ timeout: 15000, label: "bob connected to dev again after dev-login" },
			);
			step("bob signed out and back in through dev-login: connected to dev again");
		}

		// 5. The invite modal shows the new link.
		await alice.eval(`app.commands.executeCommandById("teamsync:create-invite"); return true;`);
		try {
			await waitFor(() => modalText(alice, ".teamsync-invite-create"), {
				timeout: 5000,
				label: "alice's invite modal is open",
			});
			await inModal(
				alice,
				".teamsync-invite-create",
				"root.querySelector(args.selector).click(); return true;",
			);
			const url = await waitFor(
				() =>
					inModal(alice, ".teamsync-invite-url", "return root.querySelector(args.selector).value;"),
				{ timeout: 5000, label: "alice's invite modal shows a link" },
			);
			assert.ok(url.startsWith("obsidian://teamsync?server="), `invite link: ${url}`);
			step(`invite modal shows ${url.slice(0, 40)}…`);
		} finally {
			await alice.eval(
				"for (const m of [...app.plugins.plugins.teamsync.modals]) m.close(); return true;",
			);
			for (const v of [alice, bob]) {
				await v.eval(
					`for (const l of app.workspace.getLeavesOfType("markdown")) l.detach(); return true;`,
				);
			}
		}
	},
};
