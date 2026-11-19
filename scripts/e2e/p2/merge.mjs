// P2-7: offline edits of a closed note on both sides are 3-way merged when they touch different
// lines (no local copy), and keep P1's local copy when they touch the same line.
import assert from "node:assert/strict";
import { readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { diskText } from "../editor.mjs";
import { waitFor } from "../obsidian.mjs";

const NAME = "merge";
const FOLDER = `Shared/${NAME}`;
const M = `${FOLDER}/m.md`;
const C = `${FOLDER}/c.md`;
const SEED = "A\nB\nC\n";

function fileId(v, path) {
	return v.eval(`return app.plugins.plugins.arcasync?.session?.fileIdOf(args.path) ?? null;`, {
		path,
	});
}

function rev(v, id) {
	return v.eval(
		`return app.plugins.plugins.arcasync?.session?.indexDoc.getMap("docRevs").get(args.id) ?? null;`,
		{ id },
	);
}

/**
 * The merge base bob's note doc keeps in IndexedDB. The note is acquired for the read: after a
 * session restart (an earlier scenario's sign-out) an up-to-date note is not attached.
 */
function base(v, path) {
	return v.eval(
		`const s = app.plugins.plugins.arcasync?.session;
		const id = s?.fileIdOf(args.path);
		if (!id || !s.docs) return null;
		const note = await s.docs.acquire(id, args.path);
		try {
			return (await note.getLastSyncedText()) ?? null;
		} finally {
			s.docs.release(note);
		}`,
		{ path },
	);
}

function modify(v, path, text) {
	return v.eval(
		`await app.vault.modify(app.vault.getFileByPath(args.path), args.text); return true;`,
		{ path, text },
	);
}

function waitDisk(v, path, expected, timeout) {
	return waitFor(() => diskText(v.path, path) === expected, {
		timeout,
		label: `${v.name} ${path} == ${JSON.stringify(expected)} (has ${JSON.stringify(diskText(v.path, path))})`,
	});
}

function copies(v, stem) {
	const pattern = new RegExp(`^${stem} \\(local copy .+\\)\\.md$`);
	return readdirSync(join(v.path, FOLDER)).filter((f) => pattern.test(f));
}

export default {
	name: NAME,
	needs: ["alice", "bob"],
	seed: { alice: { [M]: SEED, [C]: SEED } },
	async run({ vaults, step }) {
		const { alice, bob } = vaults;

		const ids = {};
		for (const path of [M, C]) {
			ids[path] = await waitFor(() => fileId(alice, path), {
				timeout: 10000,
				label: `${path} indexed`,
			});
			await waitDisk(bob, path, SEED, 15000);
			await waitFor(async () => (await base(bob, path)) === SEED, {
				timeout: 15000,
				label: `bob keeps the base of ${path}`,
			});
		}
		assert.equal(diskText(alice.path, M), SEED);
		step("m.md and c.md on both disks; bob's IndexedDB holds the merge base");

		await bob.quit();
		const before = { [M]: await rev(alice, ids[M]), [C]: await rev(alice, ids[C]) };
		await modify(alice, M, "A1\nB\nC\n");
		await modify(alice, C, "A\nB-alice\nC\n");
		for (const path of [M, C]) {
			await waitFor(
				async () => {
					const now = await rev(alice, ids[path]);
					return now && JSON.stringify(now) !== JSON.stringify(before[path]);
				},
				{ timeout: 15000, label: `alice bumped docRevs of ${path}` },
			);
		}
		writeFileSync(join(bob.path, M), "A\nB\nC3\n");
		writeFileSync(join(bob.path, C), "A\nB-bob\nC\n");
		await bob.relaunch();

		await waitDisk(bob, M, "A1\nB\nC3\n", 20000);
		await waitDisk(alice, M, "A1\nB\nC3\n", 20000);
		await waitDisk(bob, C, "A\nB-alice\nC\n", 20000);
		const cCopies = await waitFor(
			() => {
				const found = copies(bob, "c");
				return found.length > 0 ? found : null;
			},
			{ timeout: 5000, label: "bob's local copy of c.md" },
		);
		await new Promise((r) => setTimeout(r, 3000));

		for (const v of [alice, bob]) {
			assert.deepEqual(copies(v, "m"), [], `${v.name}: no local copy of m.md`);
			assert.equal(diskText(v.path, M), "A1\nB\nC3\n", `${v.name}: m.md merged`);
		}
		step("disjoint offline edits of m.md merge on both disks with no local copy");

		assert.deepEqual(copies(bob, "c"), cCopies, "c.md: no second local copy");
		assert.equal(cCopies.length, 1, `c.md local copies: ${cCopies.join(", ")}`);
		assert.equal(diskText(bob.path, `${FOLDER}/${cCopies[0]}`), "A\nB-bob\nC\n");
		assert.equal(diskText(bob.path, C), "A\nB-alice\nC\n");
		assert.equal(diskText(alice.path, C), "A\nB-alice\nC\n");
		step(`same-line edits of c.md keep the server text and one local copy (${cCopies[0]})`);
	},
};
