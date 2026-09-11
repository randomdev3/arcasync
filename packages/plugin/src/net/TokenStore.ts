/** Renew this far ahead of `expiresAt` so an in-flight message never races expiry. */
export const REFRESH_MARGIN_MS = 2 * 60 * 1000;

export interface WsToken {
	token: string;
	/** Epoch milliseconds. */
	expiresAt: number;
}

export interface TokenStoreOptions {
	/** Mints a fresh WS token for a workspace (`POST /api/auth/ws-token`). */
	fetchToken(workspaceId: string): Promise<WsToken>;
	/** Injectable for tests. */
	now?(): number;
}

interface Entry {
	token: WsToken;
	/** In flight request, so N concurrent documents mint one token, not N. */
	pending: Promise<WsToken> | null;
}

/**
 * Per-workspace cache of short-lived WebSocket JWTs. Hocuspocus calls the
 * provider's async `token` option on every (re)connect and on `onTokenSync`, so
 * this is the single place that decides "still good" vs "mint a new one".
 */
export class TokenStore {
	private readonly entries = new Map<string, Entry>();
	private readonly fetchToken: (workspaceId: string) => Promise<WsToken>;
	private readonly now: () => number;

	constructor(options: TokenStoreOptions) {
		this.fetchToken = options.fetchToken;
		this.now = options.now ?? (() => Date.now());
	}

	/** True when the cached token is absent or inside the refresh margin. */
	isStale(token: WsToken | undefined): boolean {
		if (!token) return true;
		return token.expiresAt - this.now() <= REFRESH_MARGIN_MS;
	}

	/** Cached token for a workspace, fetching or refreshing it when stale. */
	async get(workspaceId: string): Promise<string> {
		const entry = this.entries.get(workspaceId);
		if (entry && !this.isStale(entry.token)) return entry.token.token;
		if (entry?.pending) return (await entry.pending).token;

		const pending = this.fetchToken(workspaceId);
		const next: Entry = { token: entry?.token ?? { token: "", expiresAt: 0 }, pending };
		this.entries.set(workspaceId, next);
		try {
			const token = await pending;
			this.entries.set(workspaceId, { token, pending: null });
			return token.token;
		} catch (error) {
			// Drop the failed attempt entirely; a stale token is useless and a
			// retained `pending` would wedge every later caller on one failure.
			this.entries.delete(workspaceId);
			throw error;
		}
	}

	/** Forget one workspace (role change, logout) or all of them (server change). */
	invalidate(workspaceId?: string): void {
		if (workspaceId === undefined) this.entries.clear();
		else this.entries.delete(workspaceId);
	}
}
