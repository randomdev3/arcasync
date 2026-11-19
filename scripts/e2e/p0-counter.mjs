// P0 acceptance in real Obsidian: two vaults connect as alice/bob, the debug counter
// round-trips in both directions, Notices render, and state survives a server restart.
import assert from "node:assert/strict";
import { connectPlugin, launchObsidian, prepareVaults, waitFor } from "./obsidian.mjs";
import { restartServer, SkipError, startServer } from "./server.mjs";

const COUNTER = `return app.plugins.plugins.arcasync?.session?.indexDoc.getMap("debug").get("counter") ?? 0;`;
const BUMP = `app.commands.executeCommandById("arcasync:debug-counter-increment"); return true;`;
const NOTICES = `return [...document.querySelectorAll(".notice")].map((n) => n.textContent);`;

let server = await startServer();
const [a, b] = prepareVaults(["e2e-alice", "e2e-bob"]);
const obsidian = await launchObsidian([a, b]);
const { "e2e-alice": alice, "e2e-bob": bob } = obsidian.vaults;
const step = (msg) => console.log(`  ✓ ${msg}`);

try {
	for (const [vault, name] of [
		[alice, "alice"],
		[bob, "bob"],
	]) {
		const r = await connectPlugin(vault, { serverUrl: server.url, name });
		assert.equal(r.status, "connected", `${name}: ${JSON.stringify(r)}`);
		assert.equal(r.user, name);
	}
	step(`both vaults connected (alice, bob) to ${server.backend} backend`);

	const start = await alice.eval(COUNTER);
	await alice.eval(BUMP);
	await waitFor(async () => (await bob.eval(COUNTER)) === start + 1, { label: "bob sees +1" });
	step(`alice +1 → bob sees ${start + 1}`);

	await bob.eval(BUMP);
	await waitFor(async () => (await alice.eval(COUNTER)) === start + 2, { label: "alice sees +2" });
	step(`bob +1 → alice sees ${start + 2}`);

	const notices = await bob.eval(NOTICES);
	assert.ok(notices.includes(`ArcaSync counter: ${start + 1}`), `bob notices: ${notices}`);
	step("remote change Notice rendered in bob's window");

	try {
		server = await restartServer(server);
		await alice.eval(BUMP);
		await waitFor(async () => (await bob.eval(COUNTER)) === start + 3, {
			timeout: 30000,
			label: "bob sees +3 after server restart",
		});
		step("server restart: clients reconnect, state persisted, sync resumes");
	} catch (error) {
		if (!(error instanceof SkipError)) throw error;
		console.log(`  - SKIP server restart (${error.message})`);
	}
	console.log("p0-counter: PASS");
} finally {
	await obsidian.close();
	await server.stop();
}
