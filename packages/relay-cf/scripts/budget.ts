/**
 * R-8 free-tier budget gate.
 *
 *   node scripts/budget.ts [--url <base>] [--port 22500] [--json units.json] [--baseline units.json]
 *                          [--live] [--live-minutes 10] [--live-clients 10]
 *
 * Measures the unit costs with real providers and the plugin's v2 options (flushDelay, text
 * keepalive, presence policy, cursor awareness) from `/api/debug/stats` deltas, against a fresh
 * `wrangler dev --env dev` or `--url`. Multiplies them by the activity in `budget-model.ts`, prints
 * scenarios A, B and C, and exits 1 when any free cap exceeds 50% in any of them. The P2 units it
 * measures are the bulk-clone page, the `files` projection rows and the AccountsDO calls per
 * device-code login; the ones it cannot measure come from `ESTIMATED_UNITS` (lane evidence and a
 * code audit), and the rest from the analytic `PLAN_UNITS`. `--baseline` also fails when a
 * unit differs by more than 25% from a saved run (R-9: deployment vs local). `--live` then runs
 * simulated clients against the relay and compares the measured deltas with the model.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import {
	CLONE_MAX_DOCS,
	DeviceCodeResponse,
	decodeClone,
	docName,
	type FileMeta,
	FLUSH_DELAY_MS,
	INDEX_FILES,
	KEEPALIVE_INTERVAL_MS,
	KEEPALIVE_RECONNECT_TIMEOUT_MS,
	PRESENCE_IDLE_RENEWAL_MS,
	PRESENCE_RENEWAL_MS,
} from "@arcasync/shared";
import {
	type ClientOptions,
	client,
	device,
	get,
	login,
	post,
	type RelayStats,
	resetStats,
	sleep,
	stats,
	waitFor,
} from "../test/helpers.ts";
import {
	BILLING,
	BUDGET_FRACTION,
	type Cap,
	doRequests,
	ESTIMATED_UNITS,
	FREE_CAPS,
	gate,
	PLAN_UNITS,
	TEAM,
	type Units,
} from "./budget-model.ts";
import { startRelayDev } from "./dev-server.mjs";

const { values: args } = parseArgs({
	options: {
		url: { type: "string" },
		port: { type: "string", default: "22500" },
		json: { type: "string" },
		baseline: { type: "string" },
		live: { type: "boolean", default: false },
		"live-minutes": { type: "string", default: "10" },
		"live-clients": { type: "string", default: "10" },
	},
});

/** The plugin's client options against relay-cf (ConnectionManager with server features). */
const V2: ClientOptions = {
	flushDelay: FLUSH_DELAY_MS,
	keepaliveMs: KEEPALIVE_INTERVAL_MS,
	messageReconnectTimeout: KEEPALIVE_RECONNECT_TIMEOUT_MS,
	presenceRenewalMs: PRESENCE_RENEWAL_MS,
};
/** Renewal phases run 100× faster and are rescaled (the tick and batch window scale too). */
const SCALE = 100;
const RUN = Date.now().toString(36);
const SETTLE_MS = 1500;
const KEYS = 60;

type Client = ReturnType<typeof client>;
type Session = Awaited<ReturnType<typeof login>>;

let base = "";
let ws = "";
let alice: Session;
let bob: Session;

const note = (id: string) => docName({ workspaceId: ws, kind: "md", fileId: `b${RUN}-${id}` });
const index = () => docName({ workspaceId: ws, kind: "index" });

/** Zero the counters, run `fn`, let the last batch land, return the deltas, destroy clients. */
async function phase(
	label: string,
	fn: (spawn: (o: ClientOptions) => Client) => Promise<void>,
): Promise<RelayStats> {
	const clients: Client[] = [];
	const spawn = (o: ClientOptions) => {
		const c = client(base, ws, o);
		clients.push(c);
		return c;
	};
	try {
		await fn(spawn);
		await sleep(SETTLE_MS);
		const s = await stats(base, ws);
		process.stderr.write(
			`  ${label}: msgs_in ${s.msgs_in}, rows ${s.app_rows_written}, connects ${s.connects}, closes ${s.closes}\n`,
		);
		return s;
	} finally {
		for (const c of clients) c.destroy();
		await sleep(SETTLE_MS);
	}
}

