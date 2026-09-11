import {
	HocuspocusProvider,
	HocuspocusProviderWebsocket,
	WebSocketStatus,
} from "@hocuspocus/provider";
import { parseDocName } from "@teamsync/shared";
import type { Awareness } from "y-protocols/awareness";
import type * as Y from "yjs";
import type { TokenStore } from "./TokenStore";

export type ConnectionStatus = "disconnected" | "connecting" | "connected" | "error";

export interface ConnectionState {
	status: ConnectionStatus;
	/** Human-readable detail for the status bar; only set for `error`. */
	message?: string;
}

export interface OpenDocHandle {
	readonly provider: HocuspocusProvider;
	/** Detach this document without touching the shared socket. */
	close(): void;
}

export interface ConnectionManagerOptions {
	/** Full websocket URL, e.g. `ws://localhost:8787/ws`. */
	url: string;
	tokenStore: TokenStore;
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
	private state: ConnectionState = { status: "disconnected" };

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

	connect(): void {
		if (this.socket) return;
		this.setState({ status: "connecting" });
		this.socket = new HocuspocusProviderWebsocket({
			url: this.options.url,
			onStatus: ({ status }) => this.setState({ status: STATUS_BY_SOCKET[status] }),
			onClose: ({ event }) => {
				if (event.code >= 4000) {
					this.setState({ status: "error", message: event.reason || `closed ${event.code}` });
				}
			},
		});
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
		if (!ref) throw new Error(`not a TeamSync document name: ${name}`);
		if (!this.socket) this.connect();
		const socket = this.socket;
		if (!socket) throw new Error("connection manager is not connected");

		const provider = new HocuspocusProvider({
			websocketProvider: socket,
			name,
			document: ydoc,
			awareness: awareness ?? null,
			token: () => this.options.tokenStore.get(ref.workspaceId),
			onAuthenticationFailed: ({ reason }) => {
				this.options.tokenStore.invalidate(ref.workspaceId);
				this.setState({ status: "error", message: reason });
			},
		});

		const handle: OpenDocHandle = {
			provider,
			close: () => {
				this.docs.delete(name);
				provider.destroy();
			},
		};
		this.docs.set(name, handle);
		return handle;
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
	}

	private setState(state: ConnectionState): void {
		this.state = state;
		for (const listener of this.listeners) {
			try {
				listener(state);
			} catch (error) {
				console.error("[TeamSync] connection listener failed", error);
			}
		}
	}
}
