import { HocuspocusProvider, HocuspocusProviderWebsocket } from "@hocuspocus/provider";
import { SessionResponse, WS_PATH, WsTokenResponse } from "@teamsync/shared";
import { WebSocket } from "ws";
import { Awareness } from "y-protocols/awareness";
import * as Y from "yjs";

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export async function waitFor<T>(
	fn: () => T | Promise<T>,
	{ timeout = 10_000, interval = 50, label = "condition" } = {},
): Promise<T> {
	const deadline = Date.now() + timeout;
	let last: T | undefined;
	while (Date.now() < deadline) {
		last = await fn();
		if (last) return last;
		await sleep(interval);
	}
	throw new Error(`timed out waiting for ${label} (last: ${JSON.stringify(last)})`);
}

export async function post(base: string, path: string, body: unknown, token?: string) {
	const res = await fetch(`${base}${path}`, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			...(token ? { Authorization: `Bearer ${token}` } : {}),
		},
		body: JSON.stringify(body),
	});
	if (!res.ok) throw new Error(`${path} -> ${res.status} ${await res.text()}`);
	return res.json() as Promise<unknown>;
}

export async function login(base: string, name: string) {
	const session = SessionResponse.parse(
		await post(base, "/api/auth/dev-login", {
			name,
			device: { name: `${name}-device`, platform: "macos", vaultId: `${name}-vault` },
		}),
	);
	const workspace = session.workspaces[0];
	if (!workspace) throw new Error("no workspace");
	const token = async () =>
		WsTokenResponse.parse(
			await post(base, "/api/auth/ws-token", { workspaceId: workspace.id }, session.sessionToken),
		).token;
	return { session, workspaceId: workspace.id, token };
}

export interface ClientOptions {
	/** Give providers an Awareness (the plugin's counter doc has none). */
	awareness?: boolean;
	/** Keep y-protocols' 15 s awareness renewal (off lets the relay hibernate in tests). */
	renewAwareness?: boolean;
	/** Provider receive timeout before it force-reconnects (Hocuspocus default 30 s). */
	messageReconnectTimeout?: number;
}

/** One multiplexed socket, like the plugin's ConnectionManager, carrying any number of docs. */
export function client(base: string, workspaceId: string, options: ClientOptions = {}) {
	let opens = 0;
	const socket = new HocuspocusProviderWebsocket({
		url: `${base.replace(/^http/, "ws")}${WS_PATH}?ws=${workspaceId}`,
		WebSocketPolyfill: WebSocket,
		messageReconnectTimeout: options.messageReconnectTimeout ?? 30_000,
		onOpen: () => {
			opens += 1;
		},
	});
	const providers: HocuspocusProvider[] = [];

	const open = async (name: string, token: () => Promise<string>) => {
		const document = new Y.Doc();
		let awareness: Awareness | null = null;
		if (options.awareness) {
			awareness = new Awareness(document);
			if (options.renewAwareness === false) {
				clearInterval(
					(awareness as unknown as { _checkInterval: ReturnType<typeof setInterval> })
						._checkInterval,
				);
			}
		}
		const provider = new HocuspocusProvider({
			websocketProvider: socket,
			name,
			document,
			awareness,
			token,
		});
		const synced = new Promise<void>((resolve, reject) => {
			provider.on("synced", () => resolve());
			provider.on("authenticationFailed", ({ reason }: { reason: string }) =>
				reject(new Error(`auth failed: ${reason}`)),
			);
		});
		provider.attach();
		providers.push(provider);
		await synced;
		return { provider, document, awareness };
	};

	return {
		socket,
		open,
		get opens() {
			return opens;
		},
		destroy() {
			for (const p of providers) p.destroy();
			socket.destroy();
		},
	};
}

export interface RelayStats {
	wakes: number;
	msgs_in: number;
	msgs_out: number;
	connects: number;
	closes: number;
	app_rows_written: number;
	compactions: number;
	awake_ms_est: number;
	sockets: number;
	databaseSize: number;
}

export async function stats(base: string, workspaceId: string): Promise<RelayStats> {
	const res = await fetch(`${base}/api/debug/stats?ws=${workspaceId}`);
	return (await res.json()) as RelayStats;
}
