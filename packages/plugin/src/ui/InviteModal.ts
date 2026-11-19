import { type App, Modal, Setting } from "obsidian";

export interface InviteModalOptions {
	link: string;
	/** Signed out: the new account's name is asked for too. */
	askName: boolean;
	/** Resolves true once joined (the modal closes). */
	join(link: string, name: string): Promise<boolean>;
}

/** Joins with an invite link: accepted as a new user when signed out, redeemed when signed in. */
export class InviteModal extends Modal {
	constructor(
		app: App,
		private readonly options: InviteModalOptions,
	) {
		super(app);
	}

	onOpen(): void {
		const { askName } = this.options;
		let link = this.options.link;
		let name = "";
		this.titleEl.setText(askName ? "Join ArcaSync" : "Join a workspace");
		new Setting(this.contentEl).setName("Invite link or code").addText((text) => {
			text.setValue(link).onChange((value) => {
				link = value;
			});
			text.inputEl.addClass("arcasync-invite-input");
		});
		if (askName) {
			new Setting(this.contentEl)
				.setName("Your name")
				.setDesc("Shown to your teammates.")
				.addText((text) => {
					text.setPlaceholder("Name").onChange((value) => {
						name = value;
					});
					text.inputEl.addClass("arcasync-invite-name");
				});
		}
		new Setting(this.contentEl).addButton((button) => {
			button
				.setButtonText("Join")
				.setCta()
				.onClick(async () => {
					button.setDisabled(true);
					try {
						if (await this.options.join(link, name)) this.close();
					} finally {
						button.setDisabled(false);
					}
				});
			button.buttonEl.addClass("arcasync-invite-join");
		});
	}

	onClose(): void {
		this.contentEl.empty();
	}
}
