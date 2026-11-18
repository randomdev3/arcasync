import type { WorkspacePresence } from "@teamsync/shared";
import { toVault } from "../workspace/paths";

/** `here`: on this note and active; `elsewhere`: active on another note (or none); `idle`. */
export type AvatarState = "here" | "elsewhere" | "idle";

export interface AvatarModel {
	userId: string;
	name: string;
	initials: string;
	color: string;
	state: AvatarState;
	title: string;
}

const ORDER: Record<AvatarState, number> = { here: 0, elsewhere: 1, idle: 2 };

function initials(name: string): string {
	const words = name.trim().split(/\s+/).filter(Boolean);
	const letters = words.length > 1 ? `${words[0]?.[0]}${words[1]?.[0]}` : name.trim().slice(0, 2);
	return letters.toUpperCase() || "?";
}

/**
 * The facepile of a note view: every other present user, one avatar each (across devices),
 * `here` first. `file` is the view's note as a workspace path (null outside the mapped folder);
 * titles name the peer's note as a path in this vault (`bob — Shared/x.md`).
 */
export function avatarsFor(
	users: Map<string, WorkspacePresence[]>,
	selfId: string,
	file: string | null,
	root: string | null,
): AvatarModel[] {
	const avatars: AvatarModel[] = [];
	for (const [userId, devices] of users) {
		if (userId === selfId || devices.length === 0) continue;
		const here = devices.find((d) => !d.idle && file !== null && d.file === file);
		const active = devices.find((d) => !d.idle);
		const best = here ?? active ?? (devices[0] as WorkspacePresence);
		const state: AvatarState = here ? "here" : active ? "elsewhere" : "idle";
		const where = best.file === null ? null : root === null ? best.file : toVault(root, best.file);
		avatars.push({
			userId,
			name: best.user.name,
			initials: initials(best.user.name),
			color: best.user.color,
			state,
			title: where ? `${best.user.name} — ${where}` : best.user.name,
		});
	}
	return avatars.sort((a, b) => ORDER[a.state] - ORDER[b.state] || a.name.localeCompare(b.name));
}