const reset = () => resetStats(base, ws);

async function typing(cursor: boolean): Promise<RelayStats> {
	return phase(`typing ${KEYS} keys at 4/s${cursor ? " + cursor" : ""}`, async (spawn) => {
		const doc = note(`typing-${cursor}`);
		const writer = await spawn({ ...V2, awareness: true }).open(doc, alice.token);
		writer.awareness?.setLocalStateField("user", { name: "alice" });
		const reader = await spawn({ ...V2 }).open(doc, bob.token);
		await sleep(SETTLE_MS);
		await reset();
		const text = writer.document.getText("body");
		for (let i = 0; i < KEYS; i++) {
			text.insert(text.length, "x");
			if (cursor) {
				writer.awareness?.setLocalStateField("cursor", { anchor: text.length, head: text.length });
			}
			await sleep(1000 / TEAM.typingKeysPerSec);
		}
		await waitFor(
			() =>
				!writer.provider.hasUnsyncedChanges &&
				reader.document.getText("body").length === text.length,
			{ label: "typing synced", timeout: 15_000 },
		);
	});
}

async function opens(focused: boolean, cycles: number): Promise<RelayStats> {
	return phase(`${cycles} ${focused ? "focused" : "background"} note opens`, async (spawn) => {
		const c = spawn({ ...V2, awareness: true });
		await c.open(index(), alice.token);
		await sleep(SETTLE_MS);
		await reset();
		for (let i = 0; i < cycles; i++) {
			const d = await c.open(note(`open-${focused}-${i}`), alice.token, { awareness: focused });
			d.awareness?.setLocalStateField("user", { name: "alice" });
			await sleep(focused ? FLUSH_DELAY_MS + 200 : 200);
			d.provider.destroy();
			await sleep(focused ? FLUSH_DELAY_MS + 200 : 200);
		}
	});
}

async function cursorMoves(moves: number): Promise<RelayStats> {
	return phase(`${moves} cursor moves`, async (spawn) => {
		const d = await spawn({ ...V2, awareness: true }).open(note("cursor"), alice.token);
		d.awareness?.setLocalStateField("user", { name: "alice" });
		await sleep(SETTLE_MS);
		await reset();
		for (let i = 0; i < moves; i++) {
			d.awareness?.setLocalStateField("cursor", { anchor: i, head: i });
			await sleep(FLUSH_DELAY_MS + 300);
		}
	});
}

/**
 * Presence renewals with `renewMs / SCALE`, rescaled to renewals per client-hour per doc. With
 * `pinger`, one more socket pings at `KEEPALIVE_INTERVAL_MS / SCALE` (counted client-side).
 */
async function renewals(renewMs: number, clients: number, seconds: number, pinger = false) {
	let pings = 0;
	const s = await phase(`renewals ${renewMs / 1000} s ÷ ${SCALE}`, async (spawn) => {
		const scaled: ClientOptions = {
			...V2,
			awareness: true,
			flushDelay: FLUSH_DELAY_MS / SCALE,
			presenceRenewalMs: renewMs / SCALE,
			presenceCheckMs: Math.min(30_000, PRESENCE_RENEWAL_MS / 4) / SCALE,
		};
		for (let i = 0; i < clients; i++) {
			const d = await spawn(scaled).open(note(`renew-${renewMs}-${i}`), alice.token);
			d.awareness?.setLocalStateField("user", { name: `u${i}` });
		}
		const p = pinger ? spawn({ ...V2, keepaliveMs: KEEPALIVE_INTERVAL_MS / SCALE }) : null;
		await p?.open(note("pinger"), bob.token);
		await sleep(SETTLE_MS);
		await reset();
		const start = p?.pings ?? 0;
		await sleep(seconds * 1000);
		pings = (p?.pings ?? 0) - start;
	});
	// The counters also run through the settle window before they are read.
	const perHour = (n: number) => (n / ((seconds + SETTLE_MS / 1000) * SCALE)) * 3600;
	return { renewalsPerHour: perHour(s.msgs_in / clients), pingsPerHour: perHour(pings) };
}

