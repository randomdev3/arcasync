import type TeamSyncPlugin from "../main";
import { UserSuggestModal } from "../ui/userPicker";
import type { INavigator } from "../workspace/types";
import { avatarsFor } from "./avatars";

/** "Jump to user…" and "Follow user…": pick an online user, then jump to or follow them. */
export function registerNavigatorCommands(plugin: TeamSyncPlugin): void {
	const pick = (
		checking: boolean,
		placeholder: string,
		act: (navigator: INavigator, userId: string) => void,
	): boolean => {
		// The session of the active note's folder; with no active file (or one outside every
		// mapped folder), the primary workspace's.
		const file = plugin.app.workspace.getActiveFile();
		const session = (file && plugin.sessionFor(file.path)) ?? plugin.session;
		const navigator = session?.navigator;
		const presence = session?.presence;
		if (!session || !navigator || !presence) return false;
		if (checking) return true;
		const users = avatarsFor(presence.users(), session.user.id, null, session.root);
		new UserSuggestModal(
			plugin.app,
			users,
			(user) => act(navigator, user.userId),
			placeholder,
		).open();
		return true;
	};
	plugin.addCommand({
		id: "jump-to-user",
		name: "Jump to user…",
		checkCallback: (checking) =>
			pick(checking, "Jump to…", (navigator, userId) => void navigator.jumpTo(userId)),
	});
	plugin.addCommand({
		id: "follow-user",
		name: "Follow user…",
		checkCallback: (checking) =>
			pick(checking, "Follow…", (navigator, userId) => navigator.follow(userId)),
	});
}
