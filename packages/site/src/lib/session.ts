/** Local storage keys. The session token is a bearer: see the security notes in docs/site.md. */
export const SESSION_KEY = "arcasync.session";
export const BROWSER_ID_KEY = "arcasync.browserId";
export const THEME_KEY = "arcasync.theme";
/** Session storage: the invite token between landing on /join and using it. */
export const PENDING_INVITE_KEY = "arcasync.pendingInvite";

/** The subset of `Storage` the site uses. */
export interface KeyValue {
	getItem(key: string): string | null;
	setItem(key: string, value: string): void;
	removeItem(key: string): void;
}

/** A `Map`-backed store: tests, and the fallback when the browser blocks storage. */
export function memoryStorage(): KeyValue {
	const map = new Map<string, string>();
	return {
		getItem: (k) => map.get(k) ?? null,
		setItem: (k, v) => void map.set(k, v),
		removeItem: (k) => void map.delete(k),
	};
}

/**
 * Wraps a browser storage so a private window, blocked site data or a quota error never throws:
 * reads come back null and writes fall back to memory for this page view.
 */
export function safeStorage(get: () => Storage): KeyValue {
	const fallback = memoryStorage();
	const attempt = <T>(fn: (s: Storage) => T, otherwise: () => T): T => {
		try {
			return fn(get());
		} catch {
			return otherwise();
		}
	};
	return {
		getItem: (k) =>
			attempt(
				(s) => s.getItem(k) ?? fallback.getItem(k),
				() => fallback.getItem(k),
			),
		setItem: (k, v) =>
			attempt(
				(s) => s.setItem(k, v),
				() => fallback.setItem(k, v),
			),
		removeItem: (k) => {
			fallback.removeItem(k);
			attempt(
				(s) => s.removeItem(k),
				() => undefined,
			);
		},
	};
}

export interface Session {
	token(): string | null;
	set(token: string): void;
	clear(): void;
}

export function createSession(storage: KeyValue): Session {
	return {
		token: () => storage.getItem(SESSION_KEY) || null,
		set: (token) => storage.setItem(SESSION_KEY, token),
		clear: () => storage.removeItem(SESSION_KEY),
	};
}
