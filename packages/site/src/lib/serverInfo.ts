import type { Api } from "./api";

export type Provider = "google" | "github";

export const PROVIDERS: readonly Provider[] = ["google", "github"];
export const PROVIDER_LABELS: Record<Provider, string> = { google: "Google", github: "GitHub" };

export function isProvider(value: unknown): value is Provider {
	return value === "google" || value === "github";
}

/** What the pages need from `GET /api/server-info` (read defensively: no zod in the browser). */
export interface SiteServerInfo {
	/** `/api/teams…` exists. */
	teams: boolean;
	/** `ServerInfo.auth` was present: OAuth, profile rename and linked identities exist. */
	auth: boolean;
	providers: Provider[];
	signups: "open" | "invite";
	limits: { teamsPerUser: number; membersPerTeam: number; foldersPerTeam: number } | null;
}

/** An older server, or one that couldn't be reached: password and device code only. */
export const LEGACY_INFO: SiteServerInfo = {
	teams: false,
	auth: false,
	providers: [],
	signups: "invite",
	limits: null,
};

const num = (value: unknown) => (typeof value === "number" && value > 0 ? value : null);

export function parseServerInfo(data: unknown): SiteServerInfo {
	const body = data as {
		features?: { teams?: unknown };
		auth?: { providers?: unknown; signups?: unknown; limits?: Record<string, unknown> };
	} | null;
	const auth = body?.auth && typeof body.auth === "object" ? body.auth : null;
	const providers = Array.isArray(auth?.providers)
		? PROVIDERS.filter((p) => (auth.providers as unknown[]).includes(p))
		: [];
	const l = auth?.limits;
	const teamsPerUser = num(l?.teamsPerUser);
	const membersPerTeam = num(l?.membersPerTeam);
	const foldersPerTeam = num(l?.foldersPerTeam);
	return {
		teams: body?.features?.teams === true,
		auth: auth !== null,
		providers,
		signups: auth?.signups === "open" ? "open" : "invite",
		limits:
			teamsPerUser && membersPerTeam && foldersPerTeam
				? { teamsPerUser, membersPerTeam, foldersPerTeam }
				: null,
	};
}

/** Never fails: an unreachable or older server reads as `LEGACY_INFO`. */
export async function loadServerInfo(api: Api): Promise<SiteServerInfo> {
	const res = await api.call<unknown>("GET", "/api/server-info");
	return res.ok ? parseServerInfo(res.data) : LEGACY_INFO;
}
