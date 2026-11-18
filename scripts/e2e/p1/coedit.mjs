// P1-4: Markdown editors bound to the note CRDT. Concurrent typing converges without duplication,
// undo only undoes local edits, split panes and file switches rebind, and a viewer cannot edit.
import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import {
	diskText,
	editorText,
	openFile,
	pressKey,
	screenshot,
	setCursor,
	typeKeys,
	waitEditorText,
} from "../editor.mjs";
import { sleep, waitFor } from "../obsidian.mjs";

const NAME = "coedit";
const DIR = `Shared/${NAME}`;
const CO = `${DIR}/co.md`;
const OTHER = `${DIR}/other.md`;
const SEED = "Line one\nLine two\n";

/** Texts of every Markdown leaf showing `path`. */
function leafTexts(v, path) {
	return v.eval(
		`return app.workspace.getLeavesOfType("markdown")
			.filter((l) => l.view.file?.path === args.path)
			.map((l) => l.view.editor.getValue());`,
		{ path },
	);
}

/** Leaves showing `path` whose editor is bound to the note (`.teamsync-live`). */
function liveLeaves(v, path) {
	return v.eval(
		`return app.workspace.getLeavesOfType("markdown")
			.filter((l) => l.view.file?.path === args.path && l.view.editor?.cm?.dom.classList.contains("teamsync-live"))
			.length;`,
		{ path },
	);
}

function activeLive(v) {
	return v.eval(
		`return !!app.workspace.activeEditor?.editor?.cm?.dom.classList.contains("teamsync-live");`,
	);
}

async function waitLive(v, path = CO, count = 1) {
	await waitFor(async () => (await liveLeaves(v, path)) >= count && (await activeLive(v)), {
		timeout: 15000,
		label: `${v.name}: ${count} bound editor(s) on ${path}`,
	});
}

async function waitAllEqual(vaults, expected, { timeout = 5000, disk = false } = {}) {
	return waitFor(
		async () => {
			for (const v of vaults) {
				const texts = await leafTexts(v, CO);
				if (texts.length === 0 || texts.some((t) => t !== expected)) return null;
				if (disk && diskText(v.path, CO) !== expected) return null;
			}
			return true;
		},
		{
			timeout,
			label: `${vaults.map((v) => v.name)} ${disk ? "editors and disks" : "editors"} == ${JSON.stringify(expected)}`,
		},
	);
}

function count(text, word) {
	return text.split(word).length - 1;
}

/** Fails if a vault has any `(local copy …)` file under the scenario folder. */
function assertNoLocalCopies(v) {
	const files = readdirSync(join(v.path, DIR));
	const copies = files.filter((f) => f.includes("(local copy"));
	assert.deepEqual(copies, [], `${v.name} local copies`);
}

/** Collects TeamSync console errors; returns `stop()` which yields them. */
async function watchErrors(v) {
	const errors = [];
	await v.cdp("Runtime.enable");
	const off = v.on("Runtime.consoleAPICalled", (e) => {
		const text = e.args.map((a) => a.value ?? a.description ?? "").join(" ");
		if (e.type === "error" && text.includes("TeamSync")) errors.push(text);
	});
	return () => {
		off();
		return errors;
	};
}

function closeLeaves(v) {
	return v.eval(`
		for (const leaf of app.workspace.getLeavesOfType("markdown")) leaf.detach();
		return true;`);
}

