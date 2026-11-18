/**
 * Free-tier load probe (R-7): sends exactly counted traffic to a relay so its billing counters can
 * be read per phase (locally from `/api/debug/stats`, on Cloudflare from the dashboard).
 *
 *   node scripts/load-probe.ts --url <base> [--pings N] [--frames N] [--rows N] [--connects N]
 *                              [--pause-ms 120000] [--json out.json]
 *
 * It uses a raw `ws` client with hand-built Hocuspocus frames, never the provider, so every
 * inbound frame is known. Every phase opens its own socket(s); its Auth frame counts:
 * - pings:    N text "ping" frames, answered by the relay's auto-response (never reach the DO code).
 * - frames:   N awareness frames (no rows written).
 * - rows:     N one-character updates, 1 row each, plus 1 `doc_clients` row for the probe's single
 *             Yjs client on first sight (N < 500, on a fresh doc, so no compaction).
 * - connects: N connect + Auth + close cycles.
 * Phases are separated by `--pause-ms` (default 2 min) so their analytics windows do not overlap.
 * The relay env must allow dev login (`dev` locally, `probe` on Cloudflare).
 */
import { writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import {
	docName,
	KEEPALIVE_PING,
	KEEPALIVE_PONG,
	SessionResponse,
	WS_PATH,
	WsTokenResponse,
} from "@teamsync/shared";
import * as decoding from "lib0/decoding";
import * as encoding from "lib0/encoding";
import { WebSocket } from "ws";
import * as Y from "yjs";
import { AuthMessageType, encode, encodeAwareness, MessageType } from "../src/protocol.ts";

/** The relay compacts a doc's tail at 500 rows; compaction writes and deletes extra rows. */
const COMPACT_AFTER_ROWS = 500;
const REPLY_TIMEOUT_MS = 30_000;

export interface ProbeOptions {
	url: string;
	pings?: number;
	frames?: number;
	rows?: number;
	connects?: number;
	pauseMs?: number;
	log?: (line: string) => void;
}

/** What the probe sent in one phase. */
export interface Sent {
	/** WebSocket upgrades (each is one Worker request and one DO request). */
	upgrades: number;
	/** Binary frames, Auth included; each reaches `webSocketMessage`. */
	binaryFrames: number;
	/** Text pings answered by `setWebSocketAutoResponse`. */
	pings: number;
	/** Client-initiated closes (each a `webSocketClose` event). */
	closes: number;
	/** REST calls to the Worker (ws-token), each also one AccountsDO request. */
	restCalls: number;
}

export interface Expected {
	/** Relay DO requests if every inbound message, ping and close event bills 1:1 (worst case). */
	relayDoRequests1to1: number;
	/** ...if WS messages bill 20:1 (paid-plan rule); upgrades and close events still count 1. */
	relayDoRequests20to1: number;
	accountsDoRequests: number;
	rowsWritten: number;
	workerRequests: number;
}

export interface Measured {
	msgs_in: number;
	connects: number;
	closes: number;
	app_rows_written: number;
	wakes: number;
}

export interface PhaseResult {
	phase: "pings" | "frames" | "rows" | "connects";
	count: number;
	startUtc: string;
	endUtc: string;
	sent: Sent;
	expected: Expected;
	/** Deltas from `/api/debug/stats` (absent when the endpoint is off). */
	measured?: Measured;
}

export interface ProbeResult {
	url: string;
	workspaceId: string;
	doc: string;
	/** Each stats read is one extra Worker request and one relay DO request, outside the windows. */
	statsReads: number;
	phases: PhaseResult[];
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function authFrame(address: string, token: string): Uint8Array {
	const e = encoding.createEncoder();
	encoding.writeVarString(e, address);
	encoding.writeVarUint(e, MessageType.Auth);
	encoding.writeVarUint(e, AuthMessageType.Token);
	encoding.writeVarString(e, token);
	encoding.writeVarString(e, "probe");
	return encoding.toUint8Array(e);
}

/** Address, type and first varUint of the payload (auth subtype, SyncStatus flag, sync step). */
function header(data: Uint8Array): { address: string; type: number; first: number } | null {
	if (data.length <= 1) return null;
	const d = decoding.createDecoder(data);
	const address = decoding.readVarString(d);
	const type = decoding.readVarUint(d);
	const first = decoding.hasContent(d) ? decoding.readVarUint(d) : -1;
	return { address, type, first };
}

type Incoming = { text: string } | { binary: Uint8Array };

/** A raw socket with a "wait for the next matching message" helper. */
class ProbeSocket {
	private readonly inbox: Incoming[] = [];
	private waiter: (() => void) | null = null;
	private closed: Promise<void>;
	binaryFrames = 0;
	pings = 0;

	private readonly ws: WebSocket;

	// No parameter properties: plain `node` only strips erasable TypeScript.
	private constructor(ws: WebSocket) {
		this.ws = ws;
		ws.on("message", (data, isBinary) => {
			const buf = Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data as ArrayBuffer);
			this.inbox.push(isBinary ? { binary: new Uint8Array(buf) } : { text: buf.toString() });
			this.waiter?.();
		});
		this.closed = new Promise((r) => ws.once("close", () => r()));
	}

	static open(url: string): Promise<ProbeSocket> {
		return new Promise((resolve, reject) => {
			const ws = new WebSocket(url);
			ws.binaryType = "nodebuffer";
			const socket = new ProbeSocket(ws);
			ws.once("open", () => resolve(socket));
			ws.once("error", reject);
			ws.once("unexpected-response", (_req, res) =>
				reject(new Error(`upgrade refused: HTTP ${res.statusCode}`)),
			);
		});
	}

	sendBinary(frame: Uint8Array): void {
		this.ws.send(frame);
		this.binaryFrames += 1;
	}

	sendPing(): void {
		this.ws.send(KEEPALIVE_PING);
		this.pings += 1;
	}

	async next(match: (m: Incoming) => boolean, label: string): Promise<Incoming> {
		const deadline = Date.now() + REPLY_TIMEOUT_MS;
		for (;;) {
			const i = this.inbox.findIndex(match);
			if (i !== -1) {
				const [m] = this.inbox.splice(0, i + 1).slice(-1);
				if (m) return m;
			}
			const left = deadline - Date.now();
			if (left <= 0) throw new Error(`timed out waiting for ${label}`);
			await new Promise<void>((resolve) => {
				const t = setTimeout(resolve, left);
				this.waiter = () => {
					clearTimeout(t);
					resolve();
				};
			});
			this.waiter = null;
		}
	}

	async authenticate(address: string, token: string): Promise<void> {
		this.sendBinary(authFrame(address, token));
		const m = await this.next((m) => {
			const h = "binary" in m ? header(m.binary) : null;
			return h?.address === address && h.type === MessageType.Auth;
		}, "Auth reply");
		const h = "binary" in m ? header(m.binary) : null;
		if (h?.first !== AuthMessageType.Authenticated) throw new Error("permission denied");
	}

	async close(): Promise<void> {
		this.ws.close(1000, "probe");
		await this.closed;
	}
}

async function postJson(url: string, body: unknown, token?: string): Promise<unknown> {
	const res = await fetch(url, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			...(token ? { Authorization: `Bearer ${token}` } : {}),
		},
		body: JSON.stringify(body),
	});
	if (!res.ok) throw new Error(`${new URL(url).pathname} -> ${res.status} ${await res.text()}`);
	return res.json();
}