async function reconnect(): Promise<RelayStats> {
	return phase(`reconnect with ${TEAM.docsPerConnect} docs`, async (spawn) => {
		const c = spawn({ ...V2, awareness: true });
		const docs = [
			await c.open(index(), alice.token),
			await c.open(note("connect-focused"), alice.token),
			await c.open(note("connect-other"), alice.token, { awareness: false }),
		];
		for (const d of docs) d.awareness?.setLocalStateField("user", { name: "alice" });
		await sleep(SETTLE_MS);
		await reset();
		c.rawSockets.at(-1)?.close();
		await waitFor(() => c.opens === 2, { label: "reconnected" });
		await waitFor(() => docs.every((d) => d.provider.synced), { label: "re-synced" });
		await sleep(FLUSH_DELAY_MS);
	});
}

async function compaction(updates: number): Promise<RelayStats> {
	return phase(`${updates} unbatched updates (compaction)`, async (spawn) => {
		const d = await spawn({}).open(note("compaction"), alice.token);
		await reset();
		const text = d.document.getText("body");
		for (let i = 0; i < updates; i++) {
			text.insert(text.length, "x");
			if (i % 20 === 19) await sleep(5);
		}
		await waitFor(() => !d.provider.hasUnsyncedChanges, {
			label: "compaction acks",
			timeout: 60_000,
		});
	});
}

/** POST `body` with the workspace JWT as bearer; returns the raw response. */
async function bearerPost(path: string, body: unknown): Promise<Response> {
	return fetch(`${base}${path}`, {
		method: "POST",
		headers: { authorization: `Bearer ${await alice.token()}`, "content-type": "application/json" },
		body: JSON.stringify(body),
	});
}

/**
 * Bulk clone of `CLONE_MAX_DOCS` notes of `avgNoteBytes` each: docs per response, and no WS
 * messages or rows (P2-13). Stays far below the clone limiter's 10-request bucket.
 */
async function cloneDocs(): Promise<{ docsPerRequest: number; requests: number }> {
	const docs: string[] = [];
	const s = await phase(`bulk clone of ${CLONE_MAX_DOCS} notes`, async (spawn) => {
		const c = spawn({});
		for (let i = 0; i < CLONE_MAX_DOCS; i++) {
			const doc = note(`clone-${i}`);
			const { document, provider } = await c.open(doc, alice.token);
			document.getText("body").insert(0, `${i} `.padEnd(TEAM.avgNoteBytes, "c"));
			await waitFor(() => !provider.hasUnsyncedChanges, { label: `clone note ${i} acked` });
			docs.push(doc);
		}
		await sleep(SETTLE_MS);
		await reset();
		let pending = docs.map((doc) => ({ doc }));
		for (let page = 0; pending.length > 0; page++) {
			if (page >= 5) throw new Error("bulk clone did not finish in 5 requests");
			const res = await bearerPost(`/api/workspaces/${ws}/docs`, { docs: pending });
			if (!res.ok) throw new Error(`bulk clone answered ${res.status}`);
			const { remaining } = decodeClone(new Uint8Array(await res.arrayBuffer()));
			pending = remaining.map((doc) => ({ doc }));
		}
	});
	if (s.msgs_in !== 0 || s.app_rows_written !== 0) {
		throw new Error(`bulk clone cost ${s.msgs_in} messages and ${s.app_rows_written} rows`);
	}
	return { docsPerRequest: s.clone_docs / s.clone_requests, requests: s.clone_requests };
}

