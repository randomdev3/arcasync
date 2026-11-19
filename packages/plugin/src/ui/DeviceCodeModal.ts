import type { DeviceCodeResponse, SessionResponse } from "@arcasync/shared";
import { type App, Modal, Setting } from "obsidian";
import { type DeviceLogin, DeviceLoginError } from "../auth/DeviceLogin";

export interface DeviceCodeModalOptions {
	login: DeviceLogin;
	/** Stores the approved session and connects. */
	onSession(session: SessionResponse): Promise<void>;
}

function formatRemaining(ms: number): string {
	const s = Math.max(0, Math.ceil(ms / 1000));
	return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/**
 * "Sign in with another device": shows the code to approve on a signed-in device and polls until
 * it is approved, denied or expires. Closing the modal cancels the sign-in.
 */
export class DeviceCodeModal extends Modal {
	private countdown: number | null = null;

	constructor(
		app: App,
		private readonly options: DeviceCodeModalOptions,
	) {
		super(app);
	}

	onOpen(): void {
		this.titleEl.setText("Sign in with another device");
		const status = this.contentEl.createEl("p", {
			cls: "teamsync-device-status",
			text: "Requesting a code…",
		});
		this.options.login
			.run((code) => this.showCode(code, status))
			.then(
				async (session) => {
					this.stopCountdown();
					status.setText("Approved. Signing in…");
					await this.options.onSession(session);
					this.close();
				},
				(error: unknown) => {
					this.stopCountdown();
					if (error instanceof DeviceLoginError && error.code === "cancelled") return;
					const message =
						error instanceof DeviceLoginError && error.code === "access_denied"
							? "The sign-in was denied."
							: error instanceof DeviceLoginError && error.code === "expired_token"
								? "The code expired. Close this window and try again."
								: `Sign-in failed: ${error instanceof Error ? error.message : String(error)}`;
					status.setText(message);
					status.addClass("mod-warning");
				},
			);
		new Setting(this.contentEl).addButton((button) =>
			button.setButtonText("Cancel").onClick(() => this.close()),
		);
	}

	private showCode(code: DeviceCodeResponse, status: HTMLElement): void {
		const box = this.contentEl.createDiv({ cls: "teamsync-device-code" });
		this.contentEl.insertBefore(box, status);
		box.createEl("p", {
			text: 'On a device where you are signed in, run the command "TeamSync: Approve a device sign-in" and enter this code:',
		});
		box.createEl("div", { cls: "teamsync-user-code", text: code.userCode });
		const link = box.createEl("p", { cls: "teamsync-device-link" });
		link.appendText("Or open ");
		link.createEl("code", { text: code.verificationUri });
		link.appendText(" there.");
		const expiresAt = Date.now() + code.expiresIn * 1000;
		const tick = () =>
			status.setText(`Waiting for approval… expires in ${formatRemaining(expiresAt - Date.now())}`);
		tick();
		this.countdown = window.setInterval(tick, 1000);
	}

	private stopCountdown(): void {
		if (this.countdown !== null) window.clearInterval(this.countdown);
		this.countdown = null;
	}

	onClose(): void {
		this.stopCountdown();
		this.options.login.cancel();
		this.contentEl.empty();
	}
}
