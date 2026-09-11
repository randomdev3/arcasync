import { z } from "zod";

export const PresenceUser = z.object({
	id: z.string(),
	name: z.string(),
	color: z.string(),
	colorLight: z.string(),
	avatar: z.string().optional(),
});
export type PresenceUser = z.infer<typeof PresenceUser>;

/** Awareness state published on the workspace index doc. */
export const WorkspacePresence = z.object({
	user: PresenceUser,
	device: z.object({ id: z.string(), platform: z.string() }),
	file: z.string().nullable(),
	following: z.string().nullable(),
	idle: z.boolean(),
	ts: z.number(),
});
export type WorkspacePresence = z.infer<typeof WorkspacePresence>;

/** y-codemirror.next relative-position cursor shape (JSON-encoded Y.RelativePosition). */
export const RelativeCursor = z.object({ anchor: z.unknown(), head: z.unknown() });

/** Awareness state published on a per-file doc. */
export const DocPresence = z.object({
	user: PresenceUser,
	file: z.string(),
	cursor: RelativeCursor.nullable().optional(),
	following: z.string().nullable().optional(),
	pointer: z
		.object({ x: z.number(), y: z.number(), tool: z.string(), button: z.string().optional() })
		.optional(),
});
export type DocPresence = z.infer<typeof DocPresence>;

const PALETTE: Array<[string, string]> = [
	["#30bced", "#30bced33"],
	["#6eeb83", "#6eeb8333"],
	["#ffbc42", "#ffbc4233"],
	["#ecd444", "#ecd44433"],
	["#ee6352", "#ee635233"],
	["#9ac2c9", "#9ac2c933"],
	["#8acb88", "#8acb8833"],
	["#1be7ff", "#1be7ff33"],
	["#c084fc", "#c084fc33"],
	["#fb7185", "#fb718533"],
];

/** Deterministic colour for a user id. */
export function userColor(userId: string): { color: string; colorLight: string } {
	let h = 0;
	for (let i = 0; i < userId.length; i++) h = (h * 31 + userId.charCodeAt(i)) >>> 0;
	const [color, colorLight] = PALETTE[h % PALETTE.length] as [string, string];
	return { color, colorLight };
}
