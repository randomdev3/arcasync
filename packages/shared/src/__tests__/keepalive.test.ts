import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { KEEPALIVE_PING, KEEPALIVE_PONG } from "../constants";
import { createKeepaliveWebSocket, type WebSocketClass } from "../keepalive";

type Listener = (event: unknown) => void;

/** Just enough of a browser WebSocket to drive the wrapper by hand. */
class FakeSocket {
	static last: FakeSocket | null = null;
	binaryType: BinaryType = "blob";
	readyState = 0;
	readonly sent: unknown[] = [];
	private readonly listeners = new Map<string, Set<Listener>>();

	constructor(readonly url: string) {
		FakeSocket.last = this;
	}

	send(data: unknown): void {
		this.sent.push(data);
	}

	close(): void {
		this.readyState = 3;
		this.emit("close", { code: 1000 });
	}

	addEventListener(type: string, listener: Listener): void {
		if (!this.listeners.has(type)) this.listeners.set(type, new Set());
		this.listeners.get(type)?.add(listener);
	}

	removeEventListener(type: string, listener: Listener): void {
		this.listeners.get(type)?.delete(listener);
	}

	listenerCount(type: string): number {
		return this.listeners.get(type)?.size ?? 0;
	}

	open(): void {
		this.readyState = 1;
		this.emit("open", {});
	}

	emit(type: string, event: unknown): void {
		for (const listener of this.listeners.get(type) ?? []) listener(event);
	}
}

const Keepalive = createKeepaliveWebSocket(FakeSocket as unknown as WebSocketClass, {
	intervalMs: 1000,
});

function connect() {
	const ws = new Keepalive("ws://relay.test/ws");
	const inner = FakeSocket.last;
	if (!inner) throw new Error("no inner socket");
	return { ws, inner };
}

beforeEach(() => {
	vi.useFakeTimers();
});

afterEach(() => {
	vi.useRealTimers();
});

describe("createKeepaliveWebSocket", () => {
	it("sends a text ping every interval once open", () => {
		const { inner } = connect();
		vi.advanceTimersByTime(3000);
		expect(inner.sent).toEqual([]);

		inner.open();
		vi.advanceTimersByTime(999);
		expect(inner.sent).toEqual([]);
		vi.advanceTimersByTime(1);
		expect(inner.sent).toEqual([KEEPALIVE_PING]);
		vi.advanceTimersByTime(2000);
		expect(inner.sent).toEqual([KEEPALIVE_PING, KEEPALIVE_PING, KEEPALIVE_PING]);
	});

	it('re-emits "pong" as the no-op binary frame [0]', () => {
		const { ws, inner } = connect();
		const received: unknown[] = [];
		ws.addEventListener("message", (event) => received.push((event as MessageEvent).data));

		inner.emit("message", { data: KEEPALIVE_PONG });

		expect(received).toHaveLength(1);
		const data = received[0];
		expect(data).toBeInstanceOf(ArrayBuffer);
		expect([...new Uint8Array(data as ArrayBuffer)]).toEqual([0]);
	});

	it("passes every other frame through untouched", () => {
		const { ws, inner } = connect();
		const received: unknown[] = [];
		ws.addEventListener("message", (event) => received.push(event));
		const binary = { data: new Uint8Array([3, 1, 2]).buffer };
		const text = { data: "hello" };

		inner.emit("message", binary);
		inner.emit("message", text);

		expect(received).toEqual([binary, text]);
		expect(received[0]).toBe(binary);
		expect(received[1]).toBe(text);
	});

	it("removes a message listener by its original reference", () => {
		const { ws, inner } = connect();
		const listener = vi.fn();
		ws.addEventListener("message", listener);
		expect(inner.listenerCount("message")).toBe(1);

		ws.removeEventListener("message", listener);
		inner.emit("message", { data: "x" });

		expect(inner.listenerCount("message")).toBe(0);
		expect(listener).not.toHaveBeenCalled();
	});

	it("proxies the socket surface the provider uses", () => {
		const { ws, inner } = connect();
		ws.binaryType = "arraybuffer";
		ws.identifier = 7;
		ws.send("frame");

		expect(inner.binaryType).toBe("arraybuffer");
		expect(ws.url).toBe("ws://relay.test/ws");
		expect(ws.identifier).toBe(7);
		expect(inner.sent).toEqual(["frame"]);
		inner.open();
		expect(ws.readyState).toBe(1);
	});

	it("stops pinging on close and on error", () => {
		const closed = connect();
		closed.inner.open();
		closed.ws.close();
		vi.advanceTimersByTime(5000);
		expect(closed.inner.sent).toEqual([]);

		const errored = connect();
		errored.inner.open();
		errored.inner.emit("error", {});
		vi.advanceTimersByTime(5000);
		expect(errored.inner.sent).toEqual([]);
		expect(vi.getTimerCount()).toBe(0);
	});
});
