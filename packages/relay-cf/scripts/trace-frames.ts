/**
 * Records the raw Hocuspocus frames a real `@hocuspocus/provider` exchanges with a running
 * backend (Node oracle or relay) and writes them as JSON fixtures for the protocol tests.
 *
 *   node scripts/trace-frames.ts http://localhost:8787 test/fixtures/node-frames.json
 */
import { writeFileSync } from "node:fs";
import { docName, SessionResponse, WS_PATH, WsTokenResponse } from "@arcasync/shared";
import { HocuspocusProvider, HocuspocusProviderWebsocket } from "@hocuspocus/provider";
import { WebSocket } from "ws";
import * as Y from "yjs";

const BASE = process.argv[2] ?? "http://localhost:8787";
const OUT = process.argv[3];

interface Frame {
	client: string;
	dir: "out" | "in";
	hex: string;
}
const frames: Frame[] = [];
const hex = (data: ArrayBufferLike | Uint8Array) =>
	Buffer.from(data as ArrayBuffer).toString("hex");

function tracingSocket(client: string) {
	return class TracingWebSocket extends WebSocket {
		constructor(url: string) {
			super(url);
			this.addEventListener("message", (ev) => {
				frames.push({ client, dir: "in", hex: hex(ev.data as ArrayBuffer) });
			});
		}
		override send(data: Uint8Array): void {
			frames.push({ client, dir: "out", hex: hex(data) });
			super.send(data);
		}
	};
}

async function post(path: string, body: unknown, token?: string): Promise<unknown> {
	const res = await fetch(`${BASE}${path}`, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			...(token ? { Authorization: `Bearer ${token}` } : {}),
		},
		body: JSON.stringify(body),
	});
	if (!res.ok) throw new Error(`${path} -> ${res.status} ${await res.text()}`);
	return res.json();
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
	const session = SessionResponse.parse(
		await post("/api/auth/dev-login", {
			name: "tracer",
			device: { name: "trace", platform: "macos", vaultId: "trace" },
		}),
	);
	const ws = session.workspaces[0];
	if (!ws) throw new Error("no workspace");
	const token = async () =>
		WsTokenResponse.parse(
			await post("/api/auth/ws-token", { workspaceId: ws.id }, session.sessionToken),
		).token;
	const url = `${BASE.replace(/^http/, "ws")}${WS_PATH}?ws=${ws.id}`;
	const name = docName({ workspaceId: ws.id, kind: "index" });

	const open = async (client: string) => {
		const socket = new HocuspocusProviderWebsocket({
			url,
			WebSocketPolyfill: tracingSocket(client),
		});
		const document = new Y.Doc();
		const provider = new HocuspocusProvider({
			websocketProvider: socket,
			name,
			token: await token(),
			document,
		});
		const synced = new Promise<void>((r) => provider.on("synced", () => r()));
		provider.attach();
		await synced;
		return { socket, provider, document };
	};

	const a = await open("a");
	a.provider.setAwarenessField("user", { name: "a" });
	a.document.getMap("debug").set("trace", Date.now());
	await sleep(500);
	const b = await open("b");
	await sleep(500);
	b.document.getMap("debug").set("trace-b", 1);
	await sleep(500);
	for (const c of [a, b]) {
		c.provider.destroy();
		c.socket.destroy();
	}
	await sleep(200);
	if (OUT) writeFileSync(OUT, `${JSON.stringify(frames, null, "\t")}\n`);
	else console.log(JSON.stringify(frames, null, 2));
}

main().then(
	() => process.exit(0),
	(err) => {
		console.error(err);
		process.exit(1);
	},
);
