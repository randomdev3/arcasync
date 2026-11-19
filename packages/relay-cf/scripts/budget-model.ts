/**
 * The free-tier budget (plan v2 §2.B) as data: team activity, billing switches, free caps and the
 * traffic components. `budget.ts` measures the unit costs against a real relay and feeds them in.
 *
 * Hard rule: any new background traffic (a periodic message, a timer, a per-event row) gets a
 * component here in the same branch.
 */

/**
 * Billing semantics, from the R-9 probe on a free-plan account (2026-11-19). These are the counts
 * Cloudflare's GraphQL analytics reported per phase of `load-probe.ts`; the free-tier limits are
 * assumed to use the same counters:
 * - 501 awareness frames → 505 DO requests, 301 updates → 305: inbound messages count 1:1.
 * - ~140 keepalive pings in one minute → 2 DO requests (both stats reads): auto-responded pings
 *   are not counted.
 * - 50 × (connect + Auth + close) → 152 DO requests: closes are counted.
 * - Compaction did not run in the probe, so tail deletes stay counted (worst case).
 * - Duration: the 10-client live run counted 0.25 GB-s in 10 min (≈1.8 ms active per request),
 *   far below the awake model in `awakeSeconds`, which is kept as a deliberately loose bound. A
 *   gbSeconds trip near 50% is therefore a model artefact before it is a real risk.
 */
export const BILLING = {
	/** Inbound WebSocket messages per billed DO request (20 is documented for Workers Paid). */
	MSG_RATIO: 1,
	/** Keepalive pings answered by `setWebSocketAutoResponse` count as requests. */
	PINGS_BILLED: false,
	/** `webSocketClose` events count as requests. */
	CLOSES_BILLED: true,
	/** Compaction's tail deletes count as rows written (they do in local SQLite). */
	DELETE_ROWS_BILLED: true,
};
export type Billing = typeof BILLING;

/** Cloudflare free-plan daily caps (storage is a total, not daily). */
export const FREE_CAPS = {
	doRequests: 100_000,
	rowsWritten: 100_000,
	gbSeconds: 13_000,
	rowsRead: 5_000_000,
	workerRequests: 100_000,
	storageBytes: 5 * 1024 ** 3,
};
export type Cap = keyof typeof FREE_CAPS;

/** Every cap must stay at or below this fraction in both scenarios. */
export const BUDGET_FRACTION = 0.5;

/** Target team (plan §2.B). Scenario A: work hours only. B: A plus Obsidian idle the rest. */
export const TEAM = {
	users: 10,
	workHours: 8,
	idleHours: 16,
	keysPerUserDay: 2000,
	/** Typing speed the per-key costs are measured at. */
	typingKeysPerSec: 4,
	opensPerUserDay: 50,
	cursorMovesPerUserDay: 200,
	reconnectsPerUserDay: 4,
	/** Obsidian starts per day; each costs what a reconnect costs. */
	sessionsPerUserDay: 1,
	distinctNotesPerDay: 100,
	/** Docs with a non-null awareness state per client: index + focused note. */
	presenceDocsPerClient: 2,
	/** File switches, idle flips, follow (awareness changes besides typing and cursor moves). */
	presenceChangesPerUserHour: 40,
	/** Docs re-authenticated per (re)connect: index + focused note + one more open editor. */
	docsPerConnect: 3,
	indexOpsPerDay: 300,
	/** docRevs: at most one index bump per this many seconds of typing (assumption 6). */
	docRevBumpEverySec: 5,
	/** `doc_clients` first-sight rows (P1-8), about one per writing session. */
	docClientsRows: 500,
	/** server-info, me, ws-token, logins. */
	restCallsPerUserDay: 100,
	restRowsPerDay: 20,
	/** Compaction threshold: worst-case rows read per doc load (plus one state part). */
	tailRowsMax: 500,
	notes: 1000,
	avgNoteBytes: 10_000,
	/** Non-GC merged state keeps deleted content (R-6). */
	stateGrowthFactor: 4,
	/** Billed memory per Durable Object (128 MB). */
	doGb: 0.125,
	/** Idle time before a Durable Object hibernates (awake model). */
	hibernateAfterSec: 10,
};
export type Team = typeof TEAM;

