/**
 * Deploy-time sanity check. A deployment without a strong `TEAMSYNC_SECRET` (it signs WS JWTs and
 * peppers session tokens) must not serve anything, so the worker answers 503 on every route.
 */

/** The secret in `wrangler.jsonc` `env.dev`; anyone can read it, so it is only valid in dev. */
export const DEV_SECRET = "teamsync-local-dev-secret-not-for-production";
export const MIN_SECRET_LENGTH = 32;

export interface SecretConfig {
	TEAMSYNC_SECRET?: string;
	/** "1" only in `env.dev`: accepts `DEV_SECRET` and short test secrets. */
	TEAMSYNC_ALLOW_DEV_SECRET?: string;
}

export function configError(env: SecretConfig): string | null {
	const secret = env.TEAMSYNC_SECRET ?? "";
	if (!secret) return "TEAMSYNC_SECRET is not set (wrangler secret put TEAMSYNC_SECRET)";
	if (env.TEAMSYNC_ALLOW_DEV_SECRET === "1") return null;
	if (secret === DEV_SECRET) return "TEAMSYNC_SECRET is the public dev secret";
	if (secret.length < MIN_SECRET_LENGTH) {
		return `TEAMSYNC_SECRET is shorter than ${MIN_SECRET_LENGTH} characters`;
	}
	return null;
}
