import type { AccountsDO } from "./AccountsDO";
import type { WorkspaceRelay } from "./WorkspaceRelay";

export interface Env {
	ACCOUNTS: DurableObjectNamespace<AccountsDO>;
	RELAY: DurableObjectNamespace<WorkspaceRelay>;
	/** A `wrangler secret`; the worker refuses to serve when it is missing or weak (config.ts). */
	ARCASYNC_SECRET: string;
	ARCASYNC_ALLOW_DEV_SECRET?: string;
	ARCASYNC_DEV_OPEN_LOGIN: string;
	ARCASYNC_DEBUG_STATS: string;
	ARCASYNC_MAX_FILE_BYTES: string;
	/**
	 * The website's public URL (Cloudflare Pages). Invite links become `<it>/join?invite=` and
	 * device codes `<it>/approve?code=`; unset, they are `obsidian://arcasync` deep links.
	 */
	ARCASYNC_PUBLIC_URL?: string;
	/** Comma-separated website origins allowed to call `/api/*` cross-origin (CORS). */
	ARCASYNC_SITE_ORIGINS?: string;
	/** R2 `arcasync-chunks`; absent in `env.probe`, so chunk routes and `features.chunks` are off. */
	CHUNKS?: R2Bucket;
	/** Bearer for the one-shot `POST /api/auth/bootstrap`; a `wrangler secret` in production. */
	ARCASYNC_BOOTSTRAP_TOKEN?: string;
	/** Dev/test override of `CHUNK_GC_DELAY_MS`. */
	ARCASYNC_CHUNK_GC_DELAY_MS?: string;
	/** Dev/test override of `DEVICE_CODE_TTL_S`. */
	ARCASYNC_DEVICE_CODE_TTL_S?: string;
}
