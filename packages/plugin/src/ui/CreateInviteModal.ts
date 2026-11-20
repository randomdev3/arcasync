import type { InviteSummary, PinSummary, Role, WorkspaceSummary } from "@arcasync/shared";
import { type App, Modal, Notice, Setting } from "obsidian";
import { type ApiClient, ApiRequestError } from "../net/ApiClient";
import { describeMemberError } from "./MembersModal";

const DAY_S = 86_400;

export interface CreateInviteModalOptions {
	api: ApiClient;
	/** Workspaces this user may invite to (owner, or every one for an admin). */
	workspaces: WorkspaceSummary[];
	workspaceId: string;
	/** The relay has PIN invites (`features.pins`): show the PINs section. */
	pins: boolean;
	/** A server admin: may unlock PIN entry. */
	isAdmin: boolean;
}

/** "Mon 24 Nov, 18:00" (local time). */
function formatWhen(ms: number): string {
	return new Date(ms).toLocaleString(undefined, {
		weekday: "short",
		day: "numeric",
		month: "short",
		hour: "2-digit",
		minute: "2-digit",
	});
}

function pinState(pin: PinSummary, now: number): string {
	if (pin.usedAt !== null) return `used by ${pin.usedBy ?? "someone"}`;
	if (pin.revoked) return "revoked";
	if (pin.expiresAt <= now) return "expired";
	return `expires ${formatWhen(pin.expiresAt)}`;
}

/**
 * Owner tools: creates an invite link (role, uses, expiry) and lists or revokes open ones; with
 * PIN invites, also creates, lists and revokes PINs, and lets an admin unlock PIN entry.
 */
export class CreateInviteModal extends Modal {
	private workspaceId: string;
	private role: Role = "editor";
	private pinRole: Role = "editor";
	private pinsEl: HTMLElement | null = null;
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
					void this.loadPins();
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
			dropdown.selectEl.addClass("arcasync-invite-role");
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
			button.buttonEl.addClass("arcasync-invite-create");
		});
		this.resultEl = this.contentEl.createDiv({ cls: "arcasync-invite-result" });
		this.openEl = this.contentEl.createDiv({ cls: "arcasync-invites-open" });
		void this.loadOpen();
		if (this.options.pins) this.renderPinSection();
	}

	private renderPinSection(): void {
		const section = this.contentEl.createDiv({ cls: "arcasync-pins" });
		new Setting(section)
			.setName("PINs")
			.setDesc(
				"A code to type instead of a link. Single use, valid for 72 hours; whoever uses it picks a name and password.",
			)
			.setHeading();
		new Setting(section)
			.setName("Role")
			.addDropdown((dropdown) => {
				dropdown
					.addOption("viewer", "Viewer")
					.addOption("editor", "Editor")
					.addOption("owner", "Owner")
					.setValue(this.pinRole)
					.onChange((value) => {
						this.pinRole = value as Role;
					});
				dropdown.selectEl.addClass("arcasync-pin-role");
			})
			.addButton((button) => {
				button
					.setButtonText("Create PIN")
					.setCta()
					.onClick(() => void this.createPin());
				button.buttonEl.addClass("arcasync-pin-create");
			});
		this.pinsEl = section.createDiv({ cls: "arcasync-pins-list" });
		void this.loadPins();
	}

	private async createPin(): Promise<void> {
		try {
			await this.options.api.createPin(this.workspaceId, { role: this.pinRole });
		} catch (error) {
			const message =
				error instanceof ApiRequestError && error.code === "too_many_pins"
					? "at most 10 PINs can be open; revoke one first"
					: describeMemberError(error);
			new Notice(`ArcaSync: ${message}`);
		}
		await this.loadPins();
	}

	/** The workspace's PINs (newest first) and, when locked, the lock with an admin unlock. */
	private async loadPins(): Promise<void> {
		const el = this.pinsEl;
		if (!el) return;
		const workspaceId = this.workspaceId;
		let listed: Awaited<ReturnType<typeof this.options.api.listPins>>;
		try {
			listed = await this.options.api.listPins(workspaceId);
		} catch {
			return;
		}
		if (workspaceId !== this.workspaceId) return;
		el.empty();
		if (listed.locked) {
			const lock = new Setting(el)
				.setName("PIN entry is locked")
				.setDesc(
					`Too many wrong PINs were tried. Locked until ${formatWhen(listed.lockedUntil ?? 0)}${
						this.options.isAdmin ? "." : "; a server admin can unlock it."
					}`,
				);
			lock.nameEl.addClass("arcasync-pins-locked");
			if (this.options.isAdmin) {
				lock.addButton((button) => {
					button.setButtonText("Unlock PIN entry").onClick(async () => {
						try {
							await this.options.api.unlockPins();
							new Notice("ArcaSync: PIN entry unlocked");
						} catch (error) {
							new Notice(`ArcaSync: ${describeMemberError(error)}`);
						}
						await this.loadPins();
					});
					button.buttonEl.addClass("arcasync-pins-unlock");
				});
			}
		}
		const now = Date.now();
		for (const pin of listed.pins) {
			const open = pin.usedAt === null && !pin.revoked && pin.expiresAt > now;
			const row = new Setting(el)
				.setName(pin.pin)
				.setDesc(`${pin.role}${pin.admin ? " (admin)" : ""} · ${pinState(pin, now)}`);
			row.settingEl.addClass("arcasync-pin");
			row.settingEl.dataset.pinId = pin.id;
			row.nameEl.addClass("arcasync-pin-value");
			if (open) {
				row.addButton((button) =>
					button
						.setButtonText("Revoke")
						.setWarning()
						.onClick(async () => {
							try {
								await this.options.api.revokePin(workspaceId, pin.id);
							} catch (error) {
								new Notice(`ArcaSync: ${describeMemberError(error)}`);
							}
							await this.loadPins();
						}),
				);
			}
		}
	}

	private async create(): Promise<void> {
		const maxUses = Math.round(this.maxUses);
		const days = this.days;
		if (!(maxUses >= 1 && maxUses <= 100) || !(days >= 1 && days <= 30)) {
			new Notice("ArcaSync: uses must be 1–100 and expiry 1–30 days");
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
					text.inputEl.addClass("arcasync-invite-url");
				})
				.addButton((button) =>
					button.setButtonText("Copy").onClick(async () => {
						await navigator.clipboard.writeText(invite.url);
						new Notice("ArcaSync: invite link copied");
					}),
				);
			await this.loadOpen();
		} catch (error) {
			new Notice(`ArcaSync: ${describeMemberError(error)}`);
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
								new Notice(`ArcaSync: ${describeMemberError(error)}`);
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
