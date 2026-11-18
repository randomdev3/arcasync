// P1-1: both vaults map `Shared`, the session's index doc syncs, the status bar names the
// workspace, and a session stop/start does not leak providers.
import assert from "node:assert/strict";
import { waitFor } from "../obsidian.mjs";

const SESSION = `const s = app.plugins.plugins.teamsync?.session;
	return s ? { synced: s.started && s.indexProvider.synced, root: s.root } : null;`;
const STATUS = `return document.querySelector(".teamsync-status-bar")?.textContent ?? null;`;
const DOCS = "return app.plugins.plugins.teamsync.connections.docs.size;";

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

		const before = await alice.eval(DOCS);
		await alice.eval("const s = app.plugins.plugins.teamsync.session; s.stop(); s.start();");
		await waitFor(async () => (await alice.eval(SESSION))?.synced, {
			timeout: 10000,
			label: "alice index doc re-synced after restart",
		});
		const after = await alice.eval(DOCS);
		assert.equal(after, before, "open providers after a session stop/start");
		ctx.step(`session stop/start: ${after} provider(s) before and after`);
	},
};