export default {
	name: NAME,
	needs: ["alice", "bob", "carol"],
	seed: { alice: { [CO]: SEED, [OTHER]: "Other note\n" } },
	async run({ vaults, step, artifacts }) {
		const { alice, bob, carol } = vaults;
		const stops = [await watchErrors(alice), await watchErrors(bob)];
		try {
			await waitFor(() => diskText(bob.path, CO) === SEED && diskText(bob.path, OTHER) !== null, {
				timeout: 20000,
				label: "bob has co.md and other.md",
			});

			// 1. Concurrent typing on different lines.
			await openFile(alice, CO);
			await openFile(bob, CO);
			await Promise.all([waitLive(alice), waitLive(bob)]);
			await setCursor(alice, { line: 0, ch: 8 });
			await setCursor(bob, { line: 1, ch: 8 });
			await Promise.all([typeKeys(alice, " alpha"), typeKeys(bob, " beta")]);
			let expected = "Line one alpha\nLine two beta\n";
			await waitAllEqual([alice, bob], expected, { timeout: 3000 });
			for (const v of [alice, bob]) {
				const text = await editorText(v);
				assert.equal(count(text, "alpha"), 1, `${v.name}: alpha once`);
				assert.equal(count(text, "beta"), 1, `${v.name}: beta once`);
			}
			await sleep(3000);
			await waitAllEqual([alice, bob], expected, { timeout: 3000, disk: true });
			step("concurrent typing converges in both editors and on both disks, each word once");

			// 2. Latency of one keystroke.
			const started = Date.now();
			await typeKeys(alice, "X");
			await waitFor(async () => (await editorText(bob))?.includes("X"), {
				timeout: 4000,
				interval: 20,
				label: "bob sees X",
			});
			const latency = Date.now() - started;
			assert.ok(latency <= 2000, `keystroke latency ${latency} ms > 2000 ms`);
			expected = "Line one alphaX\nLine two beta\n";
			await waitAllEqual([alice, bob], expected);
			step(`keystroke latency alice → bob: ${latency} ms`);

			// 3. Undo is local: alice's Cmd-Z removes her words only.
			for (let i = 0; i < 10 && (await editorText(alice)).includes("alpha"); i++) {
				await pressKey(alice, "z", { meta: true });
				await sleep(300);
			}
			expected = "Line one\nLine two beta\n";
			await waitAllEqual([alice, bob], expected);
			// Obsidian's undo command path (menu, mobile toolbar) must not undo bob's edits either.
			await setCursor(bob, { line: 1, ch: 13 });
			await typeKeys(bob, " (b)");
			expected = "Line one\nLine two beta (b)\n";
			await waitAllEqual([alice, bob], expected);
			await alice.eval(`app.workspace.activeEditor.editor.undo(); return true;`);
			await sleep(1500);
			for (const v of [alice, bob]) {
				const text = await editorText(v);
				assert.ok(text.includes("Line two beta (b)"), `${v.name} kept bob's edits: ${text}`);
				assert.ok(!text.includes("alpha"), `${v.name}: alpha stays undone: ${text}`);
			}
			await waitAllEqual([alice, bob], expected);
			step("Cmd-Z and editor.undo() in alice undo only alice's edits");

			// 4. Split panes: both of alice's leaves are bound; typing in either converges.
			await openFile(alice, CO, { split: true });
			await waitLive(alice, CO, 2);
			await setCursor(bob, { line: 1, ch: 17 });
			await typeKeys(bob, " gamma");
			expected = "Line one\nLine two beta (b) gamma\n";
			await waitAllEqual([alice, bob], expected);
			assert.equal((await leafTexts(alice, CO)).length, 2, "alice shows co.md twice");
			// Long enough for Obsidian's autosave and its cross-pane sync to run mid-typing.
			await setCursor(alice, { line: 0, ch: 8 });
			await Promise.all([
				typeKeys(alice, " delta epsilon zeta eta", { cps: 7 }),
				typeKeys(bob, " theta iota kappa", { cps: 6 }),
			]);
			expected = "Line one delta epsilon zeta eta\nLine two beta (b) gamma theta iota kappa\n";
			await waitAllEqual([alice, bob], expected, { timeout: 4000 });
			await sleep(3000);
			await waitAllEqual([alice, bob], expected, { timeout: 4000, disk: true });
			await screenshot(alice, join(artifacts, "split.png"));
			step("split panes: both alice leaves follow bob, concurrent typing converges, disks too");

			// 5. Rebind: alice (one leaf again) switches away and back while bob keeps typing.
			await closeLeaves(alice);
			await openFile(alice, CO);
			await waitLive(alice);
			await setCursor(bob, { line: 1, ch: expected.split("\n")[1].length });
			const typing = typeKeys(bob, " lambda mu nu xi omicron", { cps: 6 });
			await sleep(800);
			await openFile(alice, OTHER);
			await sleep(1500);
			await openFile(alice, CO);
			await waitLive(alice);
			await typing;
			expected =
				"Line one delta epsilon zeta eta\nLine two beta (b) gamma theta iota kappa lambda mu nu xi omicron\n";
			await waitAllEqual([alice, bob], expected, { timeout: 4000 });
			await typeKeys(bob, "!");
			expected = expected.replace("omicron\n", "omicron!\n");
			await waitAllEqual([alice, bob], expected, { timeout: 3000 });
			await sleep(3000);
			await waitAllEqual([alice, bob], expected, { timeout: 4000, disk: true });
			for (const v of [alice, bob]) assertNoLocalCopies(v);
			assert.equal(diskText(alice.path, OTHER), "Other note\n");
			step("file switch away and back rebinds; bob's typing meanwhile lands once, no local copies");

			// 6. Viewer: carol's editor is read-only and her keys change nothing.
			await waitFor(() => diskText(carol.path, CO) === expected, {
				timeout: 20000,
				label: "carol has co.md",
			});
			await openFile(carol, CO);
			await waitLive(carol);
			const readOnly = await carol.eval(
				"return app.workspace.activeEditor.editor.cm.state.readOnly;",
			);
			assert.equal(readOnly, true, "carol's editor is read-only");
			await waitEditorText(carol, expected);
			await carol.eval("app.workspace.activeEditor.editor.cm.focus(); return true;");
			await typeKeys(carol, "zzz");
			await sleep(2000);
			assert.equal(await editorText(carol), expected, "carol's editor unchanged");
			await waitAllEqual([alice, bob], expected);
			step("viewer carol: read-only editor, typing changes nothing anywhere");

			for (const v of [alice, bob, carol]) assertNoLocalCopies(v);
			const errors = stops.flatMap((stop) => stop());
			assert.deepEqual(errors, [], "TeamSync console errors");
		} finally {
			for (const stop of stops) stop();
			for (const v of [alice, bob, carol]) if (v.running) await closeLeaves(v);
		}
	},
};
