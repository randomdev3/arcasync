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
		`const files = app.plugins.plugins.teamsync?.session?.indexDoc.getMap("files");
		const key = args.path.slice("Shared/".length);
		const meta = files?.get(key);
		return meta ? { key, id: meta.id } : null;`,
		{ path: SEED },
	);
}

function rev(v, id) {
	return v.eval(
		`return app.plugins.plugins.teamsync?.session?.indexDoc.getMap("docRevs").get(args.id) ?? null;`,
		{ id },
	);
}

function modify(v, text) {
	return v.eval(
		`await app.vault.modify(app.vault.getFileByPath(args.path), args.text); return true;`,
		{ path: SEED, text },
	);
}

/**
 * Index sync (lane A's Reconciler) adds a file found on disk to the index. Until that lane
 * merges, add the entry the way it would; afterwards the entry is already there.
 */
async function ensureIndexed(alice) {
	try {
		return await waitFor(() => indexEntry(alice), { timeout: 5000, label: "seed indexed" });
	} catch {
		await alice.eval(
			`const p = app.plugins.plugins.teamsync;
			const id = Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => "abcdefghijklmnopqrstuvwxyz0123456789"[b % 36]).join("");
			p.session.indexDoc.getMap("files").set(args.key, { id, kind: "md", updatedBy: p.settings.user.id, updatedAt: Date.now() });
			return true;`,
			{ key: SEED.slice("Shared/".length) },
		);
		return indexEntry(alice);
	}
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
	async run({ vaults, step }) {
		const { alice, bob } = vaults;

		const entry = await ensureIndexed(alice);
		assert.ok(entry?.id, "seed.md has an index entry");
		await waitDisk(bob, "Seed text\n", 15000);
		await new Promise((r) => setTimeout(r, 5000));
		assert.equal(diskText(alice.path, SEED), "Seed text\n");
		assert.equal(diskText(bob.path, SEED), "Seed text\n");
		step("seed enrolled once: bob's disk has it, alice's disk unchanged after 5 s");

		let before = await rev(alice, entry.id);
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
	},
};
