import { type App, Menu, SuggestModal } from "obsidian";
import type { AvatarModel } from "../presence/avatars";

/** The avatar menu: jump, and follow or stop following. */
export function showUserMenu(
	event: MouseEvent,
	user: { name: string; followed: boolean },
	actions: { jump(): void; follow(): void; unfollow(): void },
): void {
	const menu = new Menu();
	menu.addItem((item) =>
		item
			.setTitle(`Jump to ${user.name}`)
			.setIcon("locate")
			.onClick(() => actions.jump()),
	);
	menu.addItem((item) =>
		user.followed
			? item
					.setTitle(`Stop following ${user.name}`)
					.setIcon("eye-off")
					.onClick(() => actions.unfollow())
			: item
					.setTitle(`Follow ${user.name}`)
					.setIcon("eye")
					.onClick(() => actions.follow()),
	);
	menu.showAtMouseEvent(event);
}

/** Picks one of the other online users (the "Jump to user…" and "Follow user…" commands). */
export class UserSuggestModal extends SuggestModal<AvatarModel> {
	constructor(
		app: App,
		private readonly users: AvatarModel[],
		private readonly choose: (user: AvatarModel) => void,
		placeholder: string,
	) {
		super(app);
		this.setPlaceholder(placeholder);
		this.emptyStateText = "No one else is online";
	}

	getSuggestions(query: string): AvatarModel[] {
		const q = query.trim().toLowerCase();
		return this.users.filter((u) => u.name.toLowerCase().includes(q));
	}

	renderSuggestion(user: AvatarModel, el: HTMLElement): void {
		el.createDiv({ text: user.name });
		const where = user.title.slice(user.name.length).replace(/^ — /, "");
		el.createEl("small", {
			text: user.state === "idle" ? `${where || "No note"} (idle)` : where || "No note",
			cls: "teamsync-user-where",
		});
	}

	onChooseSuggestion(user: AvatarModel): void {
		this.choose(user);
	}
}
