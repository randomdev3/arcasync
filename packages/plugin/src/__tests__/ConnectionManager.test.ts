import { CLOSE_MEMBERSHIP_CHANGED, docName } from "@arcasync/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import { ApiRequestError } from "../net/ApiClient";
import {
	AUTH_RETRY_DELAY_MS,
	ConnectionManager,
	type MembershipChange,
} from "../net/ConnectionManager";
import { TokenStore } from "../net/TokenStore";

/** Stand-ins for provider 4.7.0's socket and provider: just the events ConnectionManager uses. */
const fakes = vi.hoisted(() => {
	type Fn = (data?: unknown) => void;
	class Emitter {
		private readonly handlers = new Map<string, Set<Fn>>();
		on(event: string, fn: Fn | undefined): void {
			if (!fn) return;
			let set = this.handlers.get(event);
			if (!set) {
				set = new Set();
				this.handlers.set(event, set);
			}
			set.add(fn);
		}
		off(event: string, fn: Fn): void {
			this.handlers.get(event)?.delete(fn);
		}
		emit(event: string, data?: unknown): void {
			for (const fn of [...(this.handlers.get(event) ?? [])]) fn(data);
		}
	}

	interface SocketConfig {
		onOpen?: Fn;
		onClose?: Fn;
		onStatus?: Fn;
	}

	class FakeSocket extends Emitter {
		static all: FakeSocket[] = [];
		shouldConnect = true;
		isOpen = false;
		readonly providers = new Set<FakeProvider>();
		constructor(config: SocketConfig) {
			super();
			FakeSocket.all.push(this);
			this.on("open", config.onOpen);
			this.on("close", config.onClose);
		}
		attach(provider: FakeProvider): void {
			this.providers.add(provider);
			if (this.isOpen) void provider.onOpen();
		}
		detach(provider: FakeProvider): void {
			this.providers.delete(provider);
		}
		disconnect(): void {
			this.shouldConnect = false;
		}
		destroy(): void {
			this.disconnect();
		}
		/** The socket opened: like 4.7.0, `open` listeners run, then each provider sends Auth. */
		open(): void {
			this.isOpen = true;
			this.emit("open", {});
			for (const p of this.providers) void p.onOpen();
		}
		/** Closed by the server; reconnects after `delay` (1 s) whenever `shouldConnect`. */
		close(code: number): void {
			this.isOpen = false;
			this.emit("close", { event: { code, reason: "" } });
			if (this.shouldConnect) setTimeout(() => this.shouldConnect && this.open(), 1000);
		}
	}

	interface ProviderConfig {
		websocketProvider: FakeSocket;
		token: () => Promise<string>;
		onAuthenticationFailed?: Fn;
	}

	class FakeProvider extends Emitter {
		static all: FakeProvider[] = [];
		attaches = 0;
		detaches = 0;
		syncs = 0;
		readonly sentTokens: string[] = [];
		authorizedScope: string | undefined;
		constructor(readonly config: ProviderConfig) {
			super();
			FakeProvider.all.push(this);
			this.on("authenticationFailed", config.onAuthenticationFailed);
		}
		attach(): void {
			this.attaches++;
			this.config.websocketProvider.attach(this);
		}
		detach(): void {
			this.detaches++;
			this.config.websocketProvider.detach(this);
		}
		destroy(): void {
			this.detach();
		}
		/** A throwing token callback becomes `authenticationFailed`, as in 4.7.0. */
		async sendToken(): Promise<void> {
			try {
				this.sentTokens.push(await this.config.token());
			} catch (error) {
				this.emit("authenticationFailed", { reason: String(error) });
			}
		}
		startSync(): void {
			this.syncs++;
		}
		async onOpen(): Promise<void> {
			await this.sendToken();
			this.startSync();
		}
		deny(): void {
			this.emit("authenticationFailed", { reason: "permission-denied" });
		}
	}

	return { FakeSocket, FakeProvider };
});

vi.mock("@hocuspocus/provider", () => ({
	HocuspocusProviderWebsocket: fakes.FakeSocket,
	HocuspocusProvider: fakes.FakeProvider,
	WebSocketStatus: {
		Connecting: "connecting",
		Connected: "connected",
		Disconnected: "disconnected",
	},
}));

const WS = "ws1";

