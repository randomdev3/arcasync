import type { AccountsDO } from "./AccountsDO";
import type { WorkspaceRelay } from "./WorkspaceRelay";

export interface Env {
	ACCOUNTS: DurableObjectNamespace<AccountsDO>;
	RELAY: DurableObjectNamespace<WorkspaceRelay>;
	/** A `wrangler secret`; the worker refuses to serve when it is missing or weak (config.ts). */
	TEAMSYNC_SECRET: string;
	TEAMSYNC_ALLOW_DEV_SECRET?: string;
	TEAMSYNC_DEV_OPEN_LOGIN: string;
	TEAMSYNC_DEBUG_STATS: string;
	TEAMSYNC_MAX_FILE_BYTES: string;
	TEAMSYNC_PUBLIC_URL?: string;
	/** R2 `teamsync-chunks`; absent in `env.probe`, so chunk routes and `features.chunks` are off. */
	CHUNKS?: R2Bucket;
	/** Bearer for the one-shot `POST /api/auth/bootstrap`; a `wrangler secret` in production. */
	TEAMSYNC_BOOTSTRAP_TOKEN?: string;
	/** Dev/test override of `CHUNK_GC_DELAY_MS`. */
	TEAMSYNC_CHUNK_GC_DELAY_MS?: string;
	/** Dev/test override of `DEVICE_CODE_TTL_S`. */
	TEAMSYNC_DEVICE_CODE_TTL_S?: string;
}
