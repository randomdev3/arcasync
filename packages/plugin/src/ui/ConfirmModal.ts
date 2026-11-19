import { type App, Modal, Setting } from "obsidian";

export interface ConfirmOptions {
	title: string;
	message: string;
	confirmText: string;
	/** Styles the confirm button as destructive. */
	warning?: boolean;
	onConfirm(): void;
}

/** A yes/no question; `onConfirm` runs only when the confirm button is clicked. */
export class ConfirmModal extends Modal {
	constructor(
		app: App,
		private readonly options: ConfirmOptions,
	) {
		super(app);
	}

	onOpen(): void {
		const { title, message, confirmText, warning } = this.options;
		this.titleEl.setText(title);
		this.contentEl.createEl("p", { text: message });
		new Setting(this.contentEl)
			.addButton((button) =>
				button.setButtonText("Cancel").onClick(() => {
					this.close();
				}),
			)
			.addButton((button) => {
				button.setButtonText(confirmText).onClick(() => {
					this.close();
					this.options.onConfirm();
				});
				button.buttonEl.addClass("teamsync-confirm");
				if (warning) button.setWarning();
				else button.setCta();
			});
	}

	onClose(): void {
		this.contentEl.empty();
	}
}