/** Rows one `files` listing writes: unchanged, then after `changed` index entries changed. */
async function projection(entries: number, changed: number) {
	let unchanged = -1;
	const listFiles = async () => {
		const res = await fetch(`${base}/api/workspaces/${ws}/files`, {
			headers: { authorization: `Bearer ${await alice.token()}` },
		});
		if (!res.ok) throw new Error(`files listing answered ${res.status}`);
	};
	const s = await phase(
		`files projection, ${changed} of ${entries} entries changed`,
		async (spawn) => {
			const idx = await spawn({}).open(index(), alice.token);
			const files = idx.document.getMap<FileMeta>(INDEX_FILES);
			const meta = (i: number, at: number): FileMeta => ({
				id: `b${RUN}-proj-${i}`,
				kind: "md",
				updatedBy: alice.session.user.id,
				updatedAt: at,
			});
			idx.document.transact(() => {
				for (let i = 0; i < entries; i++) files.set(`Projection/${i}.md`, meta(i, 1));
			});
			await waitFor(() => !idx.provider.hasUnsyncedChanges, { label: "index entries acked" });
			await sleep(SETTLE_MS);
			await listFiles();
			await reset();
			await listFiles();
			unchanged = (await stats(base, ws)).app_rows_written;
			idx.document.transact(() => {
				for (let i = 0; i < changed; i++) files.set(`Projection/${i}.md`, meta(i, 2));
			});
			await waitFor(() => !idx.provider.hasUnsyncedChanges, { label: "changed entries acked" });
			await sleep(SETTLE_MS);
			await reset();
			await listFiles();
		},
	);
	return { unchanged, perChanged: s.app_rows_written / changed };
}

/** AccountsDO calls for one device-code login that is approved before its first poll. */
async function deviceLogin(): Promise<number> {
	const calls = async () => ((await get(base, "/api/debug/accounts")) as { calls: number }).calls;
	const before = await calls();
	const code = DeviceCodeResponse.parse(
		await post(base, "/api/auth/device/start", { device: device(`budget-${RUN}`) }),
	);
	const sessionToken = alice.session.sessionToken;
	await get(
		base,
		`/api/auth/device/lookup?userCode=${encodeURIComponent(code.userCode)}`,
		sessionToken,
	);
	await post(
		base,
		"/api/auth/device/approve",
		{ userCode: code.userCode, approve: true },
		sessionToken,
	);
	await post(base, "/api/auth/device/poll", { deviceCode: code.deviceCode });
	const n = (await calls()) - before;
	process.stderr.write(`  device-code login: ${n} AccountsDO calls\n`);
	return n;
}

/** Units `measureUnits` measures; the rest come from `ESTIMATED_UNITS` or `PLAN_UNITS`. */
const MEASURED = new Set<keyof Units>();

async function measureUnits(): Promise<Units> {
	const plain = await typing(false);
	const withCursor = await typing(true);
	const focused = await opens(true, 5);
	const background = await opens(false, 5);
	const moves = await cursorMoves(6);
	const active = await renewals(PRESENCE_RENEWAL_MS, 2, 15);
	const idle = await renewals(PRESENCE_IDLE_RENEWAL_MS, 3, 45, true);
	const connect = await reconnect();
	if (connect.connects !== 1) throw new Error(`reconnect phase saw ${connect.connects} connects`);
	const updates = 1200;
	const compact = await compaction(updates);
	const clone = await cloneDocs();
	const files = await projection(50, 10);
	const measured = {
		updateMsgsPerKey: plain.msgs_in / KEYS,
		awarenessMsgsPerKey: Math.max(0, withCursor.msgs_in - plain.msgs_in) / KEYS,
		rowsPerKey: withCursor.app_rows_written / KEYS,
		framesPerOpen: focused.msgs_in / 5,
		framesPerBgOpen: background.msgs_in / 5,
		msgsPerAwarenessChange: moves.msgs_in / 6,
		renewalsPerHourActive: active.renewalsPerHour,
		renewalsPerHourIdle: idle.renewalsPerHour,
		pingsPerHour: idle.pingsPerHour,
		framesPerConnect: connect.msgs_in,
		compactionRowsPerLogRow: (compact.app_rows_written - updates) / updates,
		compactionInsertsPerLogRow: compact.compactions / updates,
		cloneDocsPerRequest: clone.docsPerRequest,
		projectionRowsPerChangedEntry: files.perChanged,
		projectionRowsUnchanged: files.unchanged,
		accountsCallsPerDeviceLogin: await deviceLogin(),
	} satisfies Partial<Units>;
	for (const key of Object.keys(measured) as Array<keyof Units>) MEASURED.add(key);
	return { ...PLAN_UNITS, ...ESTIMATED_UNITS, ...measured };
}

