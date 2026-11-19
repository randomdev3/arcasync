import { createHash } from "node:crypto";
import { HocuspocusProvider, HocuspocusProviderWebsocket } from "@hocuspocus/provider";
import {
	BootstrapResponse,
	createKeepaliveWebSocket,
	installPresencePolicy,
	type Role,
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

/** Any request; resolves with the status and the parsed JSON body whatever the status. */
export async function request(
	base: string,
	method: string,
	path: string,
	{ body, token }: { body?: unknown; token?: string } = {},
): Promise<{ status: number; body: unknown }> {
	const res = await fetch(`${base}${path}`, {
		method,
		headers: {
			...(body === undefined ? {} : { "Content-Type": "application/json" }),
			...(token ? { Authorization: `Bearer ${token}` } : {}),
		},
		body: body === undefined ? undefined : JSON.stringify(body),
	});
	const text = await res.text();
	let parsed: unknown = text;
	try {
		parsed = text ? JSON.parse(text) : null;
	} catch {}
	return { status: res.status, body: parsed };
}

/** The `error.code` of an API error body. */
export function errorCode(body: unknown): string | undefined {
	return (body as { error?: { code?: string } } | null)?.error?.code;
}

async function ok(
	base: string,
	method: string,
	path: string,
	options: { body?: unknown; token?: string },
): Promise<unknown> {
	const res = await request(base, method, path, options);
	if (res.status < 200 || res.status >= 300) {
		throw new Error(`${method} ${path} -> ${res.status} ${JSON.stringify(res.body)}`);
	}
	return res.body;
}

export const post = (base: string, path: string, body: unknown, token?: string) =>
	ok(base, "POST", path, { body, token });
export const get = (base: string, path: string, token?: string) => ok(base, "GET", path, { token });
export const patch = (base: string, path: string, body: unknown, token?: string) =>
	ok(base, "PATCH", path, { body, token });
export const del = (base: string, path: string, token?: string) =>
	ok(base, "DELETE", path, { token });

/** `env.dev`'s public bootstrap bearer (wrangler.jsonc); not a secret. */
export const DEV_BOOTSTRAP_TOKEN = "teamsync-local-dev-bootstrap-token-not-secret-0";

export async function bootstrap(base: string, workspaceName = "Team", token = DEV_BOOTSTRAP_TOKEN) {
	return BootstrapResponse.parse(await post(base, "/api/auth/bootstrap", { workspaceName }, token));
}

export const device = (name: string) => ({
	name: `${name}-device`,
	platform: "macos" as const,
	vaultId: `${name}-vault`,
});

/** A new user joins through an invite token → `SessionResponse`. */
export async function acceptInvite(base: string, inviteToken: string, name: string) {
	return SessionResponse.parse(
		await post(base, "/api/auth/invite/accept", {
			token: inviteToken,
			name,
			device: device(name),
		}),
	);
}

/** A `WsTokenResponse.token` minter for a session, for `client().open`. */
export function wsTokenFor(base: string, sessionToken: string, workspaceId: string) {
	return async () =>
		WsTokenResponse.parse(await post(base, "/api/auth/ws-token", { workspaceId }, sessionToken))
			.token;
}

export async function login(base: string, name: string) {
	const session = SessionResponse.parse(
		await post(base, "/api/auth/dev-login", { name, device: device(name) }),
	);
	const workspace = session.workspaces[0];
	if (!workspace) throw new Error("no workspace");
	const token = wsTokenFor(base, session.sessionToken, workspace.id);
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
	clone_requests: number;
	clone_docs: number;
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

/** dev-login into workspace `slug` (joined or created; `role` only applies to a new membership). */
export async function loginTo(base: string, name: string, slug: string, role?: Role) {
	const session = SessionResponse.parse(
		await post(base, "/api/auth/dev-login", { name, device: device(name), workspace: slug, role }),
	);
	const workspace = session.workspaces.find((w) => w.slug === slug);
	if (!workspace) throw new Error(`no workspace ${slug}`);
	const token = wsTokenFor(base, session.sessionToken, workspace.id);
	return { session, workspaceId: workspace.id, token };
}

export const sha256Hex = (data: Uint8Array) => createHash("sha256").update(data).digest("hex");

/** `PUT /api/chunks/:sha` with a WS-JWT bearer; `fetch` sets Content-Length from the bytes. */
export async function putChunk(base: string, jwt: string, sha: string, data: Uint8Array) {
	const res = await fetch(`${base}/api/chunks/${sha}`, {
		method: "PUT",
		headers: { authorization: `Bearer ${jwt}`, "content-type": "application/octet-stream" },
		body: data as Uint8Array<ArrayBuffer>,
	});
	const text = await res.text();
	return { status: res.status, body: text ? (JSON.parse(text) as unknown) : null };
}

export async function getChunk(base: string, jwt: string, sha: string) {
	const res = await fetch(`${base}/api/chunks/${sha}`, {
		headers: { authorization: `Bearer ${jwt}` },
	});
	return {
		status: res.status,
		headers: res.headers,
		bytes: new Uint8Array(await res.arrayBuffer()),
	};
}

export interface ChunkObject {
	key: string;
	size: number;
	uploaded: number;
}

export async function debugChunks(base: string, workspaceId: string): Promise<ChunkObject[]> {
	return ((await get(base, `/api/debug/chunks?ws=${workspaceId}`)) as { objects: ChunkObject[] })
		.objects;
}
