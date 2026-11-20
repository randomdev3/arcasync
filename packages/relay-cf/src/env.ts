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
	/** Dev/test only (with debug stats on): wrong PINs in 24 h that lock PIN entry (default 500). */
	ARCASYNC_PIN_LOCK_THRESHOLD?: string;
	/** Team caps (accounts/caps.ts); unset → 3 owned teams, 25 members, 10 folders, 200 users. */
	ARCASYNC_TEAMS_PER_USER?: string;
	ARCASYNC_MEMBERS_PER_TEAM?: string;
	ARCASYNC_FOLDERS_PER_TEAM?: string;
	ARCASYNC_MAX_USERS?: string;
	/** `open`: anyone may create an account with Google/GitHub. Anything else: invite only. */
	ARCASYNC_SIGNUPS?: string;
	/** OAuth apps (`wrangler secret`s). A provider is offered only when both of its values are set. */
	GOOGLE_CLIENT_ID?: string;
	GOOGLE_CLIENT_SECRET?: string;
	GITHUB_CLIENT_ID?: string;
	GITHUB_CLIENT_SECRET?: string;
	/** Dev/test only (with debug stats on): base URL of a fake OAuth provider (src/oauth.ts). */
	ARCASYNC_OAUTH_TEST_BASE?: string;
}