/** Simulated team against the relay: compares measured deltas with the model's prediction. */
async function live(units: Units, minutes: number, users: number): Promise<void> {
	const keysPerBurst = 20;
	const s = await phase(`live: ${users} clients × ${minutes} min`, async (spawn) => {
		const docs = [];
		for (let i = 0; i < users; i++) {
			const session = await login(base, `live-${i}`);
			const c = spawn({ ...V2, awareness: true });
			const idx = await c.open(index(), session.token);
			const doc = await c.open(note(`live-${i % 3}`), session.token);
			for (const d of [idx, doc]) d.awareness?.setLocalStateField("user", { name: `live-${i}` });
			docs.push(doc);
		}
		await sleep(SETTLE_MS);
		await reset();
		const end = Date.now() + minutes * 60_000;
		await Promise.all(
			docs.map(async (d, i) => {
				await sleep((i * 60_000) / users);
				while (Date.now() < end) {
					const text = d.document.getText("body");
					for (let k = 0; k < keysPerBurst; k++) {
						text.insert(text.length, "y");
						d.awareness?.setLocalStateField("cursor", { anchor: text.length, head: text.length });
						await sleep(1000 / TEAM.typingKeysPerSec);
					}
					await sleep(Math.max(0, Math.min(60_000 - keysPerBurst * 250, end - Date.now())));
				}
			}),
		);
	});
	const keys = users * minutes * keysPerBurst;
	const hours = minutes / 60;
	// The typed-in note renews only when typing pauses longer than renewMs; count both docs (upper bound).
	const predicted = {
		msgs_in:
			keys * (units.updateMsgsPerKey + units.awarenessMsgsPerKey) +
			users * hours * 2 * units.renewalsPerHourActive,
		// Log rows only: a short run stays below the 500-row compaction threshold per doc.
		app_rows_written: keys * units.rowsPerKey,
		connects: 0,
	};
	console.log(`\n### Live: ${users} clients × ${minutes} min, ${keysPerBurst} keys/min each\n`);
	console.log("| Delta | Measured | Model | Ratio |\n|---|---|---|---|");
	for (const [key, value] of Object.entries(predicted)) {
		const measured = s[key as keyof RelayStats] as number;
		const ratio = value === 0 ? "—" : (measured / value).toFixed(2);
		console.log(`| ${key} | ${measured} | ${Math.round(value)} | ${ratio} |`);
	}
}

const pct = (value: number, cap: Cap) => (100 * value) / FREE_CAPS[cap];
const fmt = (n: number) => Math.round(n).toLocaleString("en-US");

