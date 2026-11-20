import { CHUNK_BYTES, PRESENCE_RENEWAL_MS, type ServerInfo } from "@arcasync/shared";
import { type CapsEnv, caps, signupPolicy } from "./accounts/caps";
import { enabledProviders, type OAuthCredentialsEnv } from "./oauth";

export const RELAY_VERSION = "0.0.1-cf";

/** The `Env` fields `/server-info` reads (kept free of Workers types for unit tests). */
export interface ServerInfoEnv extends CapsEnv, OAuthCredentialsEnv {
	ARCASYNC_DEV_OPEN_LOGIN: string;
	ARCASYNC_MAX_FILE_BYTES: string;
	CHUNKS?: unknown;
}

/** Feature flags (D9): `chunks` only with an R2 binding, so `env.probe` reports false. */
export function serverInfo(env: ServerInfoEnv, publicUrl: string): ServerInfo {
	const { teamsPerUser, membersPerTeam, foldersPerTeam } = caps(env);
	return {
		name: "ArcaSync",
		version: RELAY_VERSION,
		publicUrl,
		features: {
			devOpenLogin: env.ARCASYNC_DEV_OPEN_LOGIN === "1",
			presign: false,
			excalidraw: false,
			textKeepalive: true,
			presenceRenewalMs: PRESENCE_RENEWAL_MS,
			accounts: true,
			chunks: !!env.CHUNKS,
			bulkClone: true,
			passwords: true,
			pins: true,
			teams: true,
		},
		limits: { maxFileBytes: Number(env.ARCASYNC_MAX_FILE_BYTES), chunkBytes: CHUNK_BYTES },
		auth: {
			providers: enabledProviders(env),
			passwords: true,
			signups: signupPolicy(env),
			limits: { teamsPerUser, membersPerTeam, foldersPerTeam },
		},
	};
}
