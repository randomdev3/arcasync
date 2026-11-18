import { AbstractInputSuggest, type App, type TFolder } from "obsidian";

const LIMIT = 50;

/** Vault-folder autocomplete for a text input; `onPick` fires with the chosen folder path. */
export class FolderSuggest extends AbstractInputSuggest<TFolder> {
	constructor(
		private readonly vaultApp: App,
		input: HTMLInputElement,
		private readonly onPick: (path: string) => void,
	) {
		super(vaultApp, input);
	}

	protected getSuggestions(query: string): TFolder[] {
		const q = query.trim().toLowerCase();
		return this.vaultApp.vault
			.getAllFolders(false)
			.filter((f) => f.path.toLowerCase().includes(q))
			.sort((a, b) => a.path.localeCompare(b.path))
			.slice(0, LIMIT);
	}

	renderSuggestion(folder: TFolder, el: HTMLElement): void {
		el.setText(folder.path);
	}

	selectSuggestion(folder: TFolder): void {
		this.setValue(folder.path);
		this.onPick(folder.path);
		this.close();
	}
}