function report(units: Units): boolean {
	console.log("## Free-tier budget gate (R-8, P2)\n");
	console.log(
		`Billing: MSG_RATIO=${BILLING.MSG_RATIO}, PINGS_BILLED=${BILLING.PINGS_BILLED}, ` +
			`CLOSES_BILLED=${BILLING.CLOSES_BILLED}, DELETE_ROWS_BILLED=${BILLING.DELETE_ROWS_BILLED}, ` +
			`GB_S_MODEL=${BILLING.GB_S_MODEL} (${BILLING.ACTIVE_SEC_PER_REQUEST * 1000} ms per request). ` +
			`Team: ${TEAM.users} users, ${fmt(TEAM.keysPerUserDay)} keys/user/day.\n`,
	);
	console.log("| Unit | Value | Source | Plan |\n|---|---|---|---|");
	for (const key of Object.keys(units) as Array<keyof Units>) {
		const source = MEASURED.has(key)
			? "measured"
			: key in ESTIMATED_UNITS
				? "estimated (lanes, code audit)"
				: "plan (analytic)";
		const value = MEASURED.has(key) ? units[key].toFixed(3) : String(units[key]);
		console.log(`| ${key} | ${value} | ${source} | ${PLAN_UNITS[key]} |`);
	}

	const results = gate(units);
	// C's list is B's plus the extra-workspace rows.
	const list = results.find((r) => r.name === "C")?.list ?? [];
	console.log(
		"\n| Component (per day) | DO requests | Rows written | Rows read | Worker req | R2 A | R2 B |",
	);
	console.log("|---|---|---|---|---|---|---|");
	for (const c of list) {
		console.log(
			`| ${c.name} | ${fmt(doRequests(c))} | ${fmt(c.rowsWritten ?? 0)} | ${fmt(c.rowsRead ?? 0)} | ` +
				`${fmt(c.workerRequests ?? 0)} | ${fmt(c.r2ClassA ?? 0)} | ${fmt(c.r2ClassB ?? 0)} |`,
		);
	}

	const cell = (value: number, cap: Cap) => `${fmt(value)} (${pct(value, cap).toFixed(1)}%)`;
	console.log(
		`\n| Cap | Free cap | ${results.map((r) => `Scenario ${r.name}`).join(" | ")} | ≤ ${BUDGET_FRACTION * 100}% |`,
	);
	console.log(`|---|---|${results.map(() => "---|").join("")}---|`);
	for (const cap of Object.keys(FREE_CAPS) as Cap[]) {
		const pass = results.every((r) => !r.over.includes(cap));
		console.log(
			`| ${cap} | ${fmt(FREE_CAPS[cap])} | ${results.map((r) => cell(r.usage[cap], cap)).join(" | ")} | ` +
				`${pass ? "PASS" : "FAIL"} |`,
		);
	}
	console.log(
		`\nAwake bound (gbSeconds under the awake-window model, informational, not gated): ${results
			.map((r) => `${r.name} ${cell(r.awakeGbSeconds, "gbSeconds")}`)
			.join(", ")}`,
	);
	return results.every((r) => r.over.length === 0);
}

function compareBaseline(units: Units, file: string): boolean {
	const baseline = JSON.parse(readFileSync(file, "utf8")) as Units;
	let ok = true;
	console.log(`\n| Unit | Baseline (${file}) | This run | Δ |\n|---|---|---|---|`);
	for (const key of Object.keys(units) as Array<keyof Units>) {
		const ref = baseline[key];
		// Older baselines lack the P2 units, and analytic units are not measured.
		if (typeof ref !== "number" || !MEASURED.has(key)) continue;
		const delta = ref === 0 ? (units[key] === 0 ? 0 : 1) : (units[key] - ref) / ref;
		// Near-zero units (compaction inserts) are noise; compare them absolutely.
		const pass = Math.abs(delta) <= 0.25 || Math.abs(units[key] - ref) < 0.01;
		ok &&= pass;
		console.log(
			`| ${key} | ${ref.toFixed(3)} | ${units[key].toFixed(3)} | ${(delta * 100).toFixed(0)}%${pass ? "" : " FAIL"} |`,
		);
	}
	return ok;
}

let relay: { url: string; stop: () => Promise<void> } | null = null;
let dir: string | null = null;
let exitCode = 1;
try {
	if (args.url) {
		base = args.url.replace(/\/+$/, "");
	} else {
		dir = mkdtempSync(join(tmpdir(), "relay-budget-"));
		relay = await startRelayDev({ port: Number(args.port), persistTo: dir });
		base = relay.url;
	}
	alice = await login(base, "alice");
	bob = await login(base, "bob");
	ws = alice.workspaceId;
	const probe = await fetch(`${base}/api/debug/stats?ws=${ws}`);
	if (!probe.ok) throw new Error(`${base} has no /api/debug/stats (ARCASYNC_DEBUG_STATS=1 needed)`);

	process.stderr.write(`measuring unit costs against ${base}\n`);
	const units = await measureUnits();
	if (args.json) writeFileSync(args.json, JSON.stringify(units, null, "\t"));
	let ok = report(units);
	if (args.baseline) ok = compareBaseline(units, args.baseline) && ok;
	if (args.live) await live(units, Number(args["live-minutes"]), Number(args["live-clients"]));
	console.log(`\nbudget gate: ${ok ? "PASS" : "FAIL"}`);
	exitCode = ok ? 0 : 1;
} catch (error) {
	console.error(error);
} finally {
	await relay?.stop();
	if (dir) rmSync(dir, { recursive: true, force: true });
}
process.exit(exitCode);
