import { EditorSelection, EditorState } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { currentCursor } from "../editor/EditorBinding";
import type { NoteDocHandle } from "../workspace/types";

function setup(text: string, anchor: number, head: number, focused: boolean) {
	const ydoc = new Y.Doc();
	const ytext = ydoc.getText("contents");
	ytext.insert(0, text);
	const state = EditorState.create({
		doc: text,
		selection: EditorSelection.single(anchor, head),
	});
	const view = {
		state,
		hasFocus: focused,
		dom: { ownerDocument: { hasFocus: () => focused } },
	} as unknown as EditorView;
	return { ydoc, view, note: { ytext } as unknown as NoteDocHandle };
}

describe("currentCursor", () => {
	it("encodes the focused selection as relative positions that resolve back", () => {
		const { ydoc, view, note } = setup("hello world\nline two", 3, 15, true);
		const cursor = currentCursor(view, note);
		expect(cursor).not.toBeNull();
		const anchor = Y.createAbsolutePositionFromRelativePosition(
			Y.createRelativePositionFromJSON(JSON.parse(JSON.stringify(cursor?.anchor))),
			ydoc,
		);
		const head = Y.createAbsolutePositionFromRelativePosition(
			Y.createRelativePositionFromJSON(JSON.parse(JSON.stringify(cursor?.head))),
			ydoc,
		);
		expect(anchor?.index).toBe(3);
		expect(head?.index).toBe(15);
	});

	it("publishes no caret for an unfocused editor", () => {
		const { view, note } = setup("abc", 1, 1, false);
		expect(currentCursor(view, note)).toBeNull();
	});

	it("publishes no caret while the buffer and the doc disagree", () => {
		const { view, note } = setup("abc", 1, 1, true);
		note.ytext.insert(3, "def");
		expect(currentCursor(view, note)).toBeNull();
	});
});
