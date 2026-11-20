import { type App, Modal, Setting } from "obsidian";
import { FolderSuggest } from "./FolderSuggest";
import type { TeamView } from "./settings/model";

const NEW_TEAM = "\u0000new-team";
const NEW_FOLDER = "\u0000new-folder";

export interface ShareChoice {
	localPath: string;
	/** An existing team, or null to create `newTeamName`. */
	teamId: string | null;
	newTeamName: string;
	/** An existing shared folder of the team, or null to create one named `folderName`. */
	folderId: string | null;
	folderName: string;
}

export interface ShareFolderModalOptions {
	/** The vault folder to share; null to pick one in the modal. */
	localPath: string | null;
	/** Teams to choose from, with their shared folders that are not in this vault yet. */
	teams: { team: TeamView; canCreate: boolean; unmapped: { id: string; name: string }[] }[];
	/** Preselected team. */
	teamId: string | null;
	/** The server can create teams (`features.teams`). */
	canCreateTeam: boolean;
	/** Resolves true once shared (the modal closes). */
	submit(choice: ShareChoice): Promise<boolean>;
}

function baseName(path: string): string {
	return path.split("/").pop() ?? path;
}

/** "Share with team…": a vault folder becomes a team's shared folder (new or existing). */
export class ShareFolderModal extends Modal {
	private suggest: FolderSuggest | null = null;

	constructor(
		app: App,
		private readonly options: ShareFolderModalOptions,
	) {
		super(app);
	}

	onOpen(): void {
		const { teams, canCreateTeam } = this.options;
		const choice: ShareChoice = {
			localPath: this.options.localPath ?? "",
			teamId: this.options.teamId ?? teams[0]?.team.id ?? null,
			newTeamName: "",
			folderId: null,
			folderName: this.options.localPath ? baseName(this.options.localPath) : "",
		};
		this.titleEl.setText("Share with team");

		let nameField: Setting | null = null;
		if (this.options.localPath === null) {
			new Setting(this.contentEl).setName("Folder in this vault").addText((text) => {
				text.setPlaceholder("Projects/Notes").onChange((value) => {
					choice.localPath = value.trim();
					if (!choice.folderName) nameText?.setValue(baseName(choice.localPath));
				});
				this.suggest = new FolderSuggest(this.app, text.inputEl, (path) => {
					choice.localPath = path;
					if (!choice.folderName) {
						choice.folderName = baseName(path);
						nameText?.setValue(choice.folderName);
					}
				});
			});
		} else {
			this.contentEl.createEl("p", {
				cls: "setting-item-description",
				text: `Everyone in the team gets ${this.options.localPath} and edits it with you live.`,
			});
		}

		const teamField = new Setting(this.contentEl).setName("Team").addDropdown((dropdown) => {
			for (const { team } of teams) dropdown.addOption(team.id, team.name);
			if (canCreateTeam) dropdown.addOption(NEW_TEAM, "New team…");
			dropdown.setValue(choice.teamId ?? NEW_TEAM).onChange((value) => {
				choice.teamId = value === NEW_TEAM ? null : value;
				choice.folderId = null;
				update();
			});
		});
		const newTeamField = new Setting(this.contentEl).setName("Team name").addText((text) =>
			text.setPlaceholder("My team").onChange((value) => {
				choice.newTeamName = value;
			}),
		);
		let folderSelect: HTMLSelectElement | null = null;
		const folderField = new Setting(this.contentEl)
			.setName("Shared folder")
			.addDropdown((dropdown) => {
				folderSelect = dropdown.selectEl;
				dropdown.onChange((value) => {
					choice.folderId = value === NEW_FOLDER ? null : value;
					update();
				});
			});
		let nameText: { setValue(value: string): unknown } | null = null;
		nameField = new Setting(this.contentEl).setName("Name").addText((text) => {
			nameText = text;
			text.setValue(choice.folderName).onChange((value) => {
				choice.folderName = value;
			});
		});
		const button = new Setting(this.contentEl).addButton((b) =>
			b
				.setButtonText("Share")
				.setCta()
				.onClick(async () => {
					b.setDisabled(true);
					try {
						if (await this.options.submit({ ...choice })) this.close();
					} finally {
						b.setDisabled(false);
					}
				}),
		);

		const update = () => {
			const entry = teams.find((t) => t.team.id === choice.teamId) ?? null;
			teamField.settingEl.toggle(teams.length > 0);
			newTeamField.settingEl.toggle(entry === null);
			const select = folderSelect;
			if (select) {
				select.empty();
				if (!entry || entry.canCreate)
					select.createEl("option", { value: NEW_FOLDER, text: "New shared folder" });
				for (const folder of entry?.unmapped ?? []) {
					select.createEl("option", { value: folder.id, text: folder.name });
				}
				if (choice.folderId === null && entry && !entry.canCreate) {
					choice.folderId = entry.unmapped[0]?.id ?? null;
				}
				select.value = choice.folderId ?? NEW_FOLDER;
			}
			folderField.settingEl.toggle((entry?.unmapped.length ?? 0) > 0);
			nameField?.settingEl.toggle(choice.folderId === null);
			const possible =
				entry === null ? canCreateTeam : entry.canCreate || entry.unmapped.length > 0;
			button.settingEl.toggle(possible);
		};
		update();
	}

	onClose(): void {
		this.suggest?.close();
		this.contentEl.empty();
	}
}
