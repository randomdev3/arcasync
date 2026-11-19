/**
 * One hibernating Durable Object per workspace that speaks the Hocuspocus 4.7 protocol to
 * `HocuspocusProviderWebsocket` clients (one multiplexed socket per client, many documents).
 *
 * Nothing needed for correctness lives only in memory: per-socket auth state is the socket
 * attachment, document state is SQLite (`DocStore`), and peers are found by scanning
 * `ctx.getWebSockets()`. In-memory maps are caches (awareness, merged doc state) or
 * short-lived ordering state (the per-socket promise chain, frames that precede their Auth),
 * plus the `revocations` table loaded once per wake. No timers or alarms, so the object can
 * hibernate between messages.
 */

import { DurableObject } from "cloudflare:workers";
import {
	CLOSE_MEMBERSHIP_CHANGED,
	CloneRequest,
	docName,
	KEEPALIVE_PING,
	KEEPALIVE_PONG,
	parseDocName,
} from "@teamsync/shared";
import { CloneRateLimiter, cloneDocs } from "./clone";
import type { Env } from "./env";
import { errorBody } from "./errors";
import { FILES_TABLE, listFiles, projectFiles } from "./files";
import { verifyWsToken, type WsClaims } from "./jwt";
import {
	type AwarenessEntry,
	awarenessRemoval,
	decodeAwareness,
	documentNameOf,
	encode,
	encodeAwareness,
	type Frame,
	isEmptyUpdate,
	parseFrame,
	SyncStep,
} from "./protocol";
import { type DocDebug, DocStore } from "./store";
import { bearerClaims } from "./wsAuth";

interface DocAuth {
	ro: boolean;
	/** Awareness client ids this socket introduced on the doc, with their last clock. */
	aw: Record<string, number>;
}

/** Serialized onto each socket; must stay well under the 16 KiB attachment limit. */
interface Attachment {
	id: string;
	ws: string;
	/** The user (JWT `sub`) of the first successful Auth; every later Auth must match it. */
	uid: string | null;
	/** Keyed by frame address (the document name unless the provider uses sessionAwareness). */
	docs: Record<string, DocAuth>;
}

interface Peer {
	ws: WebSocket;
	att: Attachment;
	address: string;
	auth: DocAuth;
}

const RESET = { code: 4205, reason: "Reset Connection" };
/** The user's membership or role changed: re-mint a token (new role) or learn of the removal. */
const MEMBERSHIP_CHANGED = { code: CLOSE_MEMBERSHIP_CHANGED, reason: "membership-changed" };
/** A socket published awareness claiming another user's identity. */
const AWARENESS_IDENTITY = { code: 4403, reason: "awareness-identity" };
const MAX_QUEUED_FRAMES = 1000;
const MAX_QUEUED_BYTES = 5 * 1024 * 1024;
/** Assumed idle time before the platform hibernates the object (for the awake-time estimate). */
const IDLE_BEFORE_HIBERNATION_MS = 10_000;

interface Counters {
	msgs_in: number;
	msgs_out: number;
	connects: number;
	closes: number;
	clone_requests: number;
	clone_docs: number;
}

const ZERO: Counters = {
	msgs_in: 0,
	msgs_out: 0,
	connects: 0,
	closes: 0,
	clone_requests: 0,
	clone_docs: 0,
};

/** `GET /api/workspaces/:id/files` and `POST /api/workspaces/:id/docs`, forwarded by the worker. */
const REST_PATH = /^\/api\/workspaces\/([A-Za-z0-9_-]{1,64})\/(files|docs)$/;

/** Dev-only counters for the G4 measurements, kept in one SQLite row (its writes are excluded). */
class Stats {
	private pending: Counters = { ...ZERO };
	private flushedRows = 0;
	private flushedCompactions = 0;
	/** Rows written outside the store (the `files` projection). */
	private extraRows = 0;

