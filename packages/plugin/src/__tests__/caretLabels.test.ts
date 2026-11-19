import { userColor } from "@arcasync/shared";
import { Compartment, EditorState, type Extension, type TransactionSpec } from "@codemirror/state";
import { EditorView, ViewPlugin } from "@codemirror/view";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Awareness, applyAwarenessUpdate, encodeAwarenessUpdate } from "y-protocols/awareness";
import * as Y from "yjs";
import {
	CaretRecency,
	caretIdentity,
	caretLabels,
	PENDING_CLASS,
	RECENT_CLASS,
	RECENT_LABEL_MS,
	stampCarets,
} from "../editor/caretLabels";
import { presenceUser } from "../presence/PresenceService";

const BOB = presenceUser({ id: "user-bob", name: "bob" });

/** Alice's note doc plus bob's, with bob's awareness and doc updates forwarded to alice. */
function pair() {
	const aliceDoc = new Y.Doc();
	const bobDoc = new Y.Doc();
	const alice = new Awareness(aliceDoc);
	const bob = new Awareness(bobDoc);
	bob.on(
		"update",
		({ added, updated, removed }: { added: number[]; updated: number[]; removed: number[] }) => {
			const ids = [...added, ...updated, ...removed];
			applyAwarenessUpdate(alice, encodeAwarenessUpdate(bob, ids), "remote");
		},
	);
	bobDoc.on("update", (update: Uint8Array) => Y.applyUpdate(aliceDoc, update, "remote"));
	return { aliceDoc, bobDoc, alice, bob };
}

function cursorAt(ytext: Y.Text, index: number) {
	const pos = Y.createRelativePositionFromTypeIndex(ytext, index);
	return { anchor: pos, head: pos };
}

describe("caretIdentity", () => {
	it("reads user name and colour", () => {
		expect(caretIdentity({ user: BOB })).toEqual({ name: "bob", color: BOB.color });
	});

	it("falls back to y-codemirror.next's defaults", () => {
		expect(caretIdentity({})).toEqual({ name: "Anonymous", color: "#30bced" });
		expect(caretIdentity({ user: { name: 3 } })).toEqual({ name: "Anonymous", color: "#30bced" });
	});
});

describe("presenceUser", () => {
	it("derives the colour from the user id", () => {
		expect(BOB).toEqual({ id: "user-bob", name: "bob", ...userColor("user-bob") });
	});
});