function setup(fetchToken: (workspaceId: string) => Promise<{ token: string; expiresAt: number }>) {
	const fetch = vi.fn(fetchToken);
	const tokenStore = new TokenStore({ fetchToken: fetch });
	const invalidate = vi.spyOn(tokenStore, "invalidate");
	const manager = new ConnectionManager({ url: "ws://relay.test/ws", workspaceId: WS, tokenStore });
	const changes: MembershipChange[] = [];
	manager.onMembershipChanged((c) => changes.push(c));
	manager.openDoc(docName({ workspaceId: WS, kind: "md", fileId: "f1" }), new Y.Doc());
	const socket = fakes.FakeSocket.all.at(-1);
	const provider = fakes.FakeProvider.all.at(-1);
	if (!socket || !provider) throw new Error("no socket or provider");
	return { fetch, invalidate, manager, changes, socket, provider };
}

let minted = 0;
const mint = async () => ({ token: `t${++minted}`, expiresAt: Date.now() + 15 * 60_000 });

beforeEach(() => {
	vi.useFakeTimers();
	fakes.FakeSocket.all = [];
	fakes.FakeProvider.all = [];
	minted = 0;
});

afterEach(() => {
	vi.useRealTimers();
});

describe("ConnectionManager membership changes", () => {
	it("a 4401 close invalidates the workspace token exactly once, and the reconnect re-mints", async () => {
		const { fetch, invalidate, manager, changes, socket, provider } = setup(mint);
		socket.open();
		await vi.advanceTimersByTimeAsync(0);
		expect(provider.sentTokens).toEqual(["t1"]);

		socket.close(CLOSE_MEMBERSHIP_CHANGED);
		expect(invalidate).toHaveBeenCalledTimes(1);
		expect(invalidate).toHaveBeenCalledWith(WS);
		expect(changes).toEqual([{ removed: false }]);
		expect(manager.lastCloseCode).toBe(CLOSE_MEMBERSHIP_CHANGED);
		expect(manager.currentState.status).not.toBe("error");

		await vi.advanceTimersByTimeAsync(1000);
		expect(provider.sentTokens).toEqual(["t1", "t2"]);
		expect(fetch).toHaveBeenCalledTimes(2);
		expect(invalidate).toHaveBeenCalledTimes(1);
	});

	it("a ws-token 404 marks the workspace removed and stops reconnecting", async () => {
		const { fetch, changes, manager, socket } = setup(async () => {
			throw new ApiRequestError(404, "not_found", "No membership in that workspace");
		});
		socket.open();
		await vi.advanceTimersByTimeAsync(0);
		expect(fetch).toHaveBeenCalledTimes(1);
		expect(manager.removed).toBe(true);
		expect(socket.shouldConnect).toBe(false);
		expect(changes).toEqual([{ removed: true }]);

		// The relay closes the socket; nothing reconnects, mints or retries in 10 s.
		socket.close(1000);
		await vi.advanceTimersByTimeAsync(10_000);
		expect(fetch).toHaveBeenCalledTimes(1);
		expect(changes).toEqual([{ removed: true }]);
		manager.connect();
		expect(fakes.FakeSocket.all).toHaveLength(1);
	});

	it("a refused Auth drops the token and re-authenticates the doc once, after 1.5 s", async () => {
		const { fetch, invalidate, manager, socket, provider } = setup(mint);
		socket.open();
		await vi.advanceTimersByTimeAsync(0);
		expect(provider.syncs).toBe(1);

		provider.deny();
		expect(invalidate).toHaveBeenCalledWith(WS);
		await vi.advanceTimersByTimeAsync(AUTH_RETRY_DELAY_MS - 1);
		expect(provider.sentTokens).toEqual(["t1"]);
		await vi.advanceTimersByTimeAsync(1);
		// Auth with a fresh token, then SyncStep1 again; no detach (its Close would be replayed).
		expect(provider.sentTokens).toEqual(["t1", "t2"]);
		expect(provider.syncs).toBe(2);
		expect([provider.detaches, provider.attaches]).toEqual([0, 1]);

		// Refused again: no second retry, and the failure shows.
		provider.deny();
		await vi.advanceTimersByTimeAsync(10_000);
		expect(provider.sentTokens).toHaveLength(2);
		expect(fetch).toHaveBeenCalledTimes(2);
		expect(manager.currentState.status).toBe("error");
	});

	it("a new socket gives every doc its retry back", async () => {
		const { socket, provider } = setup(mint);
		socket.open();
		await vi.advanceTimersByTimeAsync(0);
		provider.deny();
		await vi.advanceTimersByTimeAsync(AUTH_RETRY_DELAY_MS);
		expect(provider.sentTokens).toHaveLength(2);

		socket.close(CLOSE_MEMBERSHIP_CHANGED);
		await vi.advanceTimersByTimeAsync(1000);
		expect(provider.sentTokens).toHaveLength(3);
		provider.deny();
		await vi.advanceTimersByTimeAsync(AUTH_RETRY_DELAY_MS);
		expect(provider.sentTokens).toHaveLength(4);
	});
});