	constructor(
		private readonly sql: SqlStorage,
		private readonly store: DocStore,
	) {
		sql.exec(`CREATE TABLE IF NOT EXISTS relay_stats (
			id INTEGER PRIMARY KEY CHECK (id = 1), wakes INTEGER NOT NULL DEFAULT 0,
			msgs_in INTEGER NOT NULL DEFAULT 0, msgs_out INTEGER NOT NULL DEFAULT 0,
			connects INTEGER NOT NULL DEFAULT 0, closes INTEGER NOT NULL DEFAULT 0,
			app_rows_written INTEGER NOT NULL DEFAULT 0, compactions INTEGER NOT NULL DEFAULT 0,
			awake_ms_est INTEGER NOT NULL DEFAULT 0, last_at INTEGER NOT NULL DEFAULT 0)`);
		for (const column of ["clone_requests", "clone_docs"]) {
			try {
				sql.exec(`ALTER TABLE relay_stats ADD COLUMN ${column} INTEGER NOT NULL DEFAULT 0`);
			} catch (err) {
				if (!String(err).includes("duplicate column")) throw err;
			}
		}
		sql.exec("INSERT INTO relay_stats (id) VALUES (1) ON CONFLICT DO NOTHING");
		sql.exec("UPDATE relay_stats SET wakes = wakes + 1");
	}

	count(key: keyof Counters, n = 1): void {
		this.pending[key] += n;
	}

	addRows(n: number): void {
		this.extraRows += n;
	}

	flush(): void {
		const now = Date.now();
		const p = this.pending;
		const rows = this.store.rowsWritten - this.flushedRows + this.extraRows;
		const compactions = this.store.compactions - this.flushedCompactions;
		this.sql.exec(
			`UPDATE relay_stats SET msgs_in = msgs_in + ?, msgs_out = msgs_out + ?,
			 connects = connects + ?, closes = closes + ?, app_rows_written = app_rows_written + ?,
			 compactions = compactions + ?, clone_requests = clone_requests + ?,
			 clone_docs = clone_docs + ?,
			 awake_ms_est = awake_ms_est + CASE WHEN last_at = 0 THEN 0 ELSE MIN(? - last_at, ?) END,
			 last_at = ?`,
			p.msgs_in,
			p.msgs_out,
			p.connects,
			p.closes,
			rows,
			compactions,
			p.clone_requests,
			p.clone_docs,
			now,
			IDLE_BEFORE_HIBERNATION_MS,
			now,
		);
		this.pending = { ...ZERO };
		this.flushedRows = this.store.rowsWritten;
		this.extraRows = 0;
		this.flushedCompactions += compactions;
	}

	read(): Record<string, unknown> {
		return this.sql.exec("SELECT * FROM relay_stats WHERE id = 1").one();
	}

	reset(): void {
		this.sql.exec(`UPDATE relay_stats SET wakes = 0, msgs_in = 0, msgs_out = 0, connects = 0,
			closes = 0, app_rows_written = 0, compactions = 0, awake_ms_est = 0, last_at = 0,
			clone_requests = 0, clone_docs = 0`);
	}
}

