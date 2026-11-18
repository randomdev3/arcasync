import { HocuspocusProvider, HocuspocusProviderWebsocket } from "@hocuspocus/provider";
import {
	createKeepaliveWebSocket,
	installPresencePolicy,
	SessionResponse,
	type WebSocketClass,
	WS_PATH,
	WsTokenResponse,
} from "@teamsync/shared";
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
	/** Provider batch window (the plugin uses `FLUSH_DELAY_MS`). */
	flushDelay?: number;
	/** Wrap the socket with the shared text keepalive, pinging this often. */
	keepaliveMs?: number;
	/** Install the shared presence policy on awareness docs with this renewal interval. */
	presenceRenewalMs?: number;
	/** Presence policy tick, for time-scaled measurements (default from the policy). */
	presenceCheckMs?: number;
}

export interface DocOptions {
	/** Overrides `ClientOptions.awareness` for this doc. */
	awareness?: boolean;
}

/** One multiplexed socket, like the plugin's ConnectionManager, carrying any number of docs. */
export function client(base: string, workspaceId: string, options: ClientOptions = {}) {
	let opens = 0;
	let textFramesSent = 0;
	const rawSockets: WebSocket[] = [];
	/** The `ws` sockets underneath (for `terminate()`), counting text frames (keepalive pings). */
	class RawWebSocket extends WebSocket {
		constructor(address: string | URL, protocols?: string | string[]) {
			super(address, protocols);
			rawSockets.push(this);
		}

		override send(data: unknown, ...rest: unknown[]): void {
			if (typeof data === "string") textFramesSent += 1;
			(super.send as (...args: unknown[]) => void)(data, ...rest);
		}
	}
	const socket = new HocuspocusProviderWebsocket({
		url: `${base.replace(/^http/, "ws")}${WS_PATH}?ws=${workspaceId}`,
		WebSocketPolyfill: options.keepaliveMs
			? createKeepaliveWebSocket(RawWebSocket as unknown as WebSocketClass, {
					intervalMs: options.keepaliveMs,
				})
			: RawWebSocket,
		messageReconnectTimeout: options.messageReconnectTimeout ?? 30_000,
		onOpen: () => {
			opens += 1;
		},
	});
	const providers: HocuspocusProvider[] = [];

	const open = async (name: string, token: () => Promise<string>, doc: DocOptions = {}) => {
		const document = new Y.Doc();
		let awareness: Awareness | null = null;
		if (doc.awareness ?? options.awareness) {
			awareness = new Awareness(document);
			if (options.renewAwareness === false) clearInterval(awareness._checkInterval);
		}
		const provider = new HocuspocusProvider({
			websocketProvider: socket,
			name,
			document,
			awareness,
			token,
			flushDelay: options.flushDelay ?? false,
		});
		const synced = new Promise<void>((resolve, reject) => {
			provider.on("synced", () => resolve());
			provider.on("authenticationFailed", ({ reason }: { reason: string }) =>
				reject(new Error(`auth failed: ${reason}`)),
			);
		});
		provider.attach();
		providers.push(provider);
		if (awareness && options.presenceRenewalMs) {
			installPresencePolicy(awareness, {
				activeRenewMs: options.presenceRenewalMs,
				idleRenewMs: options.presenceRenewalMs,
				isIdle: () => false,
				checkIntervalMs: options.presenceCheckMs,
			});
		}
		await synced;
		return { provider, document, awareness };
	};

	return {
		socket,
		open,
		get opens() {
			return opens;
		},
		/** Text frames sent on the raw sockets: keepalive pings. */
		get pings() {
			return textFramesSent;
		},
		rawSockets,
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

export async function resetStats(base: string, workspaceId: string): Promise<void> {
	const res = await fetch(`${base}/api/debug/reset?ws=${workspaceId}`, { method: "POST" });
	if (!res.ok) throw new Error(`debug reset -> ${res.status}`);
}

export async function stats(base: string, workspaceId: string): Promise<RelayStats> {
	const res = await fetch(`${base}/api/debug/stats?ws=${workspaceId}`);
	return (await res.json()) as RelayStats;
}
