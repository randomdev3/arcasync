import { type App, normalizePath, SuggestModal } from "obsidian";

type Choice = { path: string; create: boolean };

const LIMIT = 50;

/**
 * Picks the vault folder a team folder syncs into: a new folder (named after the team folder by
 * default, or after what is typed) or an existing one that `allowed` accepts.
 */
export class FolderPickerModal extends SuggestModal<Choice> {
	constructor(
		app: App,
		private readonly options: {
			defaultName: string;
			allowed(path: string): boolean;
			onPick(path: string, create: boolean): void;
		},
	) {
		super(app);
		this.setPlaceholder("Folder in this vault");
		this.setInstructions([
			{ command: "↵", purpose: "sync here" },
			{ command: "esc", purpose: "cancel" },
		]);
	}

	getSuggestions(query: string): Choice[] {
		const typed = normalizePath(query.trim() || this.options.defaultName).replace(/^\/+|\/+$/g, "");
		const q = query.trim().toLowerCase();
		const folders = this.app.vault
			.getAllFolders(false)
			.map((f) => f.path)
			.filter((path) => this.options.allowed(path) && path.toLowerCase().includes(q))
			.sort((a, b) => a.localeCompare(b))
			.slice(0, LIMIT)
			.map((path) => ({ path, create: false }));
		const exists = this.app.vault.getAbstractFileByPath(typed) !== null;
		const create =
			typed && !exists && this.options.allowed(typed) ? [{ path: typed, create: true }] : [];
		return [...create, ...folders];
	}

	renderSuggestion(choice: Choice, el: HTMLElement): void {
		el.createDiv({ text: choice.path });
		if (choice.create) el.createEl("small", { cls: "arcasync-muted", text: "New folder" });
	}

	onChooseSuggestion(choice: Choice): void {
		this.options.onPick(choice.path, choice.create);
	}
}
