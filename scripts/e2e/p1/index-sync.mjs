// P1-2: `.md` create, rename and delete propagate between vaults through the index doc, also
// while the other vault is closed, and a settled index writes no relay rows.
import { diskText } from "../editor.mjs";
import { sleep, waitConnected, waitFor } from "../obsidian.mjs";

const FOLDER = "Shared/index-sync";

function create(v, name) {
	return v.eval(
		`if (!app.vault.getFolderByPath(args.dir)) await app.vault.createFolder(args.dir);
		await app.vault.create(args.dir + "/" + args.name, ""); return true;`,
		{ dir: FOLDER, name },
	);
}

function rename(v, from, to) {
	return v.eval(
		// The file can reach disk a moment before Obsidian's vault cache registers it.
		`let f = null;
		for (let i = 0; i < 50 && !(f = app.vault.getFileByPath(args.from)); i++) await new Promise((r) => setTimeout(r, 100));
		if (!f) throw new Error("no such file: " + args.from);
		await app.fileManager.renameFile(f, args.to); return true;`,
		{ from: `${FOLDER}/${from}`, to: `${FOLDER}/${to}` },
	);
}

function trash(v, name) {
	return v.eval(
		`let f = null;
		for (let i = 0; i < 50 && !(f = app.vault.getFileByPath(args.path)); i++) await new Promise((r) => setTimeout(r, 100));
		if (!f) throw new Error("no such file: " + args.path);
		await app.fileManager.trashFile(f); return true;`,
		{ path: `${FOLDER}/${name}` },
	);
}

const exists = (v, rel) => diskText(v.path, rel) !== null;

/** Waits until `fn()` holds on disk; `what` names it in the timeout message. */
function waitDisk(fn, what, timeout = 5000) {
	return waitFor(() => fn(), { timeout, interval: 100, label: what });
}

/** The relay holds every index change this vault made (its index provider has no unacked batch). */
function waitAcked(v) {
	return waitFor(
		() =>
			v.eval(`const s = app.plugins.plugins.teamsync?.session;
				return !!s?.started && s.indexProvider.synced && !s.indexProvider.hasUnsyncedChanges;`),
		{ timeout: 10000, label: `${v.name} index changes acked` },
	);
}

/** True once the vault's acked `known` record lists `name` (so a quit cannot lose it). */
function waitKnown(v, name) {
	return waitFor(
		() =>
			v.eval(
				`const p = app.plugins.plugins.teamsync;
				const raw = localStorage.getItem("teamsync:" + app.appId + ":" + p.settings.workspaceId + ":known");
				return !!raw && args.path in (JSON.parse(raw).files ?? {});`,
				{ path: `index-sync/${name}` },
			),
		{ timeout: 10000, label: `${v.name} known lists ${name}` },
	);
}

async function relaunch(v) {
	await v.relaunch();
	await waitConnected(v);
}

export default {
	name: "index-sync",
	needs: ["alice", "bob"],
	async run(ctx) {
		const { alice, bob } = ctx.vaults;
		const rel = (name) => `${FOLDER}/${name}`;

		await create(alice, "a.md");
		await waitDisk(() => exists(bob, rel("a.md")), "bob has a.md");
		ctx.step("alice creates a.md → bob has it");

		await rename(bob, "a.md", "b.md");
		await waitDisk(
			() => exists(alice, rel("b.md")) && !exists(alice, rel("a.md")),
			"alice has b.md and no a.md",
		);
		ctx.step("bob renames a.md → b.md → alice follows");

		await trash(alice, "b.md");
		await waitDisk(
			() => !exists(bob, rel("b.md")) && exists(bob, ".trash/b.md"),
			"bob has .trash/b.md and no b.md",
		);
		ctx.step("alice trashes b.md → bob trashes it too");

		await create(alice, "d.md");
		await waitDisk(() => exists(bob, rel("d.md")), "bob has d.md");
		await waitKnown(bob, "d.md");
		await bob.quit();
		await create(alice, "c.md");
		await sleep(1000); // past the create debounce, so c.md is indexed before d.md goes
		await trash(alice, "d.md");
		await waitAcked(alice);
		await relaunch(bob);
		await waitDisk(
			() => exists(bob, rel("c.md")) && !exists(bob, rel("d.md")),
			"bob has c.md and no d.md after relaunch",
			20000,
		);
		ctx.step("bob closed while alice creates c.md and trashes d.md → bob converges on relaunch");

		await alice.quit();
		await create(bob, "e.md");
		await waitAcked(bob);
		await relaunch(alice);
		await waitDisk(() => exists(alice, rel("e.md")), "alice has e.md after relaunch", 20000);
		ctx.step("alice closed while bob creates e.md → alice has it on relaunch");

		if (ctx.server.backend !== "cf") {
			console.log("  - SKIP echo-loop check (needs relay-cf debug stats)");
			return;
		}
		const ws = await alice.eval("return app.plugins.plugins.teamsync.settings.workspaceId;");
		const rows = async () => {
			const r = await fetch(`${ctx.server.url}/api/debug/stats?ws=${encodeURIComponent(ws)}`);
			if (!r.ok) throw new Error(`debug stats: HTTP ${r.status}`);
			return (await r.json()).app_rows_written;
		};
		await sleep(5000);
		const before = await rows();
		await sleep(10000);
		const after = await rows();
		if (after !== before) throw new Error(`index not quiet: ${after - before} rows in 10 s idle`);
		ctx.step(`echo-loop check: 0 rows written in 10 s idle (total ${after})`);
	},
};