function expectedFor(sent: Sent, rowsWritten: number): Expected {
	const messages = sent.binaryFrames + sent.pings;
	return {
		relayDoRequests1to1: sent.upgrades + messages + sent.closes,
		relayDoRequests20to1: sent.upgrades + Math.ceil(messages / 20) + sent.closes,
		accountsDoRequests: sent.restCalls,
		rowsWritten,
		workerRequests: sent.upgrades + sent.restCalls,
	};
}

export async function runProbe(options: ProbeOptions): Promise<ProbeResult> {
	const base = options.url.replace(/\/+$/, "");
	const counts = {
		pings: options.pings ?? 0,
		frames: options.frames ?? 0,
		rows: options.rows ?? 0,
		connects: options.connects ?? 0,
	};
	if (counts.rows >= COMPACT_AFTER_ROWS) {
		throw new Error(`--rows must be < ${COMPACT_AFTER_ROWS} (compaction would add rows)`);
	}
	const pauseMs = options.pauseMs ?? 120_000;
	const log = options.log ?? (() => {});

	const session = SessionResponse.parse(
		await postJson(`${base}/api/auth/dev-login`, {
			name: "probe",
			device: { name: "load-probe", platform: "linux", vaultId: "load-probe" },
		}),
	);
	const workspaceId = session.workspaces[0]?.id;
	if (!workspaceId) throw new Error("dev-login returned no workspace");
	const wsToken = async () =>
		WsTokenResponse.parse(
			await postJson(`${base}/api/auth/ws-token`, { workspaceId }, session.sessionToken),
		).token;
	// A fresh doc per run, so the rows phase never reaches compaction on a reused deployment.
	const fileId = `probe-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
	const doc = docName({ workspaceId, kind: "md", fileId });
	const socketUrl = `${base.replace(/^http/, "ws")}${WS_PATH}?ws=${workspaceId}`;

	let statsReads = 0;
	const statsUrl = `${base}/api/debug/stats?ws=${workspaceId}`;
	const readStats = async (): Promise<Measured | null> => {
		statsReads += 1;
		const res = await fetch(statsUrl);
		if (!res.ok) return null;
		const s = (await res.json()) as Record<string, number>;
		return {
			msgs_in: s.msgs_in ?? 0,
			connects: s.connects ?? 0,
			closes: s.closes ?? 0,
			app_rows_written: s.app_rows_written ?? 0,
			wakes: s.wakes ?? 0,
		};
	};
	const delta = (a: Measured, b: Measured): Measured => ({
		msgs_in: b.msgs_in - a.msgs_in,
		connects: b.connects - a.connects,
		closes: b.closes - a.closes,
		app_rows_written: b.app_rows_written - a.app_rows_written,
		wakes: b.wakes - a.wakes,
	});

	const phases: PhaseResult[] = [];
	const run = async (
		phase: PhaseResult["phase"],
		count: number,
		rowsWritten: number,
		body: () => Promise<Omit<Sent, "restCalls">>,
	) => {
		if (count <= 0) return;
		if (phases.length > 0) {
			log(`pausing ${pauseMs} ms`);
			await sleep(pauseMs);
		}
		const before = await readStats();
		const startUtc = new Date().toISOString();
		log(`${phase}: start ${startUtc}`);
		const sent: Sent = { ...(await body()), restCalls: 1 };
		const endUtc = new Date().toISOString();
		log(`${phase}: end   ${endUtc}`);
		let measured: Measured | undefined;
		if (before) {
			// Close events are processed after the client sees the close; wait for them to land.
			const deadline = Date.now() + 10_000;
			for (;;) {
				const after = await readStats();
				if (!after) break;
				measured = delta(before, after);
				if (measured.closes >= sent.closes || Date.now() > deadline) break;
				await sleep(200);
			}
		}
		const result: PhaseResult = {
			phase,
			count,
			startUtc,
			endUtc,
			sent,
			expected: expectedFor(sent, rowsWritten),
			...(measured ? { measured } : {}),
		};
		phases.push(result);
		log(JSON.stringify(result));
	};

	await run("pings", counts.pings, 0, async () => {
		await wsToken(); // keeps every phase's REST cost identical (1 call)
		const s = await ProbeSocket.open(socketUrl);
		for (let i = 0; i < counts.pings; i++) {
			s.sendPing();
			await s.next((m) => "text" in m && m.text === KEEPALIVE_PONG, "pong");
		}
		await s.close();
		return { upgrades: 1, binaryFrames: s.binaryFrames, pings: s.pings, closes: 1 };
	});

	await run("frames", counts.frames, 0, async () => {
		const token = await wsToken();
		const s = await ProbeSocket.open(socketUrl);
		await s.authenticate(doc, token);
		const clientId = 1 + Math.floor(Math.random() * 0x7ffffffe);
		for (let clock = 1; clock <= counts.frames; clock++) {
			const update = encodeAwareness([
				{ clientId, clock, state: JSON.stringify({ probe: clock }) },
			]);
			s.sendBinary(encode.awareness(doc, update));
			// The relay echoes awareness to its sender.
			await s.next((m) => {
				const h = "binary" in m ? header(m.binary) : null;
				return h?.address === doc && h.type === MessageType.Awareness;
			}, "awareness echo");
		}
		await s.close();
		return { upgrades: 1, binaryFrames: s.binaryFrames, pings: 0, closes: 1 };
	});

	// One log row per update, plus the doc_clients row for the one Yjs client (P1-8).
	await run("rows", counts.rows, counts.rows + 1, async () => {
		const token = await wsToken();
		const s = await ProbeSocket.open(socketUrl);
		await s.authenticate(doc, token);
		const ydoc = new Y.Doc();
		const updates: Uint8Array[] = [];
		ydoc.on("update", (u: Uint8Array) => updates.push(u));
		const text = ydoc.getText("contents");
		for (let i = 0; i < counts.rows; i++) {
			text.insert(text.length, "x");
			const update = updates.shift();
			if (!update) throw new Error("no update produced");
			s.sendBinary(encode.update(doc, update));
			const ack = await s.next((m) => {
				const h = "binary" in m ? header(m.binary) : null;
				return h?.address === doc && h.type === MessageType.SyncStatus;
			}, "SyncStatus ack");
			if ("binary" in ack && header(ack.binary)?.first !== 1) throw new Error("update not saved");
		}
		await s.close();
		return { upgrades: 1, binaryFrames: s.binaryFrames, pings: 0, closes: 1 };
	});

	await run("connects", counts.connects, 0, async () => {
		const token = await wsToken();
		let binaryFrames = 0;
		for (let i = 0; i < counts.connects; i++) {
			const s = await ProbeSocket.open(socketUrl);
			await s.authenticate(doc, token);
			await s.close();
			binaryFrames += s.binaryFrames;
		}
		return { upgrades: counts.connects, binaryFrames, pings: 0, closes: counts.connects };
	});

	return { url: base, workspaceId, doc, statsReads, phases };
}

function printTable(result: ProbeResult): void {
	const rows = result.phases.map((p) => ({
		phase: p.phase,
		n: p.count,
		"window (UTC)": `${p.startUtc} .. ${p.endUtc}`,
		"DO req 1:1": p.expected.relayDoRequests1to1,
		"DO req 20:1": p.expected.relayDoRequests20to1,
		"accounts DO": p.expected.accountsDoRequests,
		"rows exp": p.expected.rowsWritten,
		"worker req": p.expected.workerRequests,
		"msgs_in exp": p.sent.binaryFrames,
		"msgs_in got": p.measured?.msgs_in ?? "-",
		"rows got": p.measured?.app_rows_written ?? "-",
		"connects got": p.measured?.connects ?? "-",
		"closes got": p.measured?.closes ?? "-",
	}));
	console.table(rows);
	console.log(
		`workspace ${result.workspaceId}, doc ${result.doc}; ${result.statsReads} stats reads ` +
			"(each 1 Worker + 1 relay DO request) happened outside the phase windows.",
	);
}

function parseArgs(argv: string[]): ProbeOptions & { json?: string } {
	const out: ProbeOptions & { json?: string } = { url: "" };
	const numeric = { "--pings": "pings", "--frames": "frames", "--rows": "rows" } as const;
	for (let i = 0; i < argv.length; i++) {
		const flag = argv[i];
		const value = argv[i + 1];
		if (value === undefined) throw new Error(`${flag} needs a value`);
		i += 1;
		if (flag === "--url") out.url = value;
		else if (flag === "--json") out.json = value;
		else if (flag === "--connects") out.connects = Number(value);
		else if (flag === "--pause-ms") out.pauseMs = Number(value);
		else if (flag && flag in numeric) out[numeric[flag as keyof typeof numeric]] = Number(value);
		else throw new Error(`unknown flag ${flag}`);
	}
	if (!out.url) throw new Error("--url is required");
	return out;
}

async function main(): Promise<void> {
	const { json, ...options } = parseArgs(process.argv.slice(2));
	const result = await runProbe({ ...options, log: (line) => console.error(line) });
	printTable(result);
	if (json) writeFileSync(json, `${JSON.stringify(result, null, "\t")}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	main().catch((err) => {
		console.error(err instanceof Error ? err.message : err);
		process.exit(1);
	});
}