export class WorkspaceRelay extends DurableObject<Env> {
	private readonly store: DocStore;
	private readonly stats: Stats | null;
	/** Serializes frame handling per socket (Auth verification is async; SyncStep1 follows it). */
	private readonly chains = new Map<string, Promise<void>>();
	/** Frames that arrived for a document before its Auth succeeded, per socket and address. */
	private readonly queued = new Map<string, Map<string, Uint8Array[]>>();
	/** docName → socket id → awareness entries that socket owns (cache; rebuilt via QueryAwareness). */
	private readonly awareness = new Map<string, Map<string, Map<number, AwarenessEntry>>>();
	/** userId → last revocation (ms); loaded from `revocations` on the first Auth of a wake. */
	private revoked: Map<string, number> | null = null;
	private readonly cloneLimiter = new CloneRateLimiter();

	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
		ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair(KEEPALIVE_PING, KEEPALIVE_PONG));
		this.store = new DocStore(ctx.storage.sql, (fn) => ctx.storage.transactionSync(fn));
		this.stats = env.TEAMSYNC_DEBUG_STATS === "1" ? new Stats(ctx.storage.sql, this.store) : null;
		ctx.storage.sql.exec(
			"CREATE TABLE IF NOT EXISTS revocations (user_id TEXT PRIMARY KEY, at INTEGER NOT NULL)",
		);
		ctx.storage.sql.exec(FILES_TABLE);
	}

	/** D5: a token issued at or before the user's last revocation second is refused. */
	private isRevoked(claims: WsClaims): boolean {
		const revokedAt = this.revocations().get(claims.sub);
		return revokedAt !== undefined && claims.iat <= Math.floor(revokedAt / 1000);
	}

	private revocations(): Map<string, number> {
		if (!this.revoked) {
			this.revoked = new Map(
				this.ctx.storage.sql
					.exec<{ user_id: string; at: number }>("SELECT user_id, at FROM revocations")
					.toArray()
					.map((r) => [r.user_id, r.at]),
			);
		}
		return this.revoked;
	}

	/**
	 * RPC from AccountsDO after a membership or role change (D5): records the revocation, so
	 * tokens issued up to this second are refused, and closes the user's sockets with 4401.
	 */
	async revoke(userId: string): Promise<{ closed: number }> {
		const at = Date.now();
		this.ctx.storage.sql.exec(
			`INSERT INTO revocations (user_id, at) VALUES (?, ?)
			 ON CONFLICT (user_id) DO UPDATE SET at = excluded.at`,
			userId,
			at,
		);
		this.revocations().set(userId, at);
		let closed = 0;
		for (const ws of this.ctx.getWebSockets()) {
			const att = this.attachment(ws);
			if (att?.uid !== userId) continue;
			for (const address of Object.keys(att.docs)) this.dropDoc(ws, att, address, true);
			this.safeClose(ws, MEMBERSHIP_CHANGED.code, MEMBERSHIP_CHANGED.reason);
			closed += 1;
		}
		return { closed };
	}

	async fetch(request: Request): Promise<Response> {
		if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") return this.rest(request);
		const workspaceId = new URL(request.url).searchParams.get("ws");
		if (!workspaceId) return new Response("Missing ?ws=", { status: 400 });
		const pair = new WebSocketPair();
		const [client, server] = [pair[0], pair[1]];
		this.ctx.acceptWebSocket(server);
		const att: Attachment = { id: crypto.randomUUID(), ws: workspaceId, uid: null, docs: {} };
		server.serializeAttachment(att);
		this.stats?.count("connects");
		this.stats?.flush();
		return new Response(null, { status: 101, webSocket: client });
	}

	async webSocketMessage(ws: WebSocket, message: ArrayBuffer | string): Promise<void> {
		this.stats?.count("msgs_in");
		if (typeof message === "string") {
			this.stats?.flush();
			return;
		}
		const data = new Uint8Array(message);
		const id = this.attachment(ws)?.id;
		if (!id) return;
		const run = (this.chains.get(id) ?? Promise.resolve())
			.then(() => this.handle(ws, data))
			.catch((err) => {
				console.error("relay: frame handling failed", err);
				this.safeClose(ws, RESET.code, RESET.reason);
			})
			.finally(() => this.stats?.flush());
		this.chains.set(id, run);
		await run;
		if (this.chains.get(id) === run) this.chains.delete(id);
	}

	async webSocketClose(ws: WebSocket, code: number, reason: string): Promise<void> {
		this.disconnect(ws);
		this.safeClose(ws, code === 1005 || code === 1006 ? 1000 : code, reason);
	}

	async webSocketError(ws: WebSocket): Promise<void> {
		this.disconnect(ws);
	}

	private disconnect(ws: WebSocket): void {
		const att = this.attachment(ws);
		this.stats?.count("closes");
		if (att) {
			for (const address of Object.keys(att.docs)) this.dropDoc(ws, att, address, false);
			this.chains.delete(att.id);
			this.queued.delete(att.id);
		}
		this.stats?.flush();
	}

	private attachment(ws: WebSocket): Attachment | null {
		return (ws.deserializeAttachment() as Attachment | null) ?? null;
	}

	private save(ws: WebSocket, att: Attachment): void {
		try {
			ws.serializeAttachment(att);
		} catch (err) {
			console.warn("relay: could not serialize attachment", err);
		}
	}

	private send(ws: WebSocket, data: Uint8Array): void {
		try {
			ws.send(data);
			this.stats?.count("msgs_out");
		} catch {
			// Socket already closing; its close handler cleans up.
		}
	}

	private safeClose(ws: WebSocket, code: number, reason: string): void {
		try {
			ws.close(code, reason);
		} catch {
			// Already closed.
		}
	}

	/** Every other socket that has authenticated `doc`. */
	private *peers(doc: string, exceptId?: string): Generator<Peer> {
		for (const ws of this.ctx.getWebSockets()) {
			const att = this.attachment(ws);
			if (!att || att.id === exceptId) continue;
			for (const [address, auth] of Object.entries(att.docs)) {
				if (documentNameOf(address) === doc) yield { ws, att, address, auth };
			}
		}
	}

	private async handle(ws: WebSocket, data: Uint8Array): Promise<void> {
		let frame: Frame;
		try {
			frame = parseFrame(data);
		} catch (err) {
			console.warn("relay: malformed frame", err);
			this.safeClose(ws, RESET.code, RESET.reason);
			return;
		}
		if (frame.kind === "ping" || frame.kind === "pong") return;
		if (frame.kind === "auth") {
			await this.authenticate(ws, frame.address, frame.token);
			return;
		}
		const att = this.attachment(ws);
		if (!att) return;
		if (!att.docs[frame.address]) {
			this.enqueue(ws, att, frame.address, data);
			return;
		}
		this.dispatch(ws, att, frame);
	}

	/** Holds frames that precede their document's Auth, bounded like Hocuspocus does. */
	private enqueue(ws: WebSocket, att: Attachment, address: string, data: Uint8Array): void {
		let perSocket = this.queued.get(att.id);
		if (!perSocket) {
			perSocket = new Map();
			this.queued.set(att.id, perSocket);
		}
		let frames = 0;
		let bytes = 0;
		for (const list of perSocket.values()) {
			frames += list.length;
			for (const f of list) bytes += f.length;
		}
		if (frames + 1 > MAX_QUEUED_FRAMES || bytes + data.length > MAX_QUEUED_BYTES) {
			this.safeClose(ws, RESET.code, RESET.reason);
			return;
		}
		const list = perSocket.get(address) ?? [];
		list.push(data);
		perSocket.set(address, list);
	}

	private takeQueued(att: Attachment, address: string): Uint8Array[] {
		const perSocket = this.queued.get(att.id);
		const list = perSocket?.get(address) ?? [];
		perSocket?.delete(address);
		return list;
	}

	private async authenticate(ws: WebSocket, address: string, token: string): Promise<void> {
		const doc = documentNameOf(address);
		const ref = parseDocName(doc);
		let readOnly: boolean | null = null;
		let uid: string | null = null;
		try {
			const claims = await verifyWsToken(token, this.env.TEAMSYNC_SECRET);
			const att = this.attachment(ws);
			if (
				ref &&
				att &&
				!this.isRevoked(claims) &&
				claims.ws === ref.workspaceId &&
				claims.ws === att.ws
			) {
				readOnly = claims.role === "viewer";
				uid = claims.sub;
			}
		} catch {
			readOnly = null;
		}

		// Re-read after the await: the attachment is the source of truth.
		const att = this.attachment(ws);
		if (!att) return;
		// One socket is one user: a token for someone else is refused for that doc.
		if (att.uid !== null && att.uid !== uid) readOnly = null;
		if (readOnly === null || uid === null) {
			this.send(ws, encode.permissionDenied(address, "permission-denied"));
			if (att.docs[address]) this.dropDoc(ws, att, address, true);
			this.takeQueued(att, address);
			return;
		}
		att.uid = uid;
		att.docs[address] = { ro: readOnly, aw: att.docs[address]?.aw ?? {} };
		this.save(ws, att);
		this.send(ws, encode.authenticated(address, readOnly));
		this.sendPresence(ws, att, address);
		for (const data of this.takeQueued(att, address)) {
			const queuedFrame = parseFrame(data);
			if (
				queuedFrame.kind !== "auth" &&
				queuedFrame.kind !== "ping" &&
				queuedFrame.kind !== "pong"
			) {
				this.dispatch(ws, att, queuedFrame);
			}
		}
	}

	private dispatch(
		ws: WebSocket,
		att: Attachment,
		frame: Exclude<Frame, { kind: "auth" | "ping" | "pong" }>,
	) {
		const { address } = frame;
		const auth = att.docs[address];
		if (!auth) return;
		const doc = documentNameOf(address);
		switch (frame.kind) {
			case "sync":
				this.handleSync(ws, att, address, auth, frame.step, frame.payload);
				return;
			case "awareness":
				this.handleAwareness(ws, att, address, auth, frame.update);
				return;
			case "queryAwareness":
				this.sendPresence(ws, att, address, true);
				return;
			case "stateless":
				for (const peer of this.peers(doc, att.id)) {
					this.send(peer.ws, encode.stateless(peer.address, frame.payload));
				}
				return;
			case "close":
				this.dropDoc(ws, att, address, true);
				return;
			default:
				return;
		}
	}

	private handleSync(
		ws: WebSocket,
		att: Attachment,
		address: string,
		auth: DocAuth,
		step: SyncStep,
		payload: Uint8Array,
	): void {
		const doc = documentNameOf(address);
		if (step === SyncStep.Step1) {
			// Same order as Hocuspocus' Connection path: our SyncStep1 (so the client sends what we
			// lack, e.g. offline edits), then the SyncStep2 diff. Both as Sync(0), never SyncReply(4).
			const { stateVector, diff } = this.store.syncReply(doc, payload);
			this.send(ws, encode.syncStep1(address, stateVector));
			this.send(ws, encode.syncStep2(address, diff));
			return;
		}
		const empty = isEmptyUpdate(payload);
		if (auth.ro) {
			// Viewers: nothing is stored or relayed; only a no-op SyncStep2 counts as "saved".
			this.send(ws, encode.syncStatus(address, step === SyncStep.Step2 && empty));
			return;
		}
		if (!empty) {
			if (att.uid === null) return;
			try {
				this.store.append(doc, payload, att.uid);
			} catch (err) {
				console.warn("relay: rejected undecodable update", err);
				this.send(ws, encode.syncStatus(address, false));
				return;
			}
			for (const peer of this.peers(doc, att.id)) {
				this.send(peer.ws, encode.update(peer.address, payload));
			}
		}
		// The SQL write above is durable before this ack leaves (DO output gate).
		this.send(ws, encode.syncStatus(address, true));
	}

	private handleAwareness(
		ws: WebSocket,
		att: Attachment,
		address: string,
		auth: DocAuth,
		update: Uint8Array,
	): void {
		const doc = documentNameOf(address);
		let entries: AwarenessEntry[];
		try {
			entries = decodeAwareness(update);
		} catch {
			return;
		}
		// A provider's own renewals carry exactly its own client; replies to QueryAwareness carry
		// everyone it knows. So a single non-null entry claims ownership.
		const only = entries.length === 1 ? entries[0] : undefined;
		const claimed =
			only && only.state !== "null" && !(String(only.clientId) in auth.aw) ? only : undefined;
		const owned = entries.filter((e) => e === claimed || String(e.clientId) in auth.aw);
		if (owned.some((e) => this.impersonates(att, e))) {
			for (const other of Object.keys(att.docs)) this.dropDoc(ws, att, other, true);
			this.safeClose(ws, AWARENESS_IDENTITY.code, AWARENESS_IDENTITY.reason);
			return;
		}
		if (claimed) auth.aw[String(claimed.clientId)] = claimed.clock;
		const cache = this.awarenessCache(doc, att.id);
		for (const entry of entries) {
			const key = String(entry.clientId);
			if (!(key in auth.aw)) continue;
			if (entry.state === "null") {
				delete auth.aw[key];
				cache.delete(entry.clientId);
			} else {
				auth.aw[key] = entry.clock;
				cache.set(entry.clientId, entry);
			}
		}
		this.save(ws, att);
		// Hocuspocus echoes awareness to every connection, the sender included; that echo is
		// what keeps a lone client's socket from hitting its 30 s receive timeout.
		this.send(ws, encode.awareness(address, update));
		for (const peer of this.peers(doc, att.id)) {
			this.send(peer.ws, encode.awareness(peer.address, update));
		}
	}

	/** True when an owned awareness state names a `user.id` other than the socket's user. */
	private impersonates(att: Attachment, entry: AwarenessEntry): boolean {
		if (entry.state === "null") return false;
		let state: unknown;
		try {
			state = JSON.parse(entry.state);
		} catch {
			return false;
		}
		const user = (state as { user?: { id?: unknown } } | null)?.user;
		return user?.id !== undefined && user.id !== att.uid;
	}

	private awarenessCache(doc: string, socketId: string): Map<number, AwarenessEntry> {
		let perDoc = this.awareness.get(doc);
		if (!perDoc) {
			perDoc = new Map();
			this.awareness.set(doc, perDoc);
		}
		let cache = perDoc.get(socketId);
		if (!cache) {
			cache = new Map();
			perDoc.set(socketId, cache);
		}
		return cache;
	}

	/**
	 * Gives a (re)joining socket the presence of everyone else on the doc: cached entries are sent
	 * directly; peers that own clients but have no cached entry (e.g. after hibernation) get a
	 * QueryAwareness, and their reply is relayed like any awareness update.
	 */
	private sendPresence(ws: WebSocket, att: Attachment, address: string, includeSelf = false): void {
		const doc = documentNameOf(address);
		const entries: AwarenessEntry[] = [];
		const perDoc = this.awareness.get(doc);
		if (includeSelf) entries.push(...(perDoc?.get(att.id)?.values() ?? []));
		for (const peer of this.peers(doc, att.id)) {
			const cached = perDoc?.get(peer.att.id);
			if (cached && cached.size > 0) entries.push(...cached.values());
			else if (Object.keys(peer.auth.aw).length > 0) {
				this.send(peer.ws, encode.queryAwareness(peer.address));
			}
		}
		if (entries.length > 0) this.send(ws, encode.awareness(address, encodeAwareness(entries)));
	}

	/** Detaches one doc from a socket and tells the remaining peers its clients left. */
	private dropDoc(ws: WebSocket, att: Attachment, address: string, persist: boolean): void {
		const auth = att.docs[address];
		if (!auth) return;
		delete att.docs[address];
		if (persist) this.save(ws, att);
		const doc = documentNameOf(address);
		this.awareness.get(doc)?.delete(att.id);
		if (Object.keys(auth.aw).length === 0) return;
		const removal = awarenessRemoval(auth.aw);
		for (const peer of this.peers(doc, att.id)) {
			this.send(peer.ws, encode.awareness(peer.address, removal));
		}
	}

	// --- REST: files listing and bulk clone (D6: the WS-JWT is verified here, not in the Worker) ---

	private async rest(request: Request): Promise<Response> {
		const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
			Response.json(body, { status, headers });
		const match = REST_PATH.exec(new URL(request.url).pathname);
		const op = match?.[2];
		const workspaceId = match?.[1];
		if (
			!workspaceId ||
			!(
				(op === "files" && request.method === "GET") ||
				(op === "docs" && request.method === "POST")
			)
		) {
			return json(errorBody("not_found", "Not found"), 404);
		}
		const claims = await bearerClaims(
			request.headers.get("authorization"),
			this.env.TEAMSYNC_SECRET,
		);
		if (!claims || claims.ws !== workspaceId || this.isRevoked(claims)) {
			return json(errorBody("unauthorized", "Missing or invalid workspace token"), 401);
		}
		if (op === "files") {
			this.projectFiles(workspaceId);
			this.stats?.flush();
			return json({ files: listFiles(this.ctx.storage.sql) });
		}
		const retryAfter = this.cloneLimiter.take(claims.sub);
		if (retryAfter > 0) {
			return json(errorBody("rate_limited", "Too many clone requests"), 429, {
				"retry-after": String(retryAfter),
			});
		}
		let raw: unknown;
		try {
			raw = await request.json();
		} catch {
			raw = undefined;
		}
		const body = CloneRequest.safeParse(raw);
		if (!body.success) return json(errorBody("bad_request", "Invalid request"), 400);
		const result = cloneDocs(this.store, workspaceId, body.data);
		if (!result.ok) return json(errorBody("bad_request", result.message), 400);
		this.stats?.count("clone_requests");
		this.stats?.count("clone_docs", result.docs);
		this.stats?.flush();
		return new Response(result.body, {
			headers: { "content-type": "application/octet-stream" },
		});
	}

	/** D11: brings `files` in line with the index doc; writes only the differing rows. */
	private projectFiles(workspaceId: string): void {
		const index = this.store.state(docName({ workspaceId, kind: "index" }));
		const { rowsWritten } = projectFiles(
			this.ctx.storage.sql,
			(fn) => this.ctx.storage.transactionSync(fn),
			index,
		);
		this.stats?.addRows(rowsWritten);
	}

	// --- dev-only instrumentation (worker gates these on TEAMSYNC_DEBUG_STATS) ---

	async debugStats(): Promise<Record<string, unknown>> {
		const docs = this.ctx.storage.sql
			.exec<{ doc: string; rows: number }>(
				"SELECT doc, COUNT(*) AS rows FROM doc_updates GROUP BY doc",
			)
			.toArray();
		const parts = this.ctx.storage.sql
			.exec<{ doc: string; parts: number; bytes: number }>(
				"SELECT doc, COUNT(*) AS parts, SUM(LENGTH(data)) AS bytes FROM doc_state GROUP BY doc",
			)
			.toArray();
		return {
			...(this.stats?.read() ?? {}),
			sockets: this.ctx.getWebSockets().length,
			tailRows: docs,
			stateParts: parts,
			databaseSize: this.ctx.storage.sql.databaseSize,
		};
	}

	async debugDoc(doc: string): Promise<DocDebug> {
		return this.store.debug(doc);
	}

	async debugReset(): Promise<{ ok: true }> {
		this.stats?.reset();
		return { ok: true };
	}
}
