// P1-6: bob's caret and selection show in alice's editor in bob's colour with his name, in Live
// Preview and in source mode; alice never sees her own caret.
import assert from "node:assert/strict";
import { join } from "node:path";
import { userColor } from "../../../packages/shared/dist/index.js";
import {
	carets,
	diskText,
	editorText,
	openFile,
	readPng,
	screenshot,
	selectRange,
	setCursor,
	waitEditorText,
} from "../editor.mjs";
import { waitFor } from "../obsidian.mjs";

const NAME = "cursors";
const NOTE = `Shared/${NAME}/cur.md`;
const OTHER = `Shared/${NAME}/other.md`;
const TEXT = "Line one\nLine two\nLine three\n";

const USER_ID = "return app.plugins.plugins.teamsync.settings.user?.id ?? null;";

function rgb(hex) {
	const n = Number.parseInt(hex.slice(1, 7), 16);
	return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/** `cm.coordsAtPos` of 0-based `{line, ch}` in the active editor. */
function coordsAt(v, pos) {
	return v.eval(
		`const cm = app.workspace.activeEditor.editor.cm;
		const at = cm.state.doc.line(args.pos.line + 1).from + args.pos.ch;
		const c = cm.coordsAtPos(at);
		return c ? { left: c.left, top: c.top, bottom: c.bottom } : null;`,
		{ pos },
	);
}

function livePreview(v) {
	return v.eval(`const el = app.workspace.activeLeaf?.view?.containerEl
		?.querySelector(".markdown-source-view");
		return el ? el.classList.contains("is-live-preview") : null;`);
}

/**
 * Switches the active leaf between Live Preview and source mode through its view state (`source`);
 * the `livePreview` vault config only sets the default for newly opened notes.
 */
async function setLivePreview(v, on) {
	await v.eval(
		`const leaf = app.workspace.activeLeaf;
		const vs = leaf.getViewState();
		await leaf.setViewState({ ...vs, state: { ...vs.state, mode: "source", source: !args.on } });
		return true;`,
		{ on },
	);
	await waitFor(async () => (await livePreview(v)) === on, {
		timeout: 5000,
		label: `${v.name} live preview ${on}`,
	});
}

/** Waits until alice shows exactly one caret, named bob, at `pos`; returns it. */
async function bobCaretAt(alice, bob, pos) {
	const color = `rgb(${rgb(bob.color).join(", ")})`;
	return waitFor(
		async () => {
			const list = await carets(alice);
			if (list.length !== 1 || list[0].name !== "bob" || list[0].color !== color) return null;
			const c = await coordsAt(alice, pos);
			const r = list[0].rect;
			const ok = c && Math.abs(r.x - c.left) <= 3 && Math.abs(r.y - c.top) <= 3;
			return ok ? { ...list[0], coords: c } : null;
		},
		{ timeout: 5000, label: `alice shows one bob caret at ${JSON.stringify(pos)}` },
	);
}

export default {
	name: NAME,
	needs: ["alice", "bob"],
	seed: { alice: { [NOTE]: TEXT, [OTHER]: "Other\n" } },
	async run({ vaults, step, artifacts }) {
		const { alice, bob } = vaults;
		const bobId = await bob.eval(USER_ID);
		assert.ok(bobId, "bob has a user id");
		const bobUser = { id: bobId, ...userColor(bobId) };

		await waitFor(() => diskText(bob.path, NOTE) === TEXT, {
			timeout: 15000,
			label: "bob has the seeded note",
		});
		try {
			for (const v of [alice, bob]) {
				await openFile(v, NOTE);
				await waitEditorText(v, TEXT, { timeout: 10000 });
			}
			assert.equal(await livePreview(alice), true, "alice starts in Live Preview");

			const pos = { line: 1, ch: 4 };
			await setCursor(bob, pos);
			const caret = await bobCaretAt(alice, bobUser, pos);
			step(`Live Preview: one bob caret in ${caret.color} at ${JSON.stringify(caret.rect)}`);

			// Pixel check; screenshots are 2x DPR, so scan every pixel of the clip.
			const r = caret.rect;
			const file = await screenshot(alice, join(artifacts, "caret.png"), {
				x: r.x - 2,
				y: r.y - 2,
				width: r.width + 4,
				height: r.height + 4,
			});
			const png = readPng(file);
			const [cr, cg, cb] = rgb(bobUser.color);
			let hits = 0;
			for (let i = 0; i < png.data.length; i += 4) {
				const d = Math.hypot(png.data[i] - cr, png.data[i + 1] - cg, png.data[i + 2] - cb);
				if (d <= 60) hits++;
			}
			assert.ok(hits >= 1, `no pixel near ${bobUser.color} in ${file}`);
			step(`pixel check: ${hits} pixel(s) near ${bobUser.color} in the caret clip`);

			// Hidden until ready: the gate class hides carets, and a rebind applies it then lifts it.
			const gateHides = await alice.eval(`const ed = document.querySelector(".cm-editor");
				ed.classList.add("teamsync-carets-pending");
				const caret = ed.querySelector(".cm-ySelectionCaret");
				const display = caret ? getComputedStyle(caret).display : null;
				ed.classList.remove("teamsync-carets-pending");
				return display;`);
			assert.equal(gateHides, "none", "the not-ready gate hides remote carets");
			await alice.eval(`window.__tsGate = [];
				window.__tsGateObserver = new MutationObserver((records) => {
					for (const r of records) if (r.target.classList?.contains("cm-editor"))
						window.__tsGate.push((r.oldValue ?? "").includes("teamsync-carets-pending"));
				});
				window.__tsGateObserver.observe(document.body,
					{ subtree: true, attributes: true, attributeFilter: ["class"], attributeOldValue: true });
				return true;`);
			await openFile(alice, OTHER);
			await openFile(alice, NOTE);
			await bobCaretAt(alice, bobUser, pos);
			const gate = await alice.eval(`window.__tsGateObserver.disconnect();
				return { sawPending: window.__tsGate.includes(true),
					pendingNow: !!document.querySelector(".cm-editor.teamsync-carets-pending") };`);
			assert.deepEqual(gate, { sawPending: true, pendingNow: false }, "gate on rebind");
			step("rebind: carets gated until the note is ready, then bob's caret is back");
			// The label shows for 2 s after a move (`.is-recent`), then only on hover.
			const LABEL = `const el = document.querySelector(".cm-ySelectionCaret");
				const info = el?.querySelector(".cm-ySelectionInfo");
				return el && info ? { recent: el.classList.contains("is-recent"),
					opacity: getComputedStyle(info).opacity } : null;`;
			await setCursor(bob, { line: 0, ch: 2 });
			await waitFor(
				async () => {
					const l = await alice.eval(LABEL);
					return l?.recent && l.opacity === "1";
				},
				{ timeout: 3000, label: "bob's label shows after he moves" },
			);
			await waitFor(
				async () => {
					const l = await alice.eval(LABEL);
					return l && !l.recent && l.opacity === "0";
				},
				{ timeout: 4000, label: "bob's label hides 2 s after he stops" },
			);
			step("label shows after a move and hides again when the caret rests");

			await selectRange(bob, { line: 0, ch: 0 }, { line: 1, ch: 4 });
			const marks = await waitFor(
				async () => {
					const n = await alice.eval(
						'return document.querySelectorAll(".cm-ySelection, .cm-yLineSelection").length;',
					);
					return n >= 2 ? n : null;
				},
				{ timeout: 5000, label: "alice shows bob's selection" },
			);
			step(`selection over lines 0-1: ${marks} highlighted range(s)`);

			await setCursor(alice, { line: 2, ch: 2 });
			await waitFor(async () => (await carets(bob)).some((c) => c.name === "alice"), {
				timeout: 5000,
				label: "bob shows alice's caret",
			});
			const own = (await carets(alice)).filter((c) => c.name === "alice");
			assert.deepEqual(own, [], "alice draws no caret of her own");
			step("alice publishes her caret (bob sees it) but draws none of her own");

			await setLivePreview(alice, false);
			await setCursor(bob, { line: 2, ch: 5 });
			const source = await bobCaretAt(alice, bobUser, { line: 2, ch: 5 });
			step(`source mode: one bob caret at ${JSON.stringify(source.rect)}`);
			assert.equal(await editorText(alice), TEXT, "carets never change the text");
		} finally {
			await setLivePreview(alice, true).catch(() => undefined);
			for (const v of [alice, bob]) {
				await v
					.eval('app.workspace.detachLeavesOfType("markdown"); return true;')
					.catch(() => undefined);
			}
		}
	},
};
