/**
 * End-to-end WebSocket smoke test against a *running* server:
 *   pnpm --filter @arcasync/server dev        # terminal 1
 *   pnpm --filter @arcasync/server smoke      # terminal 2
 *
 * Logs in, opens the workspace index doc, writes a Y.Map key, disconnects,
 * reconnects with a fresh Y.Doc and asserts the value came back from the server.
 */

import { docName, SessionResponse, WS_PATH, WsTokenResponse } from "@arcasync/shared";
import { HocuspocusProvider, HocuspocusProviderWebsocket } from "@hocuspocus/provider";
import { WebSocket } from "ws";
import * as Y from "yjs";

const BASE = process.env.ARCASYNC_URL ?? "http://localhost:8787";
// `?ws=` routes the socket to the workspace's relay object; the Node server ignores it.
const wsUrl = (workspaceId: string) =>
	`${BASE.replace(/^http/, "ws")}${WS_PATH}?ws=${encodeURIComponent(workspaceId)}`;
const DEVICE = { name: "ws-smoke", platform: "macos" as const, vaultId: "ws-smoke" };
const KEY = "smoke";

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

async function json<T>(path: string, body: unknown, token?: string): Promise<unknown> {
	const res = await fetch(`${BASE}${path}`, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			...(token ? { Authorization: `Bearer ${token}` } : {}),
		},
		body: JSON.stringify(body),
	});
	if (!res.ok) throw new Error(`${path} -> ${res.status} ${await res.text()}`);
	return (await res.json()) as T;
}

async function connect(url: string, name: string, token: string) {
	const socket = new HocuspocusProviderWebsocket({ url, WebSocketPolyfill: WebSocket });
	const document = new Y.Doc();
	const provider = new HocuspocusProvider({ websocketProvider: socket, name, token, document });
	const synced = new Promise<void>((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error(`timed out syncing ${name}`)), 15_000);
		provider.on("synced", () => {
			clearTimeout(timer);
			resolve();
		});
		provider.on("authenticationFailed", (payload: { reason: string }) => {
			clearTimeout(timer);
			reject(new Error(`auth failed: ${payload.reason}`));
		});
	});
	// Hocuspocus 4: a provider given an external `websocketProvider` does NOT attach
	// itself — nothing is ever sent until `attach()` is called.
	provider.attach();
	await synced;
	return { socket, provider, document };
}

async function main(): Promise<void> {
	const session = SessionResponse.parse(
		await json("/api/auth/dev-login", { name: "smoke", device: DEVICE }),
	);
	const workspace = session.workspaces[0];
	if (!workspace) throw new Error("dev-login returned no workspace");
	console.log(`logged in as ${session.user.name} in workspace ${workspace.slug}`);

	const mintToken = async () =>
		WsTokenResponse.parse(
			await json("/api/auth/ws-token", { workspaceId: workspace.id }, session.sessionToken),
		).token;

	const name = docName({ workspaceId: workspace.id, kind: "index" });
	const value = `smoke-${Date.now()}`;

	const first = await connect(wsUrl(workspace.id), name, await mintToken());
	console.log(`connected to ${name}`);
	first.document.getMap("debug").set(KEY, value);
	// Let the update reach the server and the debounced store flush.
	await sleep(3_000);
	first.provider.destroy();
	first.socket.destroy();
	console.log("disconnected");

	// Wait past the store debounce + unload so the reconnect really reloads from the DB.
	await sleep(3_000);

	const second = await connect(wsUrl(workspace.id), name, await mintToken());
	const readBack = second.document.getMap("debug").get(KEY);
	second.provider.destroy();
	second.socket.destroy();

	if (readBack !== value) {
		throw new Error(`expected ${value} after reconnect, got ${String(readBack)}`);
	}
	console.log(`reconnected and read back ${KEY}=${String(readBack)}`);
	console.log("ws-smoke OK");
}

main()
	.then(() => process.exit(0))
	.catch((err) => {
		console.error("ws-smoke FAILED:", err);
		process.exit(1);
	});
