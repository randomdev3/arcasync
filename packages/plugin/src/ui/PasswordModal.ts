import { passwordProblem } from "@arcasync/shared";
import { type App, Modal, Notice, Setting } from "obsidian";
import { ApiRequestError } from "../net/ApiClient";

export interface PasswordModalOptions {
	/** The account already has a password: the current one is asked for too. */
	hasPassword: boolean;
	/** Sets or changes it; rejects with the relay's error. */
	submit(next: string, current?: string): Promise<void>;
}

/** A sentence for a failed password set or change. */
export function describePasswordError(error: unknown): string {
	if (error instanceof ApiRequestError) {
		if (error.code === "invalid_credentials") return "The current password is wrong";
		if (error.code === "rate_limited") return "Too many wrong passwords; try again later";
		return error.message;
	}
	return error instanceof Error ? error.message : String(error);
}

/** "Set password" / "Change password": current (when there is one), new, and new again. */
export class PasswordModal extends Modal {
	constructor(
		app: App,
		private readonly options: PasswordModalOptions,
	) {
		super(app);
	}

	onOpen(): void {
		const { hasPassword } = this.options;
		this.titleEl.setText(hasPassword ? "Change password" : "Set password");
		this.contentEl.createEl("p", {
			cls: "setting-item-description",
			text: hasPassword
				? "Your other devices are signed out when it changes."
				: "With a password you sign in on other devices with your name and it. At least 10 characters.",
		});
		const values = { current: "", next: "", confirm: "" };
		const field = (name: string, key: keyof typeof values, cls: string, autocomplete: AutoFill) =>
			new Setting(this.contentEl).setName(name).addText((text) => {
				text.inputEl.type = "password";
				text.inputEl.autocomplete = autocomplete;
				text.inputEl.addClass(cls);
				text.onChange((value) => {
					values[key] = value;
				});
			});
		if (hasPassword)
			field("Current password", "current", "arcasync-password-current", "current-password");
		field("New password", "next", "arcasync-password-new", "new-password");
		field("Repeat it", "confirm", "arcasync-password-confirm", "new-password");
		new Setting(this.contentEl).addButton((button) => {
			button
				.setButtonText(hasPassword ? "Change password" : "Set password")
				.setCta()
				.onClick(async () => {
					const problem = passwordProblem(values.next);
					if (problem) return void new Notice(`ArcaSync: ${problem}`);
					if (values.next !== values.confirm) {
						return void new Notice("ArcaSync: the two passwords differ");
					}
					button.setDisabled(true);
					try {
						await this.options.submit(values.next, hasPassword ? values.current : undefined);
						new Notice(hasPassword ? "ArcaSync: password changed" : "ArcaSync: password set");
						this.close();
					} catch (error) {
						new Notice(`ArcaSync: ${describePasswordError(error)}`);
					} finally {
						button.setDisabled(false);
					}
				});
			button.buttonEl.addClass("arcasync-password-submit");
		});
	}

	onClose(): void {
		this.contentEl.empty();
	}
}
