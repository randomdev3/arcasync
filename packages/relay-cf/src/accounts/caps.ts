/**
 * Team caps and the signup policy, from env vars (unset or invalid → defaults). Pure, so
 * `serverInfo` and AccountsDO read the same values.
 */
import type { SignupPolicy } from "@arcasync/shared";

export interface CapsEnv {
	ARCASYNC_TEAMS_PER_USER?: string;
	ARCASYNC_MEMBERS_PER_TEAM?: string;
	ARCASYNC_FOLDERS_PER_TEAM?: string;
	ARCASYNC_MAX_USERS?: string;
	ARCASYNC_SIGNUPS?: string;
}

export const DEFAULT_CAPS = {
	/** Teams a user owns (server admins are exempt). */
	teamsPerUser: 3,
	membersPerTeam: 25,
	foldersPerTeam: 10,
	/** Accounts on the whole server. */
	maxUsers: 200,
};
export type Caps = typeof DEFAULT_CAPS;

const positive = (value: string | undefined, fallback: number): number => {
	const n = Number(value);
	return value !== undefined && value !== "" && Number.isInteger(n) && n > 0 ? n : fallback;
};

export function caps(env: CapsEnv): Caps {
	return {
		teamsPerUser: positive(env.ARCASYNC_TEAMS_PER_USER, DEFAULT_CAPS.teamsPerUser),
		membersPerTeam: positive(env.ARCASYNC_MEMBERS_PER_TEAM, DEFAULT_CAPS.membersPerTeam),
		foldersPerTeam: positive(env.ARCASYNC_FOLDERS_PER_TEAM, DEFAULT_CAPS.foldersPerTeam),
		maxUsers: positive(env.ARCASYNC_MAX_USERS, DEFAULT_CAPS.maxUsers),
	};
}

/** `open` lets anyone create an account with Google or GitHub; anything else means `invite`. */
export function signupPolicy(env: CapsEnv): SignupPolicy {
	return env.ARCASYNC_SIGNUPS?.trim() === "open" ? "open" : "invite";
}
