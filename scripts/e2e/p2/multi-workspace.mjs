// P2-8: one vault maps two workspaces of the same relay. Each workspace has its own socket and
// session, notes stay in their workspace, coediting works in the second one, the status bar shows
// `+1`, and unmapping keeps the files but stops their sync.
import assert from "node:assert/strict";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { diskText, openFile, setCursor, typeKeys } from "../editor.mjs";
import { sleep, waitFor } from "../obsidian.mjs";

const NAME = "multi-workspace";
const SECOND = "Second";
const X = `${SECOND}/x.md`;
const Y = `Shared/${NAME}/y.md`;
const STATUS = `return document.querySelector(".teamsync-status-bar")?.textContent ?? null;`;

/** Workspace ids of the plugin's sessions, with each index doc's sync state and socket count. */
function sessions(v) {
	return v.eval(`const p = app.plugins.plugins.teamsync;
		const list = p.sessions;
		return {
			ids: list.map((s) => s.workspaceId),
			roots: list.map((s) => s.root),
			synced: list.every((s) => s.started && s.indexProvider.synced),
			sockets: new Set(list.map((s) => s.connections)).size,
		};`);
}

function create(v, path, text) {
	return v.eval(
		`const dir = args.path.slice(0, args.path.lastIndexOf("/"));
		if (!app.vault.getFolderByPath(dir)) await app.vault.createFolder(dir);
		await app.vault.create(args.path, args.text);
		return true;`,
		{ path, text },
	);
}

/** Editor texts of every Markdown leaf showing `path`, and how many are bound to their note. */
function leaves(v, path) {
	return v.eval(
		`const ls = app.workspace.getLeavesOfType("markdown").filter((l) => l.view.file?.path === args.path);
		return {
			texts: ls.map((l) => l.view.editor.getValue()),
			live: ls.filter((l) => l.view.editor?.cm?.dom.classList.contains("teamsync-live")).length,
		};`,
		{ path },
	);
}

/** Every `x.md` below `Shared/` in a vault. */
function strayX(v) {
	const found = [];
	const walk = (dir) => {
		if (!existsSync(dir)) return;
		for (const entry of readdirSync(dir, { withFileTypes: true })) {
			const path = join(dir, entry.name);
			if (entry.isDirectory()) walk(path);
			else if (entry.name === "x.md") found.push(path);
		}
	};
	walk(join(v.path, "Shared"));
	return found;
}

const count = (text, word) => text.split(word).length - 1;

