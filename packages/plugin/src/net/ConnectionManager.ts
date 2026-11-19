import {
	CLOSE_MEMBERSHIP_CHANGED,
	createKeepaliveWebSocket,
	FLUSH_DELAY_MS,
	installPresencePolicy,
	KEEPALIVE_INTERVAL_MS,
	KEEPALIVE_RECONNECT_TIMEOUT_MS,
	PRESENCE_IDLE_RENEWAL_MS,
	type PresencePolicy,
	parseDocName,
	type ServerInfo,
} from "@arcasync/shared";
import {
	HocuspocusProvider,
	HocuspocusProviderWebsocket,
	WebSocketStatus,
} from "@hocuspocus/provider";
import type { Awareness } from "y-protocols/awareness";
import type * as Y from "yjs";
import { ApiRequestError } from "./ApiClient";
import type { TokenStore } from "./TokenStore";

/** A doc whose Auth was refused re-authenticates once after this (a token minted in the revocation second is refused). */
export const AUTH_RETRY_DELAY_MS = 1500;

/** `POST /api/auth/ws-token` answered 404: this account is no longer a member of the workspace. */
export class RemovedError extends Error {
	constructor(readonly workspaceId: string) {
		super(`Removed from workspace ${workspaceId}`);
		this.name = "RemovedError";
	}
}

/** The relay changed this user's membership: a new role (sockets re-mint) or a removal. */
export interface MembershipChange {
	removed: boolean;
}

export type ConnectionStatus = "disconnected" | "connecting" | "connected" | "error";

export interface ConnectionState {
	status: ConnectionStatus;
	/** Human-readable detail for the status bar; only set for `error`. */
	message?: string;
}

export interface OpenDocHandle {
	readonly provider: HocuspocusProvider;
	/** Set when the doc has awareness and the server advertises `presenceRenewalMs`. */
	readonly presence: PresencePolicy | null;
	/** Detach this document without touching the shared socket. */
	close(): void;
}

export interface ConnectionManagerOptions {
	/** Full websocket URL, e.g. `ws://localhost:8787/ws`. */
	url: string;
	/** The workspace this socket serves; its token is invalidated on a membership change. */
	workspaceId: string;
	tokenStore: TokenStore;
	/** `server-info.features`; relay-only traffic savings are gated on these flags. */
	features?: ServerInfo["features"];
	/** Drives the idle presence renewal interval; call `refreshPresence()` when it flips. */
	isIdle?: () => boolean;
}

const STATUS_BY_SOCKET: Record<WebSocketStatus, ConnectionStatus> = {
	[WebSocketStatus.Connecting]: "connecting",
	[WebSocketStatus.Connected]: "connected",
	[WebSocketStatus.Disconnected]: "disconnected",
};

/**
 * Owns the single multiplexed WebSocket to the server. Every document rides the
 * same socket (`HocuspocusProviderWebsocket`), which is the whole reason we use
 * Hocuspocus: one connection regardless of how many notes are open.
 */
export class ConnectionManager {
	private socket: HocuspocusProviderWebsocket | null = null;
	private readonly docs = new Map<string, OpenDocHandle>();
	private readonly listeners = new Set<(state: ConnectionState) => void>();
	private readonly membershipListeners = new Set<(change: MembershipChange) => void>();
	private state: ConnectionState = { status: "disconnected" };
	/** Docs that already used their one Auth retry since the socket last opened. */
	private readonly retried = new Set<string>();
	private readonly retryTimers = new Map<string, ReturnType<typeof setTimeout>>();
	/** Close code of the socket's last close, or null (tests and e2e read it). */
	lastCloseCode: number | null = null;
	/** Set once `ws-token` answered 404; the socket stays down from then on. */
	removed = false;

	constructor(private readonly options: ConnectionManagerOptions) {}

	get currentState(): ConnectionState {
		return this.state;
	}

	/** Subscribe to status changes; returns the unsubscribe function. */
	onStateChange(listener: (state: ConnectionState) => void): () => void {
		this.listeners.add(listener);
		listener(this.state);
		return () => this.listeners.delete(listener);
	}

	/** Subscribe to membership changes (4401 closes and removals); returns unsubscribe. */
	onMembershipChanged(listener: (change: MembershipChange) => void): () => void {
		this.membershipListeners.add(listener);
		return () => this.membershipListeners.delete(listener);
	}

	connect(): void {
		if (this.socket || this.removed) return;
		this.setState({ status: "connecting" });
		// Without traffic the provider force-reconnects every ~30 s. The relay answers a text
		// ping without waking its Durable Object, which is far cheaper than reconnect churn.
		const keepalive = this.options.features?.textKeepalive
			? {
					WebSocketPolyfill: createKeepaliveWebSocket(WebSocket, {
						intervalMs: KEEPALIVE_INTERVAL_MS,
					}),
					messageReconnectTimeout: KEEPALIVE_RECONNECT_TIMEOUT_MS,
				}
			: {};
		this.socket = new HocuspocusProviderWebsocket({
			url: this.options.url,
			...keepalive,
			onStatus: ({ status }) => {
				if (!this.removed) this.setState({ status: STATUS_BY_SOCKET[status] });
			},
			// Every doc re-authenticates on a new socket, so each gets its retry back.
			onOpen: () => this.retried.clear(),
			onClose: ({ event }) => {
				this.lastCloseCode = event.code;
				if (event.code === CLOSE_MEMBERSHIP_CHANGED) {
					// The provider reconnects by itself; the next Auth must carry a fresh token, which
					// either has the new role or learns (ws-token 404) that this user was removed.
					this.options.tokenStore.invalidate(this.options.workspaceId);
					this.emitMembership({ removed: false });
				} else if (event.code >= 4000) {
					this.setState({ status: "error", message: event.reason || `closed ${event.code}` });
				}
			},
		});
	}

