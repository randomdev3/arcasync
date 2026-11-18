// P1-1: both vaults map `Shared`, the session's index doc syncs, the status bar names the
// workspace, and a session stop/start does not leak providers.
import assert from "node:assert/strict";
import { waitFor } from "../obsidian.mjs";

const SESSION = `const s = app.plugins.plugins.teamsync?.session;
	return s ? { synced: s.started && s.indexProvider.synced, root: s.root } : null;`;
const STATUS = `return document.querySelector(".teamsync-status-bar")?.textContent ?? null;`;
const DOCS = "return app.plugins.plugins.teamsync.connections.docs.size;";
const NOTES = `return app.vault.getMarkdownFiles().map((f) => f.path)
	.filter((p) => p.startsWith("Shared/")).sort();`;

export default {
	name: "mapping",
	needs: ["alice", "bob"],
	async run(ctx) {
		const { alice, bob } = ctx.vaults;
		for (const v of [alice, bob]) {
			const s = await waitFor(
				async () => {
					const r = await v.eval(SESSION);
					return r?.synced ? r : null;
				},
				{ timeout: 10000, label: `${v.name} index doc synced` },
			);
			assert.equal(s.root, "Shared", `${v.name} root`);
		}
		ctx.step("alice and bob: index doc synced, root = Shared");

		// The dev workspace is slug `dev`, display name `Dev`.
		const status = await waitFor(
			async () => {
				const t = await alice.eval(STATUS);
				return /^TeamSync: alice · dev\b/i.test(t ?? "") ? t : null;
			},
			{ timeout: 5000, label: "alice status bar names the workspace" },
		);
		ctx.step(`status bar: "${status}"`);

		await alice.eval('app.setting.open(); app.setting.openTabById("teamsync"); return true;');
		try {
			const form = await waitFor(
				() =>
					alice.eval(`// The settings tab may live in its own window: query its container, not document.
						const el = app.setting.activeTab?.id === "teamsync" ? app.setting.activeTab.containerEl : null;
						const folder = el?.querySelector(".teamsync-shared-folder");
						const options = [...(el?.querySelectorAll("select.teamsync-workspace option") ?? [])];
						return folder && options.length
							? { folder: folder.value, workspaces: options.map((o) => o.textContent) } : null;`),
				{ timeout: 5000, label: "alice settings tab shows folder and workspace" },
			);
			assert.equal(form.folder, "Shared");
			assert.ok(
				form.workspaces.some((w) => /^dev$/i.test(w)),
				`workspaces: ${form.workspaces}`,
			);
			ctx.step(`settings tab: folder "${form.folder}", workspaces [${form.workspaces}]`);
		} finally {
			await alice.eval("app.setting.close(); return true;");
		}

		// Providers are the index doc plus the attached note docs; a stop drops warm note docs, so
		// the leak check compares against that, not against the count before the restart.
		const ATTACHED =
			"return 1 + (app.plugins.plugins.teamsync.session.docs?.attachedCount() ?? 0);";
		assert.equal(await alice.eval(DOCS), await alice.eval(ATTACHED), "providers before restart");
		const notesBefore = await alice.eval(NOTES);
		await alice.eval("const s = app.plugins.plugins.teamsync.session; s.stop(); s.start();");
		await waitFor(async () => (await alice.eval(SESSION))?.synced, {
			timeout: 10000,
			label: "alice index doc re-synced after restart",
		});
		await alice.eval("await app.plugins.plugins.teamsync.session.settled();");
		// A note doc still loading IndexedDB counts as attached before its provider exists.
		const after = await waitFor(
			async () => {
				const [docs, attached] = [await alice.eval(DOCS), await alice.eval(ATTACHED)];
				return docs === attached ? docs : null;
			},
			{ timeout: 5000, label: "open providers == index + attached note docs after restart" },
		);
		// The restarted session starts from an empty index doc; it must not act on it before sync.
		assert.deepEqual(await alice.eval(NOTES), notesBefore, "notes under Shared after restart");
		ctx.step(`session stop/start: ${after} provider(s) and ${notesBefore.length} note(s) kept`);
	},
};
