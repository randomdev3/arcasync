import { type PresenceUser, userColor } from "@teamsync/shared";

/**
 * The `user` field of a note doc's awareness state, which y-codemirror.next reads for the caret
 * label and colour. `id` must be the JWT `sub` (the relay closes the socket with 4403 otherwise),
 * and the colour is derived from it so every peer draws the same colour for the same user.
 */
export function docUser(user: { id: string; name: string }): PresenceUser {
	return { id: user.id, name: user.name, ...userColor(user.id) };
}
