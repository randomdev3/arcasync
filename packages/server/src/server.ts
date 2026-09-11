import type { IncomingMessage } from "node:http";
import type { Hocuspocus, WebSocketLike } from "@hocuspocus/server";
import { createAdaptorServer } from "@hono/node-server";
import { WS_PATH } from "@teamsync/shared";
import { type RawData, WebSocketServer } from "ws";
import { createApp } from "./app.js";
import { wsConnections } from "./metrics.js";
import type { Deps } from "./types.js";

function toUint8Array(data: RawData): Uint8Array {
	if (Buffer.isBuffer(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
	if (Array.isArray(data)) return new Uint8Array(Buffer.concat(data));
	return new Uint8Array(data as ArrayBuffer);
}

/**
 * Hocuspocus 4 expects a web-standard `Request`; Node hands us an `IncomingMessage`.
 * Only the URL and headers are ever read (for parameters and auth headers).
 */
export function toWebRequest(req: IncomingMessage): Request {
	const host = req.headers.host ?? "localhost";
	const url = new URL(req.url ?? "/", `http://${host}`);
	const headers = new Headers();
	for (const [name, value] of Object.entries(req.headers)) {
		if (value === undefined || name.startsWith(":")) continue;
		if (Array.isArray(value)) {
			for (const item of value) headers.append(name, item);
		} else {
			headers.set(name, value);
		}
	}
	return new Request(url, { method: "GET", headers });
}

export function createHttpServer(deps: Deps, hocuspocus: Hocuspocus) {
	const app = createApp(deps);
	const httpServer = createAdaptorServer({ fetch: app.fetch });
	// Hocuspocus drives the socket itself; we only route the upgrade to it.
	const wss = new WebSocketServer({ noServer: true });

	httpServer.on("upgrade", (req, socket, head) => {
		let pathname: string;
		try {
			pathname = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`).pathname;
		} catch {
			socket.destroy();
			return;
		}
		if (pathname !== WS_PATH) {
			socket.destroy();
			return;
		}
		wss.handleUpgrade(req, socket, head, (ws) => {
			const clientConnection = hocuspocus.handleConnection(
				ws as unknown as WebSocketLike,
				toWebRequest(req),
			);
			wsConnections.inc();
			// With the low-level `Hocuspocus` class we are responsible for forwarding
			// socket events (the batteries-included `Server` class does this via crossws).
			deps.log.debug({ url: req.url }, "ws upgrade accepted");
			ws.on("message", (data: RawData) => clientConnection.handleMessage(toUint8Array(data)));
			ws.on("close", (code: number, reason: Buffer) => {
				wsConnections.dec();
				clientConnection.handleClose({ code, reason: reason.toString() } as CloseEvent);
			});
			ws.on("error", (err: Error) => {
				deps.log.warn({ err }, "websocket error");
			});
		});
	});

	return { app, httpServer, wss };
}
