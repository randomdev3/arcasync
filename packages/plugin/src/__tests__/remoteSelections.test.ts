// The contract between the note doc's awareness and y-codemirror.next's remote selections, which
// draw the carets. There is no DOM in this suite, so the plugin runs against an EditorState and a
// stand-in for the view's focus; the caret DOM itself is covered by scripts/e2e/p1/cursors.mjs.
import { EditorSelection, EditorState } from "@codemirror/state";
import type { Decoration, DecorationSet, EditorView } from "@codemirror/view";
import { describe, expect, it } from "vitest";
import { YSyncConfig, yRemoteSelections, ySyncFacet } from "y-codemirror.next";
import { Awareness, applyAwarenessUpdate, encodeAwarenessUpdate } from "y-protocols/awareness";
import * as Y from "yjs";
import { presenceUser } from "../presence/PresenceService";

const ALICE = presenceUser({ id: "user-alice", name: "alice" });
const BOB = presenceUser({ id: "user-bob", name: "bob" });
const TEXT = "Line one\nLine two\n";

interface PluginValue {
	decorations: DecorationSet;
	update(update: { view: EditorView; state: EditorState }): void;
	destroy(): void;
}

/** One peer: its doc, awareness and an editor state bound like `yCollab` binds it. */
function peer(focus: { has: boolean }) {
	const ydoc = new Y.Doc();
	const ytext = ydoc.getText("contents");
	const awareness = new Awareness(ydoc);
	awareness.setLocalState(null);
	let state = EditorState.create({
		doc: TEXT,
		extensions: [ySyncFacet.of(new YSyncConfig(ytext, awareness))],
	});
	const view = {
		get state() {
			return state;
		},
		get hasFocus() {
			return focus.has;
		},
		dom: { ownerDocument: { hasFocus: () => focus.has } },
		dispatch: () => undefined,
	} as unknown as EditorView;
	// `create` is CodeMirror-internal; it is what EditorView calls to instantiate the plugin.
	const create = (yRemoteSelections as unknown as { create(v: EditorView): PluginValue }).create;
	const plugin = create(view);
	return {
		ydoc,
		ytext,
		awareness,
		/** Moves the local selection and runs the plugin's view update. */
		select(anchor: number, head = anchor) {
			state = state.update({ selection: EditorSelection.single(anchor, head) }).state;
			plugin.update({ view, state });
		},
		refresh() {
			plugin.update({ view, state });
		},
		decorations(): Array<{ from: number; to: number; value: Decoration }> {
			const out: Array<{ from: number; to: number; value: Decoration }> = [];
			plugin.decorations.between(0, state.doc.length, (from, to, value) => {
				out.push({ from, to, value });
			});
			return out;
		},
	};
}

/** Two peers with the same text; awareness flows both ways, like over the relay. */
function pair(focus = { alice: { has: true }, bob: { has: true } }) {
	const alice = peer(focus.alice);
	const bob = peer(focus.bob);
	alice.ytext.insert(0, TEXT);
	Y.applyUpdate(bob.ydoc, Y.encodeStateAsUpdate(alice.ydoc));
	const wire = (from: Awareness, to: Awareness) =>
		from.on(
			"update",
			({ added, updated, removed }: { added: number[]; updated: number[]; removed: number[] }) => {
				applyAwarenessUpdate(
					to,
					encodeAwarenessUpdate(from, [...added, ...updated, ...removed]),
					"x",
				);
			},
		);
	wire(alice.awareness, bob.awareness);
	wire(bob.awareness, alice.awareness);
	return { alice, bob };
}

type CaretWidget = { name: string; color: string };

function carets(p: ReturnType<typeof peer>): Array<CaretWidget & { at: number }> {
	return p
		.decorations()
		.filter((d) => d.value.spec.widget)
		.map((d) => ({ at: d.from, ...(d.value.spec.widget as CaretWidget) }));
}

describe("remote selections over the note awareness", () => {
	it("a focused editor with a user publishes its cursor; the peer draws it in the user's colour", () => {
		const { alice, bob } = pair();
		bob.awareness.setLocalState({ user: BOB });
		bob.select(13);
		expect(bob.awareness.getLocalState()?.cursor).toBeTruthy();

		alice.refresh();
		expect(carets(alice)).toEqual([
			expect.objectContaining({ at: 13, name: "bob", color: BOB.color }),
		]);
	});

	it("never draws the local client's own caret", () => {
		const { alice } = pair();
		alice.awareness.setLocalState({ user: ALICE });
		alice.select(4);
		expect(alice.awareness.getLocalState()?.cursor).toBeTruthy();
		expect(carets(alice)).toEqual([]);
	});

	it("a background note (null local state) publishes no cursor", () => {
		const { alice, bob } = pair();
		const sent: unknown[] = [];
		bob.awareness.on("update", (u: unknown) => sent.push(u));
		bob.select(4);
		expect(bob.awareness.getLocalState()).toBeNull();
		expect(sent).toEqual([]);
		alice.refresh();
		expect(carets(alice)).toEqual([]);
	});

	it("a blurred peer keeps its last caret", () => {
		const focus = { alice: { has: true }, bob: { has: true } };
		const { alice, bob } = pair(focus);
		bob.awareness.setLocalState({ user: BOB });
		bob.select(4);
		focus.bob.has = false;
		bob.select(10);
		alice.refresh();
		expect(carets(alice)).toEqual([expect.objectContaining({ at: 4, name: "bob" })]);
	});

	it("draws a multi-line selection as marks on its first and last line", () => {
		const { alice, bob } = pair();
		bob.awareness.setLocalState({ user: BOB });
		bob.select(0, 13);
		alice.refresh();
		const marks = alice.decorations().filter((d) => d.value.spec.class === "cm-ySelection");
		expect(marks.map((m) => [m.from, m.to])).toEqual([
			[0, 8],
			[9, 13],
		]);
		expect(marks[0]?.value.spec.attributes?.style).toContain(BOB.colorLight);
	});
});
