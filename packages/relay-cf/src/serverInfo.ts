import { CHUNK_BYTES, PRESENCE_RENEWAL_MS, type ServerInfo } from "@teamsync/shared";

export const RELAY_VERSION = "0.0.1-cf";

/** The `Env` fields `/server-info` reads (kept free of Workers types for unit tests). */
export interface ServerInfoEnv {
	TEAMSYNC_DEV_OPEN_LOGIN: string;
	TEAMSYNC_MAX_FILE_BYTES: string;
	CHUNKS?: unknown;
}

/** Feature flags (D9): `chunks` only with an R2 binding, so `env.probe` reports false. */
export function serverInfo(env: ServerInfoEnv, publicUrl: string): ServerInfo {
	return {
		name: "TeamSync",
		version: RELAY_VERSION,
		publicUrl,
		features: {
			devOpenLogin: env.TEAMSYNC_DEV_OPEN_LOGIN === "1",
			presign: false,
			excalidraw: false,
			textKeepalive: true,
			presenceRenewalMs: PRESENCE_RENEWAL_MS,
			accounts: true,
			chunks: !!env.CHUNKS,
		},
		limits: { maxFileBytes: Number(env.TEAMSYNC_MAX_FILE_BYTES), chunkBytes: CHUNK_BYTES },
	};
}