describe("CaretRecency", () => {
	beforeEach(() => vi.useFakeTimers());
	afterEach(() => vi.useRealTimers());

	it("marks a moved remote cursor recent for RECENT_LABEL_MS", () => {
		const { alice, bob, bobDoc } = pair();
		const onChange = vi.fn();
		const recency = new CaretRecency(alice, onChange);
		const ytext = bobDoc.getText("contents");
		ytext.insert(0, "Line one\n");
		vi.advanceTimersByTime(RECENT_LABEL_MS);
		onChange.mockClear();

		bob.setLocalState({ user: BOB, cursor: cursorAt(ytext, 4) });
		expect(recency.recent()).toEqual([{ name: "bob", color: BOB.color }]);
		expect(onChange).toHaveBeenCalledTimes(1);

		vi.advanceTimersByTime(RECENT_LABEL_MS - 1);
		expect(recency.recent()).toHaveLength(1);
		vi.advanceTimersByTime(1);
		expect(recency.recent()).toEqual([]);
		expect(onChange).toHaveBeenCalledTimes(2);
		recency.destroy();
	});

	it("extends the label while the cursor keeps moving", () => {
		const { alice, bob, bobDoc } = pair();
		const recency = new CaretRecency(alice, () => undefined);
		const ytext = bobDoc.getText("contents");
		ytext.insert(0, "Line one\n");
		bob.setLocalState({ user: BOB, cursor: cursorAt(ytext, 1) });
		vi.advanceTimersByTime(1500);
		bob.setLocalStateField("cursor", cursorAt(ytext, 2));
		vi.advanceTimersByTime(1500);
		expect(recency.recent()).toHaveLength(1);
		vi.advanceTimersByTime(500);
		expect(recency.recent()).toEqual([]);
		recency.destroy();
	});

	it("ignores renewals and changes that keep the cursor", () => {
		const { alice, bob, bobDoc } = pair();
		const recency = new CaretRecency(alice, () => undefined);
		const ytext = bobDoc.getText("contents");
		ytext.insert(0, "Line one\n");
		bob.setLocalState({ user: BOB, cursor: cursorAt(ytext, 4) });
		vi.advanceTimersByTime(RECENT_LABEL_MS);
		bob.setLocalState({ ...bob.getLocalState(), idle: true });
		bob.setLocalState(bob.getLocalState());
		expect(recency.recent()).toEqual([]);
		recency.destroy();
	});

	it("does not mark a peer that has no cursor, nor the local client", () => {
		const { alice, bob } = pair();
		const recency = new CaretRecency(alice, () => undefined);
		bob.setLocalState({ user: BOB, cursor: null });
		alice.setLocalState({ user: presenceUser({ id: "user-alice", name: "alice" }), cursor: {} });
		expect(recency.recent()).toEqual([]);
		recency.destroy();
	});

	it("marks the author of a remote edit (typing does not move the relative cursor)", () => {
		const { alice, aliceDoc, bob, bobDoc } = pair();
		const ytext = bobDoc.getText("contents");
		ytext.insert(0, "Line one\n");
		bob.setLocalState({ user: BOB, cursor: cursorAt(ytext, 4) });
		const recency = new CaretRecency(alice, () => undefined);
		expect(recency.recent()).toEqual([]);

		ytext.insert(4, "X");
		expect(recency.recent()).toEqual([{ name: "bob", color: BOB.color }]);
		vi.advanceTimersByTime(RECENT_LABEL_MS);
		aliceDoc.getText("contents").insert(0, "local ");
		expect(recency.recent()).toEqual([]);
		recency.destroy();
	});

	it("forgets a removed peer", () => {
		const { alice, bob, bobDoc } = pair();
		const onChange = vi.fn();
		const recency = new CaretRecency(alice, onChange);
		bob.setLocalState({ user: BOB, cursor: cursorAt(bobDoc.getText("contents"), 0) });
		bob.setLocalState(null);
		expect(recency.recent()).toEqual([]);
		expect(onChange).toHaveBeenCalledTimes(2);
		recency.destroy();
	});

	it("stops listening and clears its timer on destroy", () => {
		const { alice, bob, bobDoc } = pair();
		const onChange = vi.fn();
		const recency = new CaretRecency(alice, onChange);
		bob.setLocalState({ user: BOB, cursor: cursorAt(bobDoc.getText("contents"), 0) });
		recency.destroy();
		onChange.mockClear();
		bobDoc.getText("contents").insert(0, "x");
		vi.advanceTimersByTime(RECENT_LABEL_MS);
		expect(onChange).not.toHaveBeenCalled();
		alice.destroy();
		bob.destroy();
		expect(vi.getTimerCount()).toBe(0);
	});
});

/** The parts of a `.cm-ySelectionCaret` element that `stampCarets` reads and writes. */
function fakeCaret(name: string, color: string) {
	const classes = new Set(["cm-ySelectionCaret"]);
	return {
		classes,
		getAttribute: (attr: string) =>
			attr === "style" ? `background-color: ${color}; border-color: ${color}` : null,
		querySelector: (sel: string) => (sel === ".cm-ySelectionInfo" ? { textContent: name } : null),
		classList: {
			toggle: (cls: string, on: boolean) => (on ? classes.add(cls) : classes.delete(cls)),
		},
	};
}