/** Unit costs, measured by `budget.ts` against `wrangler dev` (or a deployment). */
export interface Units {
	/** Update messages per typed key at `typingKeysPerSec` with flushDelay. */
	updateMsgsPerKey: number;
	/** Cursor awareness messages per typed key. */
	awarenessMsgsPerKey: number;
	/** Log rows written per typed key (before compaction). */
	rowsPerKey: number;
	/** Inbound frames to open and close a note the user focuses (awareness on). */
	framesPerOpen: number;
	/** Inbound frames to open and close a note in the background (no awareness). */
	framesPerBgOpen: number;
	/** Messages per cursor-only move or presence change. */
	msgsPerAwarenessChange: number;
	/** Renewal messages per client-hour per presence doc. */
	renewalsPerHourActive: number;
	renewalsPerHourIdle: number;
	/** Keepalive pings per client-hour (client-side count). */
	pingsPerHour: number;
	/** Inbound frames for one (re)connect with `docsPerConnect` docs (excl. upgrade and close). */
	framesPerConnect: number;
	/** Extra rows written by compaction per log row, deletes included / excluded. */
	compactionRowsPerLogRow: number;
	compactionInsertsPerLogRow: number;
}

/** The plan's §2.B assumptions, for comparison with the measured units. */
export const PLAN_UNITS: Units = {
	updateMsgsPerKey: 0.25,
	awarenessMsgsPerKey: 0.25,
	rowsPerKey: 0.25,
	framesPerOpen: 4,
	framesPerBgOpen: 4,
	msgsPerAwarenessChange: 1,
	renewalsPerHourActive: 30,
	renewalsPerHourIdle: 4,
	pingsPerHour: 40,
	framesPerConnect: 10,
	compactionRowsPerLogRow: 0.84,
	compactionInsertsPerLogRow: 0.002,
};

export interface Component {
	name: string;
	scenario: "A" | "B-extra";
	/** Inbound WebSocket messages (billed at `MSG_RATIO`). */
	msgs?: number;
	/** Auto-responded pings (billed only if `PINGS_BILLED`, at `MSG_RATIO`). */
	pings?: number;
	/** Close events (billed only if `CLOSES_BILLED`). */
	closes?: number;
	/** Requests billed 1:1 (WebSocket upgrades, AccountsDO RPCs). */
	requests?: number;
	rowsWritten?: number;
	rowsRead?: number;
	workerRequests?: number;
	/** Relay events that can wake the object, spread over the component's hours. */
	wakeEvents?: number;
	/** AccountsDO events (REST), spread over the work hours. */
	accountsEvents?: number;
}

