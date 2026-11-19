/**
 * Deploy-time sanity check. A deployment without a strong `ARCASYNC_SECRET` (it signs WS JWTs and
 * peppers session tokens) must not serve anything, so the worker answers 503 on every route.
 */

/** The secret in `wrangler.jsonc` `env.dev`; anyone can read it, so it is only valid in dev. */
export const DEV_SECRET = "arcasync-local-dev-secret-not-for-production";
export const MIN_SECRET_LENGTH = 32;

export interface SecretConfig {
	ARCASYNC_SECRET?: string;
	/** "1" only in `env.dev`: accepts `DEV_SECRET` and short test secrets. */
	ARCASYNC_ALLOW_DEV_SECRET?: string;
}

export function configError(env: SecretConfig): string | null {
	const secret = env.ARCASYNC_SECRET ?? "";
	if (!secret) return "ARCASYNC_SECRET is not set (wrangler secret put ARCASYNC_SECRET)";
	if (env.ARCASYNC_ALLOW_DEV_SECRET === "1") return null;
	if (secret === DEV_SECRET) return "ARCASYNC_SECRET is the public dev secret";
	if (secret.length < MIN_SECRET_LENGTH) {
		return `ARCASYNC_SECRET is shorter than ${MIN_SECRET_LENGTH} characters`;
	}
	return null;
}
