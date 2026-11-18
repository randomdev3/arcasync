import type { Extension } from "@codemirror/state";
import type TeamSyncPlugin from "../main";

/**
 * CodeMirror extensions registered once in `onload`. Obsidian keeps a reference to the returned
 * array, so later code may push into it and call `app.workspace.updateOptions()`.
 */
export function editorExtensions(_plugin: TeamSyncPlugin): Extension[] {
	return [];
}
