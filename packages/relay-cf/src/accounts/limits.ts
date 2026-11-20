/**
 * Brute-force limits as pure functions over failure timestamps (AccountsDO keeps the rows).
 */

export const MINUTE_MS = 60_000;
export const HOUR_MS = 60 * MINUTE_MS;

/** Wrong PINs per client IP per 15 min; the next attempt gets 429. */
export const PIN_IP_LIMIT = { max: 5, windowMs: 15 * MINUTE_MS };
/**
 * Wrong PINs server-wide in a rolling 24 h that lock all PIN entry (423) for 24 h. High enough
 * that strangers cannot cheaply lock everyone out; 6-digit PINs keep guessing hopeless anyway.
 */
export const PIN_GLOBAL_LIMIT = { max: 500, windowMs: 24 * HOUR_MS };
export const PIN_LOCK_MS = 24 * HOUR_MS;
/** Failed sign-ins per name, and per client IP, per 15 min. */
export const LOGIN_NAME_LIMIT = { max: 5, windowMs: 15 * MINUTE_MS };
export const LOGIN_IP_LIMIT = { max: 20, windowMs: 15 * MINUTE_MS };
/** Hard cap on stored login-failure rows (names are attacker-chosen). */
export const LOGIN_FAILURE_ROWS_MAX = 5000;

export interface Limit {
	max: number;
	windowMs: number;
}

/**
 * Null while fewer than `limit.max` of `times` fall inside the window ending at `now`; otherwise
 * the whole seconds until the oldest of the newest `max` leaves it (at least 1).
 */
export function retryAfter(times: readonly number[], now: number, limit: Limit): number | null {
	const recent = times.filter((t) => t > now - limit.windowMs).sort((a, b) => b - a);
	if (recent.length < limit.max) return null;
	const oldestCounted = recent[limit.max - 1] ?? now;
	return Math.max(1, Math.ceil((oldestCounted + limit.windowMs - now) / 1000));
}

/** The key a name is matched and rate-limited by: NFC, lower case (Unicode-aware, unlike SQLite). */
export function nameKey(name: string): string {
	return name.normalize("NFC").toLowerCase();
}
