// P1-3: closed notes converge on disk through the note docs and docRevs, and enrollment puts the
// disk text into the CRDT exactly once. No editor is opened in this scenario.
import assert from "node:assert/strict";
import { readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { diskText } from "../editor.mjs";
import { waitFor } from "../obsidian.mjs";

const NAME = "closed-note";
const SEED = `Shared/${NAME}/seed.md`;

/** The note's index entry `{key, id}` (key relative to the mapped folder), or null. */
function indexEntry(v) {
	return v.eval(
		`const files = app.plugins.plugins.arcasync?.session?.indexDoc.getMap("files");
		const key = args.path.slice("Shared/".length);
		const meta = files?.get(key);
		return meta ? { key, id: meta.id } : null;`,
		{ path: SEED },
	);
}

function rev(v, id) {
	return v.eval(
		`return app.plugins.plugins.arcasync?.session?.indexDoc.getMap("docRevs").get(args.id) ?? null;`,
		{ id },
	);
}

function modify(v, text) {
	return v.eval(
		`await app.vault.modify(app.vault.getFileByPath(args.path), args.text); return true;`,
		{ path: SEED, text },
	);
}

/** Index sync's Reconciler adds the seeded file to the index when alice connects. */
function waitIndexed(alice) {
	return waitFor(() => indexEntry(alice), { timeout: 10000, label: "seed indexed" });
}

/** Waits until alice's local changes to the note are acked and announced (rev differs from `before`). */
async function waitRevBumped(alice, id, before) {
	return waitFor(
		async () => {
			const now = await rev(alice, id);
			return now && JSON.stringify(now) !== JSON.stringify(before) ? now : null;
		},
		{ timeout: 15000, label: "alice bumped docRevs" },
	);
}

function waitDisk(v, expected, timeout) {
	return waitFor(() => diskText(v.path, SEED) === expected, {
		timeout,
		label: `${v.name} disk == ${JSON.stringify(expected)} (has ${JSON.stringify(diskText(v.path, SEED))})`,
	});
}

export default {
	name: NAME,
	needs: ["alice", "bob"],
	seed: { alice: { [SEED]: "Seed text\n" } },
	async run({ vaults, step, restartServer }) {
		const { alice, bob } = vaults;

		const entry = await waitIndexed(alice);
		assert.ok(entry?.id, "seed.md has an index entry");
		await waitDisk(bob, "Seed text\n", 15000);
		await new Promise((r) => setTimeout(r, 5000));
		assert.equal(diskText(alice.path, SEED), "Seed text\n");
		assert.equal(diskText(bob.path, SEED), "Seed text\n");
		step("seed enrolled once: bob's disk has it, alice's disk unchanged after 5 s");

		let before;
		await modify(alice, "Seed text\nline2\n");
		await waitDisk(bob, "Seed text\nline2\n", 5000);
		step("closed-note edit on alice reaches bob's disk within 5 s");

		await bob.quit();
		before = await rev(alice, entry.id);
		await modify(alice, "Seed text\nline2\nline3\n");
		await waitRevBumped(alice, entry.id, before);
		await bob.relaunch();
		await waitDisk(bob, "Seed text\nline2\nline3\n", 20000);
		step("bob catches up after a relaunch (docRevs)");

		await bob.quit();
		before = await rev(alice, entry.id);
		await modify(alice, "A-wins\n");
		await waitRevBumped(alice, entry.id, before);
		writeFileSync(join(bob.path, SEED), "B-offline\n");
		await bob.relaunch();
		await waitDisk(bob, "A-wins\n", 20000);
		const folder = join(bob.path, "Shared", NAME);
		const copies = await waitFor(
			() => {
				const found = readdirSync(folder).filter((f) => /^seed \(local copy .+\)\.md$/.test(f));
				return found.length > 0 ? found : null;
			},
			{ timeout: 5000, label: "bob's local copy" },
		);
		await new Promise((r) => setTimeout(r, 3000));
		const settled = readdirSync(folder).filter((f) => /^seed \(local copy .+\)\.md$/.test(f));
		assert.deepEqual(settled, copies, "exactly one local copy");
		assert.equal(settled.length, 1, `local copies: ${settled.join(", ")}`);
		assert.equal(diskText(bob.path, `Shared/${NAME}/${settled[0]}`), "B-offline\n");
		assert.equal(diskText(bob.path, SEED), "A-wins\n");
		assert.equal(diskText(alice.path, SEED), "A-wins\n");
		step(`divergence: bob keeps A-wins and one local copy (${settled[0]}) with B-offline`);

		// Session stop/start and a relay restart with the note warm on bob.
		const errors = [];
		await bob.cdp("Runtime.enable");
		const offConsole = bob.on("Runtime.consoleAPICalled", (e) => {
			const text = e.args.map((a) => a.value ?? a.description ?? "").join(" ");
			if (e.type === "error" && text.includes("ArcaSync")) errors.push(text);
		});
		const command = (id) =>
			bob.eval(`app.commands.executeCommandById(args.id); return true;`, { id });
		await command("arcasync:disconnect");
		await command("arcasync:connect");
		await waitFor(
			() => bob.eval(`return app.plugins.plugins.arcasync.connection?.status === "connected";`),
			{ timeout: 20000, label: "bob reconnected" },
		);
		await modify(alice, "A-wins\nafter reconnect\n");
		await waitDisk(bob, "A-wins\nafter reconnect\n", 15000);
		step("bob converges after disconnect/connect");

		await restartServer();
		await modify(alice, "A-wins\nafter relay restart\n");
		await waitDisk(bob, "A-wins\nafter relay restart\n", 30000);
		offConsole();
		assert.deepEqual(errors, [], "ArcaSync console errors on bob");
		step("bob converges after a relay restart; no ArcaSync console errors");
	},
};