describe("stampCarets", () => {
	it("toggles the recent class by name and colour", () => {
		const bob = fakeCaret("bob", BOB.color);
		const carol = fakeCaret("carol", "#6eeb83");
		const otherBob = fakeCaret("bob", "#ffbc42");
		carol.classes.add(RECENT_CLASS);
		const root = { querySelectorAll: () => [bob, carol, otherBob] } as unknown as ParentNode;

		stampCarets(root, [{ name: "bob", color: BOB.color }]);
		expect(bob.classes.has(RECENT_CLASS)).toBe(true);
		expect(carol.classes.has(RECENT_CLASS)).toBe(false);
		expect(otherBob.classes.has(RECENT_CLASS)).toBe(false);
	});
});

/** A deferred `whenReady()`. */
function deferred() {
	let resolve!: () => void;
	let reject!: (error: Error) => void;
	const promise = new Promise<void>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
}

/**
 * An EditorState plus the caretLabels view plugin running against a stand-in view (no DOM here):
 * `dispatch` applies to the state, `requestMeasure` is dropped.
 */
function boundState(extension: Extension, compartment = new Compartment()) {
	let state = EditorState.create({ doc: "Line one\n", extensions: compartment.of(extension) });
	const dispatched: TransactionSpec[] = [];
	const view = {
		get state() {
			return state;
		},
		dispatch(spec: TransactionSpec) {
			dispatched.push(spec);
			state = state.update(spec).state;
		},
		requestMeasure: () => undefined,
	} as unknown as EditorView;
	const plugins: Array<{ destroy(): void }> = [];
	const start = (ext: Extension) => {
		const plugin = (ext as unknown[]).find((e) => e instanceof ViewPlugin);
		// `create` is CodeMirror-internal; it is what EditorView calls to instantiate the plugin.
		plugins.push(
			(plugin as unknown as { create(v: EditorView): { destroy(): void } }).create(view),
		);
	};
	start(extension);
	return {
		dispatched,
		get pending() {
			return state
				.facet(EditorView.editorAttributes)
				.some((a) => typeof a === "object" && a.class === PENDING_CLASS);
		},
		destroy: () => {
			for (const p of plugins) p.destroy();
		},
		rebind(next: Extension) {
			for (const p of plugins.splice(0)) p.destroy();
			view.dispatch({ effects: compartment.reconfigure(next) });
			start(next);
		},
	};
}

describe("caretLabels readiness gate", () => {
	it("hides remote carets until the note doc is ready", async () => {
		const ready = deferred();
		const bound = boundState(
			caretLabels({ awareness: new Awareness(new Y.Doc()), ready: ready.promise }),
		);
		expect(bound.pending).toBe(true);
		ready.resolve();
		await ready.promise;
		expect(bound.pending).toBe(false);
		expect(bound.dispatched).toHaveLength(1);
		bound.destroy();
	});

	it("starts pending again when the compartment is rebound to another note", async () => {
		const bound = boundState(
			caretLabels({ awareness: new Awareness(new Y.Doc()), ready: Promise.resolve() }),
		);
		await Promise.resolve();
		expect(bound.pending).toBe(false);
		const next = deferred();
		bound.rebind(caretLabels({ awareness: new Awareness(new Y.Doc()), ready: next.promise }));
		expect(bound.pending).toBe(true);
		next.resolve();
		await next.promise;
		expect(bound.pending).toBe(false);
		bound.destroy();
	});

	it("stays pending when the doc never becomes ready or the editor is gone first", async () => {
		const failed = deferred();
		const a = boundState(
			caretLabels({ awareness: new Awareness(new Y.Doc()), ready: failed.promise }),
		);
		failed.reject(new Error("closed"));
		await failed.promise.catch(() => undefined);
		expect(a.pending).toBe(true);
		expect(a.dispatched).toEqual([]);

		const late = deferred();
		const b = boundState(
			caretLabels({ awareness: new Awareness(new Y.Doc()), ready: late.promise }),
		);
		b.destroy();
		late.resolve();
		await late.promise;
		expect(b.dispatched).toEqual([]);
		a.destroy();
	});
});
