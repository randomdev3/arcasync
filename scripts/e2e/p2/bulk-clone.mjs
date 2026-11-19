// P2-12: a fresh device catches up a folder of 60 notes through bulk clone (a few REST requests,
// almost no provider attaches), and normal sync works after the hydrate.
import assert from "node:assert/strict";
import { diskText } from "../editor.mjs";
import { connectPlugin, waitFor } from "../obsidian.mjs";

const NAME = "bulk-clone";
const FOLDER = `Shared/${NAME}`;
const N = 60;
const path = (i) => `${FOLDER}/n${String(i).padStart(2, "0")}.md`;
const text = (i) => `note ${i}\n`;
const NOTES = Array.from({ length: N }, (_, i) => i + 1);

/** alice's index has every note with a docRevs entry, and the relay acked all of it. */
function aliceReady(alice) {
	return alice.eval(
		`const s = app.plugins.plugins.teamsync?.session;
		if (!s?.index) return false;
		const revs = s.indexDoc.getMap("docRevs");
		const ok = args.paths.every((p) => {
			const id = s.fileIdOf(p);
			return id && revs.get(id);
		});
		return ok && !s.indexProvider.hasUnsyncedChanges;`,
		{ paths: NOTES.map(path) },
	);
}

export default {
	name: NAME,
	needs: ["alice"],
	fresh: ["erin"],
	backends: ["cf"],
	seed: { alice: Object.fromEntries(NOTES.map((i) => [path(i), text(i)])) },
	async run({ vaults, api, server, step }) {
		const { alice, erin } = vaults;
		await waitFor(() => aliceReady(alice), {
			timeout: 30000,
			label: "alice's 60 notes indexed, enrolled and acked",
		});
		const ws = await alice.eval("return app.plugins.plugins.teamsync.session.workspaceId;");
		await api.resetStats(ws);
		step(`alice's ${N} notes are indexed and acked; relay stats reset`);

		const started = Date.now();
		const r = await connectPlugin(erin, {
			serverUrl: server.url,
			name: "erin",
			sharedFolder: "Shared",
		});
		assert.equal(r.status, "connected", `erin connected: ${JSON.stringify(r)}`);
		await waitFor(() => NOTES.every((i) => diskText(erin.path, path(i)) === text(i)), {
			timeout: 45000,
			label: `erin has all ${N} notes with their text`,
		});
		const seconds = ((Date.now() - started) / 1000).toFixed(1);
		const docStats = await erin.eval(
			"return { ...app.plugins.plugins.teamsync.session.docs.stats };",
		);
		const stats = await api.stats(ws);
		assert.ok(stats.clone_requests >= 1, `clone requests: ${stats.clone_requests}`);
		assert.ok(stats.clone_docs >= N, `cloned docs: ${stats.clone_docs}`);
		assert.ok(docStats.attaches <= 5, `provider attaches during the clone: ${docStats.attaches}`);
		step(
			`erin has all ${N} notes in ${seconds} s: ${stats.clone_requests} clone request(s), ` +
				`${stats.clone_docs} docs, ${docStats.hydrates} hydrates, ${docStats.attaches} attaches; ` +
				`msgs_in ${stats.msgs_in} (includes the earlier folders' traffic)`,
		);

		await alice.eval(
			`await app.vault.modify(app.vault.getFileByPath(args.path), "note 5 edited\\n"); return true;`,
			{ path: path(5) },
		);
		await waitFor(() => diskText(erin.path, path(5)) === "note 5 edited\n", {
			timeout: 10000,
			label: `erin's ${path(5)} shows alice's edit`,
		});
		step("alice's edit of n05.md reaches erin after the hydrate");
	},
};
