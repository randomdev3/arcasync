import { type App, Modal, Setting } from "obsidian";
import { FOLDER_STATE_LABEL, type FolderState } from "./settings/model";

export interface SyncStatusView {
	path: string;
	teamName: string | null;
	folderName: string | null;
	state: FolderState;
	/** People connected to this folder right now, this device included. */
	online: number;
	/** Files the folder's index lists. */
	files: number | null;
	message: string | null;
}

/** "Sync status" from a shared folder's file menu. */
export class SyncStatusModal extends Modal {
	constructor(
		app: App,
		private readonly view: SyncStatusView,
		private readonly actions: { openTeam: (() => void) | null },
	) {
		super(app);
	}

	onOpen(): void {
		const { path, teamName, folderName, state, online, files, message } = this.view;
		this.titleEl.setText(path);
		const status = new Setting(this.contentEl).setName("Status");
		const pill = status.controlEl.createSpan({
			cls: "arcasync-pill",
			text: FOLDER_STATE_LABEL[state],
		});
		pill.dataset.state = state;
		if (message) status.setDesc(message);
		if (teamName) {
			new Setting(this.contentEl)
				.setName("Team")
				.setDesc(folderName && folderName !== teamName ? `${teamName} · ${folderName}` : teamName);
		}
		if (state === "connected" || state === "syncing") {
			new Setting(this.contentEl).setName("Online now").setDesc(String(online));
			if (files !== null) new Setting(this.contentEl).setName("Files").setDesc(String(files));
		}
		const openTeam = this.actions.openTeam;
		if (openTeam) {
			new Setting(this.contentEl).addButton((button) =>
				button.setButtonText("Team settings").onClick(() => {
					this.close();
					openTeam();
				}),
			);
		}
	}

	onClose(): void {
		this.contentEl.empty();
	}
}