export default {
	name: NAME,
	needs: ["alice", "bob"],
	backends: ["cf"],
	async run({ vaults, api, step }) {
		const { alice, bob } = vaults;

		// 1. Both join workspace `second` and map it to `Second/`.
		const login = await api.devLogin("alice", { workspace: "second" });
		await api.devLogin("bob", { workspace: "second" });
		const secondId = login.workspaces.find((w) => w.slug === "second")?.id;
		assert.ok(secondId, `alice is in workspace second: ${JSON.stringify(login.workspaces)}`);
		const primaryId = await alice.eval("return app.plugins.plugins.teamsync.settings.workspaceId;");
		assert.notEqual(secondId, primaryId);
		for (const v of [alice, bob]) {
			const added = await v.eval(
				`const p = app.plugins.plugins.teamsync;
				await p.refreshWorkspaces();
				return await p.addMapping("Second", args.id);`,
				{ id: secondId },
			);
			assert.equal(added, true, `${v.name} addMapping`);
		}
		for (const v of [alice, bob]) {
			const s = await waitFor(
				async () => {
					const r = await sessions(v);
					return r.ids.length === 2 && r.synced ? r : null;
				},
				{ timeout: 10000, label: `${v.name}: two sessions, both index docs synced` },
			);
			assert.deepEqual([...s.ids].sort(), [primaryId, secondId].sort(), `${v.name} workspaces`);
			assert.equal(s.sockets, 2, `${v.name}: one socket per workspace`);
		}
		step("alice and bob: two sessions (Shared → primary, Second → second), one socket each");

		// 2. A note in Second/ syncs through the second workspace only.
		await create(alice, X, "hello second\n");
		await waitFor(() => diskText(bob.path, X) === "hello second\n", {
			timeout: 5000,
			label: `bob ${X} == "hello second\\n" (has ${JSON.stringify(diskText(bob.path, X))})`,
		});
		const inSecond = await alice.eval(
			`const p = app.plugins.plugins.teamsync;
			return { second: p.sessionFor(args.path)?.workspaceId ?? null,
				primary: p.session.fileIdOf(args.path) };`,
			{ path: X },
		);
		assert.equal(inSecond.second, secondId, "Second/x.md belongs to the second workspace");
		assert.equal(inSecond.primary, null, "the primary workspace does not index Second/x.md");
		await sleep(1000);
		for (const v of [alice, bob]) assert.deepEqual(strayX(v), [], `${v.name}: no Shared/**/x.md`);
		step("Second/x.md reaches bob within 5 s; no x.md under Shared/ in either vault");

		// 3. Coediting in the second workspace.
		await openFile(alice, X);
		await openFile(bob, X);
		for (const v of [alice, bob]) {
			await waitFor(async () => (await leaves(v, X)).live >= 1, {
				timeout: 15000,
				label: `${v.name}: editor on ${X} bound`,
			});
		}
		await setCursor(alice, { line: 0, ch: 12 });
		await setCursor(bob, { line: 1, ch: 0 });
		await Promise.all([typeKeys(alice, " A"), typeKeys(bob, " B")]);
		const expected = "hello second A\n B";
		await waitFor(
			async () => {
				for (const v of [alice, bob]) {
					const { texts } = await leaves(v, X);
					if (texts.length === 0 || texts.some((t) => t !== expected)) return null;
				}
				return true;
			},
			{ timeout: 3000, label: `alice and bob editors == ${JSON.stringify(expected)}` },
		);
		for (const v of [alice, bob]) {
			const [text] = (await leaves(v, X)).texts;
			assert.equal(count(text, "A"), 1, `${v.name}: A once`);
			assert.equal(count(text, "B"), 1, `${v.name}: B once`);
		}
		step(`coedit in Second/x.md converges within 3 s: ${JSON.stringify(expected)}`);

		// 4. The primary workspace still syncs.
		await create(alice, Y, "primary\n");
		await waitFor(() => diskText(bob.path, Y) === "primary\n", {
			timeout: 10000,
			label: `bob ${Y}`,
		});
		step("Shared/multi-workspace/y.md still syncs through the primary workspace");

		// 5. Status bar.
		const status = await waitFor(
			async () => {
				const t = await alice.eval(STATUS);
				return /^TeamSync: alice · .+ \+1 · /.test(t ?? "") ? t : null;
			},
			{ timeout: 5000, label: "alice status bar shows +1" },
		);
		step(`status bar: "${status}"`);

		// 6. bob unmaps Second/: his files stay, alice's later edits no longer reach him.
		await bob.eval(`await app.plugins.plugins.teamsync.removeMapping("Second"); return true;`);
		const after = await waitFor(
			async () => {
				const r = await sessions(bob);
				return r.ids.length === 1 && r.synced ? r : null;
			},
			{ timeout: 5000, label: "bob: one session after removeMapping" },
		);
		assert.deepEqual(after.roots, ["Shared"]);
		await waitFor(async () => (await leaves(bob, X)).live === 0, {
			timeout: 5000,
			label: "bob's editor on Second/x.md unbound",
		});
		const bobDisk = diskText(bob.path, X);
		assert.ok(bobDisk?.startsWith("hello second A"), `bob keeps Second/x.md: ${bobDisk}`);
		const bobEditor = (await leaves(bob, X)).texts[0];

		await setCursor(alice, { line: 0, ch: 0 });
		await typeKeys(alice, "after ");
		// alice's edit is on the relay (acked) before bob's side is checked.
		await waitFor(
			() =>
				alice.eval(
					`const s = app.plugins.plugins.teamsync.sessionFor(args.path);
					const note = await s.docs.peek(s.fileIdOf(args.path));
					return note.ytext.toString().startsWith("after ") && !note.provider.hasUnsyncedChanges;`,
					{ path: X },
				),
			{ timeout: 5000, label: "alice's edit acked by the relay" },
		);
		await sleep(3000);
		assert.equal(diskText(bob.path, X), bobDisk, "bob's Second/x.md unchanged on disk");
		assert.equal((await leaves(bob, X)).texts[0], bobEditor, "bob's editor unchanged");
		step("bob unmapped Second/: one session, files kept, alice's later edit does not reach him");

		// alice unmaps Second/ from the settings tab: one row per mapping, each with Remove.
		await alice.eval('app.setting.open(); app.setting.openTabById("teamsync"); return true;');
		try {
			const rows = await waitFor(
				() =>
					alice.eval(`// The settings tab may live in its own window: query its container.
						const el = app.setting.activeTab?.id === "teamsync" ? app.setting.activeTab.containerEl : null;
						const rows = [...(el?.querySelectorAll(".teamsync-mapping") ?? [])].map((row) => ({
							folder: row.querySelector(".teamsync-shared-folder")?.value ?? null,
							remove: !!row.querySelector(".teamsync-mapping-remove"),
						}));
						return rows.length === 2 ? rows : null;`),
				{ timeout: 5000, label: "alice settings tab shows two mapping rows" },
			);
			assert.deepEqual(rows, [
				{ folder: "Shared", remove: true },
				{ folder: "Second", remove: true },
			]);
			await alice.eval(`const el = app.setting.activeTab.containerEl;
				el.querySelectorAll(".teamsync-mapping")[1].querySelector(".teamsync-mapping-remove").click();
				return true;`);
			await waitFor(async () => (await sessions(alice)).ids.length === 1, {
				timeout: 5000,
				label: "alice: one session after Remove",
			});
		} finally {
			await alice.eval("app.setting.close(); return true;");
		}
		assert.equal(diskText(alice.path, X)?.startsWith("after hello second A"), true);
		step("alice removes the Second/ row in settings: one session, her files kept");

		// Cleanup: both close their editors.
		for (const v of [alice, bob]) {
			await v.eval(
				`for (const l of app.workspace.getLeavesOfType("markdown")) l.detach(); return true;`,
			);
		}
	},
};
