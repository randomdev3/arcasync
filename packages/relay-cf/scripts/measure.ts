/**
 * G4: measures relay traffic under `wrangler dev` with real providers.
 *
 *   node scripts/measure.ts [idleSeconds=300] > measurements.json
 *
 * Every scenario gets its own relay (own port and state dir); stats are reset once the clients
 * are connected and synced, so the numbers cover only the measured phase. `wakes` includes the
 * final stats read (which wakes a hibernated object itself).
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { docName } from "@teamsync/shared";
import {
	type ClientOptions,
	client,
	login,
	type RelayStats,
	sleep,
	stats,
} from "../test/helpers.ts";
import { startRelayDev } from "./dev-server.mjs";

const IDLE_S = Number(process.argv[2] ?? 300);

type Session = Awaited<ReturnType<typeof login>>;
interface Result {
	scenario: string;
	seconds: number;
	edits?: number;
	reconnects?: number;
	stats: RelayStats;
}

// Parallel `wrangler dev` boots race each other; start relays one at a time.
let starting: Promise<unknown> = Promise.resolve();

async function scenario(
	name: string,
	port: number,
	options: ClientOptions,
	run: (ctx: {
		docs: Array<Awaited<ReturnType<ReturnType<typeof client>["open"]>>>;
		reset: () => Promise<void>;
	}) => Promise<{ edits?: number }>,
): Promise<Result> {
	const dir = mkdtempSync(join(tmpdir(), "relay-g4-"));
	const start = starting.then(() => startRelayDev({ port, persistTo: dir }));
	starting = start.catch(() => undefined);
	const relay = await start;
	const clients: Array<ReturnType<typeof client>> = [];
	try {
		const sessions: Session[] = [await login(relay.url, "alice"), await login(relay.url, "bob")];
		const ws = sessions[0]?.workspaceId ?? "";
		const name0 = docName({ workspaceId: ws, kind: "index" });
		const docs = [];
		for (const s of sessions) {
			const c = client(relay.url, ws, options);
			clients.push(c);
			docs.push(await c.open(name0, s.token));
		}
		let t0 = Date.now();
		const reset = async () => {
			await fetch(`${relay.url}/api/debug/reset?ws=${ws}`, { method: "POST" });
			t0 = Date.now();
		};
		await reset();
		const extra = await run({ docs, reset });
		const seconds = (Date.now() - t0) / 1000;
		const reconnects = clients.reduce((n, c) => n + c.opens - 1, 0);
		return { scenario: name, seconds, reconnects, ...extra, stats: await stats(relay.url, ws) };
	} finally {
		for (const c of clients) c.destroy();
		await relay.stop();
		rmSync(dir, { recursive: true, force: true });
	}
}

async function typing(
	docs: Array<Awaited<ReturnType<ReturnType<typeof client>["open"]>>>,
	edits: number,
	intervalMs: number,
	cursor: boolean,
) {
	for (let i = 0; i < edits; i++) {
		const d = docs[i % docs.length];
		if (!d) continue;
		const text = d.document.getText("body");
		text.insert(text.length, "x");
		if (cursor)
			d.awareness?.setLocalStateField("cursor", { anchor: text.length, head: text.length });
		await sleep(intervalMs);
	}
	await sleep(1500);
	return { edits };
}

const settled = await Promise.allSettled([
	// (a1) today's plugin: the counter doc has no awareness, so idle sockets receive nothing.
	scenario("a1-idle-no-awareness", 8801, {}, async () => {
		await sleep(IDLE_S * 1000);
		return {};
	}),
	// (a2) a doc with presence (index presence / open editor): y-protocols renews every 15 s.
	scenario("a2-idle-awareness", 8802, { awareness: true }, async ({ docs }) => {
		for (const d of docs) d.awareness?.setLocalStateField("user", { name: "x" });
		await sleep(IDLE_S * 1000);
		return {};
	}),
	// (b1) 200 edits, 2 clients alternating, ~10 keystrokes/s, no awareness.
	scenario("b1-typing-200", 8803, {}, async ({ docs }) => typing(docs, 200, 100, false)),
	// (b2) same with a cursor awareness update per keystroke (what y-codemirror does).
	scenario("b2-typing-200-cursor", 8804, { awareness: true }, async ({ docs }) =>
		typing(docs, 200, 100, true),
	),
	// (c) compaction cost: 1,200 edits on one doc (default threshold: 500 tail rows).
	scenario("c-typing-1200-compaction", 8805, {}, async ({ docs }) => typing(docs, 1200, 5, false)),
]);

const results = settled.map((r) =>
	r.status === "fulfilled" ? r.value : { error: String(r.reason) },
);
console.log(JSON.stringify(results, null, "\t"));
process.exit(settled.every((r) => r.status === "fulfilled") ? 0 : 1);
