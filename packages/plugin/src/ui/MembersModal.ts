import type { Member, Role, WorkspaceSummary } from "@arcasync/shared";
import { type App, Modal, Notice, Setting } from "obsidian";
import { type ApiClient, ApiRequestError } from "../net/ApiClient";
import type { ConfirmOptions } from "./ConfirmModal";

const ROLES: Record<Role, string> = { owner: "Owner", editor: "Editor", viewer: "Viewer" };

export function describeMemberError(error: unknown): string {
	if (error instanceof ApiRequestError) {
		if (error.code === "last_owner") return "A workspace needs at least one owner";
		if (error.code === "forbidden") return "Only owners and admins can do that";
		return error.message;
	}
	return error instanceof Error ? error.message : String(error);
}

export interface MembersModalOptions {
	api: ApiClient;
	/** Workspaces this user may manage (owner, or every one for an admin). */
	workspaces: WorkspaceSummary[];
	workspaceId: string;
	selfId: string | null;
	confirm(options: ConfirmOptions): void;
}

/** Owner tools: every member of a workspace with a role dropdown and a Remove button. */
export class MembersModal extends Modal {
	private workspaceId: string;
	private listEl!: HTMLElement;

	constructor(
		app: App,
		private readonly options: MembersModalOptions,
	) {
		super(app);
		this.workspaceId = options.workspaceId;
	}

	onOpen(): void {
		this.titleEl.setText("Workspace members");
		const { workspaces } = this.options;
		if (workspaces.length > 1) {
			new Setting(this.contentEl).setName("Workspace").addDropdown((dropdown) => {
				for (const w of workspaces) dropdown.addOption(w.id, w.name);
				dropdown.setValue(this.workspaceId).onChange((value) => {
					this.workspaceId = value;
					void this.load();
				});
				dropdown.selectEl.addClass("teamsync-members-workspace");
			});
		}
		this.listEl = this.contentEl.createDiv({ cls: "teamsync-members" });
		void this.load();
	}

	private get workspaceName(): string {
		return this.options.workspaces.find((w) => w.id === this.workspaceId)?.name ?? "";
	}

	private async load(): Promise<void> {
		const workspaceId = this.workspaceId;
		let members: Member[];
		try {
			members = await this.options.api.members(workspaceId);
		} catch (error) {
			if (workspaceId !== this.workspaceId) return;
			this.listEl.empty();
			this.listEl.createEl("p", { cls: "mod-warning", text: describeMemberError(error) });
			return;
		}
		if (workspaceId !== this.workspaceId) return;
		this.listEl.empty();
		for (const member of members) this.renderMember(member);
	}

	private renderMember({ user, role }: Member): void {
		const self = user.id === this.options.selfId;
		const row = new Setting(this.listEl)
			.setName(self ? `${user.name} (you)` : user.name)
			.addDropdown((dropdown) => {
				for (const [value, label] of Object.entries(ROLES)) dropdown.addOption(value, label);
				dropdown.setValue(role).onChange((value) => void this.setRole(user.id, value as Role));
				dropdown.selectEl.addClass("teamsync-member-role");
			})
			.addButton((button) => {
				button
					.setButtonText("Remove")
					.setWarning()
					.onClick(() => this.remove(user.id, user.name));
				button.buttonEl.addClass("teamsync-member-remove");
			});
		row.settingEl.addClass("teamsync-member");
		row.settingEl.dataset.userId = user.id;
	}

	private async setRole(userId: string, role: Role): Promise<void> {
		try {
			await this.options.api.setRole(this.workspaceId, userId, role);
			new Notice(`TeamSync: role changed to ${ROLES[role].toLowerCase()}`);
		} catch (error) {
			new Notice(`TeamSync: ${describeMemberError(error)}`);
		}
		await this.load();
	}

	private remove(userId: string, name: string): void {
		const workspaceId = this.workspaceId;
		this.options.confirm({
			title: "Remove member",
			message: `Remove ${name} from ${this.workspaceName}? Their synced files stay on their devices.`,
			confirmText: "Remove",
			warning: true,
			onConfirm: async () => {
				try {
					await this.options.api.removeMember(workspaceId, userId);
					new Notice(`TeamSync: removed ${name}`);
				} catch (error) {
					new Notice(`TeamSync: ${describeMemberError(error)}`);
				}
				if (workspaceId === this.workspaceId) await this.load();
			},
		});
	}

	onClose(): void {
		this.contentEl.empty();
	}
}
