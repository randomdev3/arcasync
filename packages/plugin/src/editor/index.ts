import type { Extension } from "@codemirror/state";
import { MarkdownView } from "obsidian";
import type ArcaSyncPlugin from "../main";
import { EditorBindings } from "./EditorBinding";

/**
 * CodeMirror extensions registered once in `onload`. Obsidian keeps a reference to the returned
 * array, so later code may push into it and call `app.workspace.updateOptions()`.
 */
export function editorExtensions(plugin: ArcaSyncPlugin): Extension[] {
	const { workspace } = plugin.app;
	const bindings = new EditorBindings({
		get sessions() {
			return plugin.sessions;
		},
		sessionFor: (vaultPath) => plugin.sessionFor(vaultPath),
		activeView: () => workspace.getActiveViewOfType(MarkdownView),
	});
	// Connect, disconnect and session restarts all notify the plugin's view listeners.
	plugin.register(plugin.onViewChange(() => bindings.sessionChanged()));
	plugin.registerEvent(workspace.on("active-leaf-change", () => bindings.updateFocus()));
	plugin.register(() => bindings.destroy());
	return [bindings.extension()];
}
