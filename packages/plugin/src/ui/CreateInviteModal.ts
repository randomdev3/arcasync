import type { InviteSummary, Role, WorkspaceSummary } from "@teamsync/shared";
import { type App, Modal, Notice, Setting } from "obsidian";
import type { ApiClient } from "../net/ApiClient";
import { describeMemberError } from "./MembersModal";

const DAY_S = 86_400;

export interface CreateInviteModalOptions {
	api: ApiClient;
	/** Workspaces this user may invite to (owner, or every one for an admin). */
	workspaces: WorkspaceSummary[];
	workspaceId: string;
}

/** Owner tools: creates an invite link (role, uses, expiry) and lists or revokes open ones. */
export class CreateInviteModal extends Modal {
	private workspaceId: string;
	private role: Role = "editor";
	private maxUses = 1;
	private days = 7;
	private resultEl!: HTMLElement;
	private openEl!: HTMLElement;

	constructor(
		app: App,
		private readonly options: CreateInviteModalOptions,
	) {
		super(app);
		this.workspaceId = options.workspaceId;
	}

	onOpen(): void {
		this.titleEl.setText("Invite to a workspace");
		const { workspaces } = this.options;
		if (workspaces.length > 1) {
			new Setting(this.contentEl).setName("Workspace").addDropdown((dropdown) => {
				for (const w of workspaces) dropdown.addOption(w.id, w.name);
				dropdown.setValue(this.workspaceId).onChange((value) => {
					this.workspaceId = value;
					this.resultEl.empty();
					void this.loadOpen();
				});
			});
		}
		new Setting(this.contentEl).setName("Role").addDropdown((dropdown) => {
			dropdown
				.addOption("viewer", "Viewer")
				.addOption("editor", "Editor")
				.addOption("owner", "Owner")
				.setValue(this.role)
				.onChange((value) => {
					this.role = value as Role;
				});
			dropdown.selectEl.addClass("teamsync-invite-role");
		});
		new Setting(this.contentEl)
			.setName("Uses")
			.setDesc("How many people can join with this link (1–100).")
			.addText((text) => {
				text.inputEl.type = "number";
				text.setValue(String(this.maxUses)).onChange((value) => {
					this.maxUses = Number(value);
				});
			});
		new Setting(this.contentEl)
			.setName("Expires after (days)")
			.setDesc("1–30 days.")
			.addText((text) => {
				text.inputEl.type = "number";
				text.setValue(String(this.days)).onChange((value) => {
					this.days = Number(value);
				});
			});
		new Setting(this.contentEl).addButton((button) => {
			button
				.setButtonText("Create invite link")
				.setCta()
				.onClick(() => void this.create());
			button.buttonEl.addClass("teamsync-invite-create");
		});
		this.resultEl = this.contentEl.createDiv({ cls: "teamsync-invite-result" });
		this.openEl = this.contentEl.createDiv({ cls: "teamsync-invites-open" });
		void this.loadOpen();
	}

	private async create(): Promise<void> {
		const maxUses = Math.round(this.maxUses);
		const days = this.days;
		if (!(maxUses >= 1 && maxUses <= 100) || !(days >= 1 && days <= 30)) {
			new Notice("TeamSync: uses must be 1–100 and expiry 1–30 days");
			return;
		}
		try {
			const invite = await this.options.api.createInvite(this.workspaceId, {
				role: this.role,
				maxUses,
				expiresInSec: Math.round(days * DAY_S),
			});
			this.resultEl.empty();
			new Setting(this.resultEl)
				.setName("Invite link")
				.setDesc("Send it to the people you invite. It is shown only once.")
				.addText((text) => {
					text.setValue(invite.url);
					text.inputEl.readOnly = true;
					text.inputEl.addClass("teamsync-invite-url");
				})
				.addButton((button) =>
					button.setButtonText("Copy").onClick(async () => {
						await navigator.clipboard.writeText(invite.url);
						new Notice("TeamSync: invite link copied");
					}),
				);
			await this.loadOpen();
		} catch (error) {
			new Notice(`TeamSync: ${describeMemberError(error)}`);
		}
	}

	/** Unused, unrevoked, unexpired invites of the workspace, each with Revoke. */
	private async loadOpen(): Promise<void> {
		const workspaceId = this.workspaceId;
		let invites: InviteSummary[];
		try {
			invites = await this.options.api.listInvites(workspaceId);
		} catch {
			return;
		}
		if (workspaceId !== this.workspaceId) return;
		const now = Date.now();
		const open = invites.filter((i) => !i.revoked && i.uses < i.maxUses && i.expiresAt > now);
		this.openEl.empty();
		if (open.length === 0) return;
		new Setting(this.openEl).setName("Open invites").setHeading();
		for (const invite of open) {
			const expires = new Date(invite.expiresAt).toLocaleDateString();
			new Setting(this.openEl)
				.setName(`${invite.role}${invite.admin ? " (admin)" : ""}`)
				.setDesc(`${invite.uses}/${invite.maxUses} used · expires ${expires}`)
				.addButton((button) =>
					button
						.setButtonText("Revoke")
						.setWarning()
						.onClick(async () => {
							try {
								await this.options.api.revokeInvite(workspaceId, invite.id);
							} catch (error) {
								new Notice(`TeamSync: ${describeMemberError(error)}`);
							}
							await this.loadOpen();
						}),
				);
		}
	}

	onClose(): void {
		this.contentEl.empty();
	}
}
