import { KEEPALIVE_PING, KEEPALIVE_PONG } from "./constants.js";

const OPEN = 1;

export type WebSocketClass = new (url: string | URL, protocols?: string | string[]) => WebSocket;

export interface KeepaliveOptions {
	intervalMs: number;
}

type Listener = (event: unknown) => void;

/** The socket surface `HocuspocusProviderWebsocket` uses (`WebSocketPolyfill`). */
export interface KeepaliveSocket {
	/** Set by the provider to tell its sockets apart. */
	identifier: number;
	binaryType: BinaryType;
	readonly readyState: number;
	readonly url: string;
	send(data: string | ArrayBufferLike | ArrayBufferView | Blob): void;
	close(code?: number, reason?: string): void;
	addEventListener(type: string, listener: Listener): void;
	removeEventListener(type: string, listener: Listener): void;
}

export type KeepaliveSocketClass = new (
	url: string | URL,
	protocols?: string | string[],
) => KeepaliveSocket;

/**
 * Wraps a WebSocket class so each socket sends a text `"ping"` every `intervalMs` while open.
 * The relay answers it with `setWebSocketAutoResponse`, which never wakes the Durable Object.
 *
 * The provider's liveness check (`checkConnection`) only looks at `lastMessageReceived`, which
 * `onMessage` sets before parsing. The text `"pong"` is therefore re-emitted as the binary frame
 * `[0]`: it refreshes liveness, fails the Ping check and maps to no document, so it is a no-op.
 * Every other frame passes through untouched.
 */
export function createKeepaliveWebSocket(
	Base: WebSocketClass,
	{ intervalMs }: KeepaliveOptions,
): KeepaliveSocketClass {
	return class KeepaliveWebSocket implements KeepaliveSocket {
		identifier = 0;
		private readonly inner: WebSocket;
		private timer: ReturnType<typeof setInterval> | null = null;
		/** The provider removes listeners by their original reference. */
		private readonly wrapped = new Map<Listener, Listener>();

		constructor(url: string | URL, protocols?: string | string[]) {
			this.inner = new Base(url, protocols);
			this.inner.addEventListener("open", () => this.start());
			this.inner.addEventListener("close", () => this.stop());
			this.inner.addEventListener("error", () => this.stop());
		}

		get binaryType(): BinaryType {
			return this.inner.binaryType;
		}

		set binaryType(value: BinaryType) {
			this.inner.binaryType = value;
		}

		get readyState(): number {
			return this.inner.readyState;
		}

		get url(): string {
			return this.inner.url;
		}

		send(data: string | ArrayBufferLike | ArrayBufferView | Blob): void {
			this.inner.send(data);
		}

		close(code?: number, reason?: string): void {
			this.inner.close(code, reason);
		}

		addEventListener(type: string, listener: Listener): void {
			if (type !== "message") {
				this.inner.addEventListener(type, listener);
				return;
			}
			const wrapped: Listener = (event) => {
				const data = (event as MessageEvent).data;
				listener(
					data === KEEPALIVE_PONG
						? new MessageEvent("message", { data: new Uint8Array([0]).buffer })
						: event,
				);
			};
			this.wrapped.set(listener, wrapped);
			this.inner.addEventListener(type, wrapped);
		}

		removeEventListener(type: string, listener: Listener): void {
			const wrapped = type === "message" ? this.wrapped.get(listener) : undefined;
			if (wrapped) this.wrapped.delete(listener);
			this.inner.removeEventListener(type, wrapped ?? listener);
		}

		private start(): void {
			this.stop();
			this.timer = setInterval(() => {
				if (this.inner.readyState === OPEN) this.inner.send(KEEPALIVE_PING);
			}, intervalMs);
		}

		private stop(): void {
			if (this.timer !== null) clearInterval(this.timer);
			this.timer = null;
		}
	};
}