	/**
	 * The provider's token callback. A ws-token 404 means this user was removed: the socket is
	 * stopped for good (no reconnect loop) and listeners learn it once.
	 */
	private async token(): Promise<string> {
		const { workspaceId, tokenStore } = this.options;
		if (this.removed) throw new RemovedError(workspaceId);
		try {
			return await tokenStore.get(workspaceId);
		} catch (error) {
			if (error instanceof ApiRequestError && error.status === 404) {
				this.markRemoved();
				throw new RemovedError(workspaceId);
			}
			throw error;
		}
	}

	private markRemoved(): void {
		if (this.removed) return;
		this.removed = true;
		for (const timer of this.retryTimers.values()) clearTimeout(timer);
		this.retryTimers.clear();
		// `disconnect` clears `shouldConnect`, so the provider schedules no reconnect.
		this.socket?.disconnect();
		this.setState({ status: "error", message: "Removed from this workspace" });
		this.emitMembership({ removed: true });
	}

	/**
	 * A doc's Auth was refused (provider 4.7.0 never retries by itself). The token is dropped and
	 * the doc re-authenticates once after `AUTH_RETRY_DELAY_MS`: `sendToken()` then `startSync()`.
	 * SyncStep1 must be resent because the relay drops frames queued behind a refused Auth. Not
	 * `detach()` + `attach()`: detach sends a Close that the relay queues for the unauthenticated
	 * doc and replays after the new Auth, dropping the doc again.
	 */
	private authFailed(name: string, provider: HocuspocusProvider, reason: string): void {
		if (this.removed) return;
		this.options.tokenStore.invalidate(this.options.workspaceId);
		if (this.retried.has(name) || this.retryTimers.has(name)) {
			this.setState({ status: "error", message: reason });
			return;
		}
		this.retried.add(name);
		const timer = setTimeout(async () => {
			this.retryTimers.delete(name);
			if (this.removed || this.docs.get(name)?.provider !== provider) return;
			await provider.sendToken();
			if (this.removed || this.docs.get(name)?.provider !== provider) return;
			provider.startSync();
		}, AUTH_RETRY_DELAY_MS);
		this.retryTimers.set(name, timer);
	}

	private emitMembership(change: MembershipChange): void {
		for (const listener of this.membershipListeners) {
			try {
				listener(change);
			} catch (error) {
				console.error("[ArcaSync] membership listener failed", error);
			}
		}
	}

	/**
	 * Attach a Y.Doc to the shared socket. The `token` option is an async function
	 * so Hocuspocus re-asks on every reconnect and on `onTokenSync`, letting
	 * `TokenStore` hand out a fresh JWT without the caller knowing.
	 */
	openDoc(name: string, ydoc: Y.Doc, awareness?: Awareness | null): OpenDocHandle {
		const existing = this.docs.get(name);
		if (existing) return existing;

		const ref = parseDocName(name);
		if (!ref) throw new Error(`not a ArcaSync document name: ${name}`);
		if (!this.socket) this.connect();
		const socket = this.socket;
		if (!socket) throw new Error("connection manager is not connected");

		const provider = new HocuspocusProvider({
			websocketProvider: socket,
			name,
			document: ydoc,
			awareness: awareness ?? null,
			// Batch keystrokes and awareness into one message (and one relay row) per window.
			flushDelay: FLUSH_DELAY_MS,
			token: () => this.token(),
			onAuthenticationFailed: ({ reason }) => this.authFailed(name, provider, reason),
		});
		// Hocuspocus 4: a provider given an explicit `websocketProvider` does not
		// attach itself (manageSocket=false), so nothing would ever be sent.
		provider.attach();

		const renewalMs = this.options.features?.presenceRenewalMs;
		const presence =
			awareness && renewalMs
				? installPresencePolicy(awareness, {
						activeRenewMs: renewalMs,
						idleRenewMs: PRESENCE_IDLE_RENEWAL_MS,
						isIdle: this.options.isIdle ?? (() => false),
					})
				: null;

		const handle: OpenDocHandle = {
			provider,
			presence,
			close: () => {
				this.docs.delete(name);
				this.clearRetry(name);
				presence?.dispose();
				provider.destroy();
			},
		};
		this.docs.set(name, handle);
		return handle;
	}

	private clearRetry(name: string): void {
		const timer = this.retryTimers.get(name);
		if (timer !== undefined) clearTimeout(timer);
		this.retryTimers.delete(name);
		this.retried.delete(name);
	}

	/** Re-evaluate `isIdle` for every open doc's presence policy. */
	refreshPresence(): void {
		for (const handle of this.docs.values()) handle.presence?.refresh();
	}

	/** Tear down every provider and the socket, but keep the manager reusable. */
	disconnect(): void {
		for (const handle of [...this.docs.values()]) handle.close();
		this.docs.clear();
		this.socket?.destroy();
		this.socket = null;
		this.setState({ status: "disconnected" });
	}

	destroy(): void {
		this.disconnect();
		this.listeners.clear();
		this.membershipListeners.clear();
	}

	private setState(state: ConnectionState): void {
		this.state = state;
		for (const listener of this.listeners) {
			try {
				listener(state);
			} catch (error) {
				console.error("[ArcaSync] connection listener failed", error);
			}
		}
	}
}
