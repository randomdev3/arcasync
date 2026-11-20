import { type App, Modal, Setting } from "obsidian";

export interface TextPromptOptions {
	title: string;
	label: string;
	description?: string;
	value?: string;
	placeholder?: string;
	confirmText: string;
	/** Resolves true when done (the modal closes); false keeps it open. */
	submit(value: string): Promise<boolean>;
}

/** One text field and a button, e.g. "Create team". */
export class TextPromptModal extends Modal {
	constructor(
		app: App,
		private readonly options: TextPromptOptions,
	) {
		super(app);
	}

	onOpen(): void {
		const { title, label, description, placeholder, confirmText } = this.options;
		let value = this.options.value ?? "";
		this.titleEl.setText(title);
		let submitting = false;
		const submit = async () => {
			if (submitting || !value.trim()) return;
			submitting = true;
			try {
				if (await this.options.submit(value.trim())) this.close();
			} finally {
				submitting = false;
			}
		};
		const field = new Setting(this.contentEl).setName(label).addText((text) => {
			text
				.setPlaceholder(placeholder ?? "")
				.setValue(value)
				.onChange((next) => {
					value = next;
				});
			text.inputEl.addEventListener("keydown", (event) => {
				if (event.key === "Enter") void submit();
			});
			window.setTimeout(() => text.inputEl.focus(), 0);
		});
		if (description) field.setDesc(description);
		new Setting(this.contentEl)
			.addButton((button) => button.setButtonText("Cancel").onClick(() => this.close()))
			.addButton((button) =>
				button
					.setButtonText(confirmText)
					.setCta()
					.onClick(() => void submit()),
			);
	}

	onClose(): void {
		this.contentEl.empty();
	}
}