export function components(u: Units, t: Team = TEAM, billing: Billing = BILLING): Component[] {
	const keys = t.users * t.keysPerUserDay;
	const typingSeconds = keys / t.typingKeysPerSec;
	const docRevBumps = typingSeconds / t.docRevBumpEverySec;
	const logRows = keys * u.rowsPerKey + docRevBumps + t.indexOpsPerDay;
	const connects = t.users * (t.reconnectsPerUserDay + t.sessionsPerUserDay);
	const opens = t.users * t.opensPerUserDay;
	const bgOpens = t.distinctNotesPerDay * (t.users - 1);
	const rest = t.users * t.restCallsPerUserDay;
	const compactionPerRow = billing.DELETE_ROWS_BILLED
		? u.compactionRowsPerLogRow
		: u.compactionInsertsPerLogRow;
	const msgsOnly = (
		name: string,
		msgs: number,
		scenario: Component["scenario"] = "A",
	): Component => ({
		name,
		scenario,
		msgs,
		wakeEvents: msgs,
	});
	return [
		{
			name: "Keepalive pings (auto-responded)",
			scenario: "A",
			pings: t.users * t.workHours * u.pingsPerHour,
		},
		msgsOnly(
			"Presence renewals, active",
			t.users * t.workHours * t.presenceDocsPerClient * u.renewalsPerHourActive,
		),
		msgsOnly(
			"Presence changes (file switch, idle flip, follow)",
			t.users * t.workHours * t.presenceChangesPerUserHour * u.msgsPerAwarenessChange,
		),
		{
			name: "Typing updates",
			scenario: "A",
			msgs: keys * u.updateMsgsPerKey,
			rowsWritten: keys * u.rowsPerKey,
			wakeEvents: keys * u.updateMsgsPerKey,
		},
		msgsOnly("Cursor awareness while typing", keys * u.awarenessMsgsPerKey),
		msgsOnly("Cursor-only moves", t.users * t.cursorMovesPerUserDay * u.msgsPerAwarenessChange),
		{
			name: "docRevs bumps",
			scenario: "A",
			msgs: docRevBumps,
			rowsWritten: docRevBumps,
			wakeEvents: docRevBumps,
		},
		{
			name: "Note opens (focused)",
			scenario: "A",
			msgs: opens * u.framesPerOpen,
			rowsRead: opens * (t.tailRowsMax + 1),
			wakeEvents: opens * u.framesPerOpen,
		},
		{
			name: "Background catch-up of closed notes",
			scenario: "A",
			msgs: bgOpens * u.framesPerBgOpen,
			rowsRead: bgOpens * (t.tailRowsMax + 1),
			wakeEvents: bgOpens * u.framesPerBgOpen,
		},
		{
			name: "Connects (session starts + reconnects)",
			scenario: "A",
			msgs: connects * u.framesPerConnect,
			requests: connects,
			closes: connects,
			rowsRead: connects * t.docsPerConnect * (t.tailRowsMax + 1),
			workerRequests: connects,
			wakeEvents: connects * (u.framesPerConnect + 2),
		},
		{
			name: "Index ops (create/rename/delete)",
			scenario: "A",
			msgs: t.indexOpsPerDay,
			rowsWritten: t.indexOpsPerDay,
			wakeEvents: t.indexOpsPerDay,
		},
		{ name: "doc_clients first sight", scenario: "A", rowsWritten: t.docClientsRows },
		{
			name: "Compaction (parts + tail deletes)",
			scenario: "A",
			rowsWritten: logRows * compactionPerRow,
			rowsRead: logRows,
		},
		{
			name: "AccountsDO REST",
			scenario: "A",
			requests: rest,
			rowsWritten: t.restRowsPerDay,
			workerRequests: rest,
			accountsEvents: rest,
		},
		{
			name: "B extra: idle keepalive",
			scenario: "B-extra",
			pings: t.users * t.idleHours * u.pingsPerHour,
		},
		msgsOnly(
			"B extra: idle renewals",
			t.users * t.idleHours * t.presenceDocsPerClient * u.renewalsPerHourIdle,
			"B-extra",
		),
	];
}

export function doRequests(c: Component, billing: Billing = BILLING): number {
	return (
		((c.msgs ?? 0) + (billing.PINGS_BILLED ? (c.pings ?? 0) : 0)) / billing.MSG_RATIO +
		(billing.CLOSES_BILLED ? (c.closes ?? 0) : 0) +
		(c.requests ?? 0)
	);
}

/** Seconds awake when `events` arrive uniformly over `hours`: P(awake per 10 s) = 1 − e^(−rate·10 s). */
export function awakeSeconds(events: number, hours: number, t: Team = TEAM): number {
	if (hours <= 0) return 0;
	const seconds = hours * 3600;
	const rate = events / seconds;
	return seconds * (1 - Math.exp(-rate * t.hibernateAfterSec));
}

export type Usage = Record<Cap, number>;

export function totals(
	list: Component[],
	scenario: "A" | "B",
	t: Team = TEAM,
	billing: Billing = BILLING,
): Usage {
	const included = list.filter((c) => c.scenario === "A" || scenario === "B");
	const sum = (f: (c: Component) => number) => included.reduce((n, c) => n + f(c), 0);
	const work = list.filter((c) => c.scenario === "A");
	const idle = list.filter((c) => c.scenario === "B-extra");
	const events = (cs: Component[]) => cs.reduce((n, c) => n + (c.wakeEvents ?? 0), 0);
	const relayAwake =
		awakeSeconds(events(work), t.workHours, t) +
		(scenario === "B" ? awakeSeconds(events(idle), t.idleHours, t) : 0);
	const accountsAwake = awakeSeconds(
		work.reduce((n, c) => n + (c.accountsEvents ?? 0), 0),
		t.workHours,
		t,
	);
	return {
		doRequests: sum((c) => doRequests(c, billing)),
		rowsWritten: sum((c) => c.rowsWritten ?? 0),
		gbSeconds: (relayAwake + accountsAwake) * t.doGb,
		rowsRead: sum((c) => c.rowsRead ?? 0),
		workerRequests: sum((c) => c.workerRequests ?? 0),
		storageBytes: t.notes * t.avgNoteBytes * t.stateGrowthFactor,
	};
}
