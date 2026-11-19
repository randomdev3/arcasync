import type { DeviceLookupResponse } from "@arcasync/shared";
import { type App, Modal, Notice, Setting } from "obsidian";
import { type ApiClient, ApiRequestError } from "../net/ApiClient";

function describeError(error: unknown): string {
	if (error instanceof ApiRequestError) {
		if (error.code === "not_found") return "Unknown or expired code.";
		if (error.code === "rate_limited") return "Too many lookups. Wait a minute and try again.";
		return error.message;
	}
	return error instanceof Error ? error.message : String(error);
}

/**
 * "Approve a device sign-in": looks a code up (the server allows 5 lookups a minute, so only on
 * request, never per keystroke), shows which device asks, then approves or denies it.
 */
export class ApproveDeviceModal extends Modal {
	private code: string;
	private looked: { code: string; result: DeviceLookupResponse } | null = null;
	private resultEl!: HTMLElement;

	constructor(
		app: App,
		private readonly api: ApiClient,
		code = "",
	) {
		super(app);
		this.code = code;
	}

	onOpen(): void {
		this.titleEl.setText("Approve a device sign-in");
		this.contentEl.createEl("p", {
			text: "Enter the code shown on the device that wants to sign in as you.",
		});
		new Setting(this.contentEl)
			.setName("Code")
			.addText((text) => {
				text
					.setPlaceholder("XXXX-XXXX")
					.setValue(this.code)
					.onChange((value) => {
						this.code = value;
					});
				text.inputEl.addClass("arcasync-approve-code");
				text.inputEl.addEventListener("keydown", (event) => {
					if (event.key === "Enter") void this.lookup();
				});
			})
			.addButton((button) => {
				button.setButtonText("Look up").onClick(() => void this.lookup());
				button.buttonEl.addClass("arcasync-approve-lookup");
			});
		this.resultEl = this.contentEl.createDiv({ cls: "arcasync-approve-result" });
		if (this.code.trim()) void this.lookup();
	}

	private async lookup(): Promise<void> {
		const code = this.code.trim();
		if (!code) return;
		this.looked = null;
		this.resultEl.empty();
		this.resultEl.createEl("p", { text: "Looking up…" });
		try {
			const result = await this.api.deviceLookup(code);
			this.looked = { code, result };
			this.renderDevice(result);
		} catch (error) {
			this.resultEl.empty();
			this.resultEl.createEl("p", { cls: "mod-warning", text: describeError(error) });
		}
	}

	private renderDevice({ device }: DeviceLookupResponse): void {
		this.resultEl.empty();
		const line = this.resultEl.createEl("p", { cls: "arcasync-approve-device" });
		line.appendText("Sign in ");
		line.createEl("strong", { cls: "arcasync-approve-device-name", text: device.name });
		line.appendText(` (${device.platform}) as you?`);
		new Setting(this.resultEl)
			.addButton((button) => {
				button
					.setButtonText("Deny")
					.setWarning()
					.onClick(() => void this.answer(false));
				button.buttonEl.addClass("arcasync-approve-deny");
			})
			.addButton((button) => {
				button
					.setButtonText("Approve")
					.setCta()
					.onClick(() => void this.answer(true));
				button.buttonEl.addClass("arcasync-approve-accept");
			});
	}

	private async answer(approve: boolean): Promise<void> {
		const looked = this.looked;
		if (!looked) return;
		try {
			await this.api.deviceApprove(looked.code, approve);
			new Notice(
				approve
					? `ArcaSync: ${looked.result.device.name} is signing in`
					: `ArcaSync: denied ${looked.result.device.name}`,
			);
			this.close();
		} catch (error) {
			new Notice(`ArcaSync: ${describeError(error)}`);
		}
	}

	onClose(): void {
		this.contentEl.empty();
	}
}
