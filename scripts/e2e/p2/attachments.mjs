// P2-11: binaries sync through R2 chunks. A 300 KiB image and a 9 MiB file arrive byte-identical;
// a rename costs no chunk upload; a modify propagates; an offline edit on both sides keeps the
// server's bytes plus one conflict copy everywhere; a viewer cannot upload; a delete keeps the
// chunks (GC grace).
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { notices } from "../editor.mjs";
import { sleep, waitFor } from "../obsidian.mjs";

const NAME = "attachments";
const FOLDER = `Shared/${NAME}`;
const IMG = `${FOLDER}/img.png`;
const PIC = `${FOLDER}/pic.png`;
const BIG = `${FOLDER}/big.bin`;
const CAROL = `${FOLDER}/carol.png`;

/** Writes `size` random bytes (generated in the page) through the vault API; returns them. */
async function writeRandom(v, path, size, { modify = false } = {}) {
	const b64 = await v.eval(
		`const buf = new Uint8Array(args.size);
		for (let i = 0; i < buf.length; i += 65536) crypto.getRandomValues(buf.subarray(i, i + 65536));
		const folder = args.path.slice(0, args.path.lastIndexOf("/"));
		if (!app.vault.getFolderByPath(folder)) await app.vault.createFolder(folder);
		const file = app.vault.getFileByPath(args.path);
		if (args.modify) await app.vault.modifyBinary(file, buf.buffer);
		else await app.vault.createBinary(args.path, buf.buffer);
		let s = "";
		for (let i = 0; i < buf.length; i += 32768) s += String.fromCharCode(...buf.subarray(i, i + 32768));
		return btoa(s);`,
		{ path, size, modify },
	);
	return Buffer.from(b64, "base64");
}

function disk(v, path) {
	try {
		return readFileSync(join(v.path, path));
	} catch (error) {
		if (error.code === "ENOENT") return null;
		throw error;
	}
}

function waitBytes(v, path, expected, timeout) {
	return waitFor(() => disk(v, path)?.equals(expected) ?? false, {
		timeout,
		label: `${v.name} ${path} == ${expected.length} expected bytes (has ${disk(v, path)?.length ?? "none"})`,
	});
}

function waitGone(v, path, timeout) {
	return waitFor(() => disk(v, path) === null, { timeout, label: `${v.name} has no ${path}` });
}

function conflicts(v) {
	return readdirSync(join(v.path, FOLDER)).filter((f) => /^pic \(conflict .+\)\.png$/.test(f));
}

/** The index entry for a vault path, and whether the relay acked every local index change. */
function entry(v, path) {
	return v.eval(
		`const s = app.plugins.plugins.teamsync?.session;
		const meta = s?.index?.get(args.path.slice("Shared/".length)) ?? null;
		return { meta, acked: !!s && !s.indexProvider.hasUnsyncedChanges };`,
		{ path },
	);
}

async function chunkCount(api, ws) {
	const { objects } = await api.debugChunks(ws);
	assert.ok(
		objects.every((o) => o.key.startsWith(`ws/${ws}/`)),
		"every key is under ws/<id>/",
	);
	return objects.length;
}

export default {
	name: NAME,
	needs: ["alice", "bob", "carol"],
	backends: ["cf"],
	async run({ vaults, api, step }) {
		const { alice, bob, carol } = vaults;
		const ws = await alice.eval("return app.plugins.plugins.teamsync.session.workspaceId;");
		const initial = await chunkCount(api, ws);

		// 1. Two binaries, one of three chunks.
		const img = await writeRandom(alice, IMG, 300 * 1024);
		const big = await writeRandom(alice, BIG, 9 * 1024 * 1024);
		await waitBytes(bob, IMG, img, 20000);
		await waitBytes(bob, BIG, big, 20000);
		const uploaded = await chunkCount(api, ws);
		assert.ok(uploaded - initial >= 4, `≥ 4 new chunk objects (${initial} → ${uploaded})`);
		step(`300 KiB and 9 MiB binaries byte-identical on bob; ${uploaded - initial} chunk objects`);

		// 2. A rename is an index change only.
		await bob.eval(
			`await app.fileManager.renameFile(app.vault.getFileByPath(args.from), args.to); return true;`,
			{ from: IMG, to: PIC },
		);
		await waitBytes(alice, PIC, img, 5000);
		await waitGone(alice, IMG, 5000);
		assert.equal(await chunkCount(api, ws), uploaded, "the rename uploaded no chunk");
		step("bob's rename img.png → pic.png reaches alice with no new chunk objects");

		// 3. A modify propagates.
		const v3 = await writeRandom(bob, PIC, 200 * 1024, { modify: true });
		await waitBytes(alice, PIC, v3, 10000);
		step("bob's new bytes for pic.png reach alice");

		// 4. Offline edits on both sides: alice's (the server's) bytes win, bob's stay in a copy.
		await waitFor(async () => (await entry(bob, PIC)).acked, {
			timeout: 5000,
			label: "bob's index acked",
		});
		await bob.quit();
		const before = (await entry(alice, PIC)).meta?.hash;
		const ours = await writeRandom(alice, PIC, 250 * 1024, { modify: true });
		await waitFor(
			async () => {
				const { meta, acked } = await entry(alice, PIC);
				return meta && meta.hash !== before && acked;
			},
			{ timeout: 10000, label: "alice's new pic.png indexed and acked" },
		);
		const theirs = randomBytes(150 * 1024);
		writeFileSync(join(bob.path, PIC), theirs);
		await bob.relaunch();
		for (const v of [alice, bob]) await waitBytes(v, PIC, ours, 20000);
		for (const v of [alice, bob]) {
			await waitFor(() => conflicts(v).length > 0, {
				timeout: 20000,
				label: `${v.name} has a conflict copy of pic.png`,
			});
		}
		await sleep(2000);
		for (const v of [alice, bob]) {
			const copies = conflicts(v);
			assert.equal(copies.length, 1, `${v.name}: one conflict copy (${copies.join(", ")})`);
			assert.ok(
				disk(v, `${FOLDER}/${copies[0]}`).equals(theirs),
				`${v.name}: copy holds bob's bytes`,
			);
			assert.ok(disk(v, PIC).equals(ours), `${v.name}: pic.png holds alice's bytes`);
		}
		step(`offline edits: pic.png is alice's everywhere, bob's bytes in ${conflicts(bob)[0]}`);

		// 5. A viewer's new file is neither uploaded nor indexed.
		const chunksBefore = await chunkCount(api, ws);
		await writeRandom(carol, CAROL, 10 * 1024);
		await waitFor(async () => (await notices(carol)).some((n) => n.includes("only view")), {
			timeout: 5000,
			label: "carol is told she cannot upload",
		});
		await sleep(5000);
		assert.equal(disk(alice, CAROL), null, "alice has no carol.png");
		assert.equal(await chunkCount(api, ws), chunksBefore, "no chunk uploaded by the viewer");
		step("carol (viewer) gets a Notice; nothing uploaded, alice has no carol.png");

		// 6. A delete removes the file everywhere; its chunks wait for GC.
		const chunksBeforeDelete = await chunkCount(api, ws);
		await alice.eval(
			`await app.fileManager.trashFile(app.vault.getFileByPath(args.path)); return true;`,
			{ path: BIG },
		);
		await waitGone(bob, BIG, 5000);
		assert.equal(await chunkCount(api, ws), chunksBeforeDelete, "big.bin's chunks stay in R2");
		step("alice trashes big.bin: gone on bob, chunks kept for the GC grace period");
	},
};
