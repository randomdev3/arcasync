/**
 * Isolate-memory cache of `GET /api/auth/me` per session token (D10): a fresh hit skips the
 * AccountsDO request. Another isolate can serve data up to `ttlMs` old after a disable or role
 * change, so nothing that authorises reads it (ws-token, mutations and relay Auth go to the DOs).
 */
export interface MeCache<T> {
	get(token: string): T | undefined;
	set(token: string, value: T): void;
	drop(token: string): void;
	readonly size: number;
}

/** LRU via `Map` insertion order: a hit moves the entry to the end, eviction takes the first. */
export function createMeCache<T>({
	ttlMs,
	max,
	now = Date.now,
}: {
	ttlMs: number;
	max: number;
	now?: () => number;
}): MeCache<T> {
	const entries = new Map<string, { value: T; exp: number }>();
	return {
		get(token) {
			const entry = entries.get(token);
			if (!entry) return undefined;
			entries.delete(token);
			if (entry.exp <= now()) return undefined;
			entries.set(token, entry);
			return entry.value;
		},
		set(token, value) {
			entries.delete(token);
			entries.set(token, { value, exp: now() + ttlMs });
			while (entries.size > max) {
				const oldest = entries.keys().next().value;
				if (oldest === undefined) break;
				entries.delete(oldest);
			}
		},
		drop(token) {
			entries.delete(token);
		},
		get size() {
			return entries.size;
		},
	};
}

/** A fresh cached value, or `load()`; only successful results are stored. */
export async function cachedResult<T, E>(
	cache: MeCache<T>,
	token: string,
	load: () => Promise<{ ok: true; value: T } | { ok: false; error: E }>,
): Promise<{ ok: true; value: T } | { ok: false; error: E }> {
	const hit = cache.get(token);
	if (hit !== undefined) return { ok: true, value: hit };
	const result = await load();
	if (result.ok) cache.set(token, result.value);
	return result;
}
