/**
 * The free-tier budget (plan v2 §2.B) as data: team activity, billing switches, free caps and the
 * traffic components. `budget.ts` measures the unit costs against a real relay and feeds them in.
 *
 * Hard rule: any new background traffic (a periodic message, a timer, a per-event row) gets a
 * component here in the same branch.
 */
import { BULK_CLONE_MIN_DOCS, CLONE_MAX_BYTES, CLONE_MAX_DOCS } from "@arcasync/shared";

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
 *   far below the awake model in `awakeSeconds` (≈75 GB-s for the same run). The gate therefore
 *   uses the calibrated model (`GB_S_MODEL`): billed DO requests × `ACTIVE_SEC_PER_REQUEST` ×
 *   `doGb`, with the measured 1.8 ms × 10 as a safety margin. The awake model is still printed as
 *   an informational upper bound (`awakeGbSeconds`) and no longer gates (orchestrator decision,
 *   2026-11-19, overriding plan D12).
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
	/** Which duration model feeds the gbSeconds cap: R-9 calibrated, or the awake-window bound. */
	GB_S_MODEL: "calibrated" as "calibrated" | "awake",
	/** Active DO seconds per billed request: R-9 measured ≈1.8 ms, × 10 safety margin. */
	ACTIVE_SEC_PER_REQUEST: 0.018,
};
export type Billing = typeof BILLING;

/**
 * Cloudflare free-plan daily caps (storage is a total, not daily). R2 operation caps are monthly,
 * so the daily figures are the monthly cap ÷ 30.
 */
export const FREE_CAPS = {
	doRequests: 100_000,
	rowsWritten: 100_000,
	gbSeconds: 13_000,
	rowsRead: 5_000_000,
	workerRequests: 100_000,
	storageBytes: 5 * 1024 ** 3,
	/** 1M Class A operations (PUT, LIST) per month. */
	r2ClassA: 33_333,
	/** 10M Class B operations (GET, HEAD) per month. */
	r2ClassB: 333_333,
	r2StorageBytes: 10 * 1024 ** 3,
};
export type Cap = keyof typeof FREE_CAPS;

/** Every cap must stay at or below this fraction in every scenario. */
export const BUDGET_FRACTION = 0.5;

/**
 * Target team (plan §2.B, P2 additions from the P2 plan). Scenario A: work hours only. B: A plus
 * Obsidian idle the rest. C: B with every user in `workspacesPerUser = 2` workspaces.
 */
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
	/** Active workspaces per user; each extra one is another socket and WorkspaceRelay. */
	workspacesPerUser: 1,
	/** Attachments added per user per day (P2 assumption 2), each read once by every peer. */
	binariesPerUserDay: 5,
	/**
	 * Average 4 MiB chunks per attachment. P2-11 lane: a file over `CHUNK_BYTES` costs one PUT and
	 * one GET per chunk (the 9 MiB attachments e2e file = 3), so 2 covers a mix with some large
	 * files rather than the plan's 1 (assumption).
	 */
	binaryChunksPerFile: 2,
	/**
	 * Offline binary edits that lose last-writer-wins and are kept as a conflict copy, which is
	 * one more full upload (P2-11 lane). Assumption: one in ten uploads.
	 */
	binaryConflictCopiesPerDay: 5,
	/** New devices per day that clone the whole workspace. */
	newDevicesPerDay: 1,
	notesPerWorkspace: 1000,
	binariesPerWorkspace: 500,
	/** Device-code logins per day, each polling for the full TTL (600 s every 5 s). */
	deviceLoginsPerDay: 1,
	devicePollsPerLogin: 120,
	/** Owner/admin operations per day (invites, roles, workspace create). */
	accountOpsPerDay: 20,
	/** Membership changes per day that revoke a user's sockets. */
	revocationsPerDay: 5,
	inviteAcceptsPerDay: 1,
	/** `files` projections per day (files listings; the GC alarm's two are counted there). */
	projectionsPerDay: 2,
	/** Rows the projections upsert or delete per day (changed entries only, D11). */
	projectionChangedRows: 350,
	attachmentBytesLive: 2 * 1024 ** 3,
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
	/** AccountsDO rows written per device-code login (code, approve, device, session). */
	rowsPerDeviceLogin: number;
	/** AccountsDO rows written per owner/admin operation (the change plus its audit row). */
	rowsPerAccountOp: number;
	/** AccountsDO rows written per invite accept (user, device, session, membership, invite, audit). */
	rowsPerInviteAccept: number;
	/** WorkspaceRelay rows written per revocation (`revocations`). */
	rowsPerRevocation: number;
	/**
	 * Client REST calls (each a Worker and an AccountsDO request) per revocation the affected
	 * client sees: `GET /api/workspaces` and ws-token mints after the 4401 close.
	 */
	restCallsPerRevocation: number;
	/** AccountsDO calls per device-code login besides the pending polls (start, lookup, approve, the successful poll). */
	accountsCallsPerDeviceLogin: number;
	/** Docs per bulk-clone response (`CLONE_MAX_DOCS` unless `CLONE_MAX_BYTES` cuts the page). */
	cloneDocsPerRequest: number;
	/** `files` rows a projection writes per changed index entry. */
	projectionRowsPerChangedEntry: number;
	/** `files` rows a projection writes when nothing changed. */
	projectionRowsUnchanged: number;
	/** Index-doc messages (and log rows) per binary upload (the `files` meta update). */
	indexMsgsPerBinaryUpload: number;
	/** `missing` calls per binary upload (before the PUT, and the re-check after the meta ack). */
	missingCallsPerUpload: number;
	/** Chunk GC alarm runs per day (D13: armed by index writes, fires once). */
	gcRunsPerDay: number;
	/** R2 list pages per GC run (Class A). */
	gcListsPerRun: number;
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
	// P2 plan "Budget additions" (analytic).
	rowsPerDeviceLogin: 4,
	rowsPerAccountOp: 2,
	rowsPerInviteAccept: 6,
	rowsPerRevocation: 1,
	restCallsPerRevocation: 1,
	accountsCallsPerDeviceLogin: 4,
	cloneDocsPerRequest: CLONE_MAX_DOCS,
	projectionRowsPerChangedEntry: 1,
	projectionRowsUnchanged: 0,
	indexMsgsPerBinaryUpload: 1,
	missingCallsPerUpload: 2,
	gcRunsPerDay: 1,
	gcListsPerRun: 2,
};

/**
 * P2 units `budget.ts` cannot measure (AccountsDO has no rows counter, and the client-side costs
 * are the plugin's, not the test clients'). Set from the P2 lanes' evidence and a code audit
 * (P2-13); they replace the plan's figures. `budget.ts` measures the rest.
 */
export const ESTIMATED_UNITS: Partial<Units> = {
	/**
	 * AccountsDO `deviceStart` inserts the code, `deviceApprove` updates it and writes an audit row,
	 * the successful `devicePoll` inserts the device and the session and marks the code used, and
	 * the next `deviceStart` deletes the spent code: 7 (P2-9 lane: 6–7; the plan said 4).
	 */
	rowsPerDeviceLogin: 7,
	/** The change plus its audit row; workspace create and enable (re-entry invite) write 3. */
	rowsPerAccountOp: 3,
	/**
	 * P2-10 lane: after a 4401 the client re-reads `GET /api/workspaces` once (twice on removal)
	 * and mints one ws-token; a refused stale JWT (or a chunk/clone 401) costs one more mint.
	 * Worst case 2 + 1 + 1.
	 */
	restCallsPerRevocation: 4,
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
	/** The relay events land on the user's extra workspaces (other WorkspaceRelay objects). */
	extraWorkspaces?: boolean;
	/** R2 Class A operations (PUT, LIST). */
	r2ClassA?: number;
	/** R2 Class B operations (GET, HEAD). */
	r2ClassB?: number;
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
	const uploads = t.users * t.binariesPerUserDay + t.binaryConflictCopiesPerDay;
	const uploadChunks = uploads * t.binaryChunksPerFile;
	const cloneChunks = t.newDevicesPerDay * t.binariesPerWorkspace * t.binaryChunksPerFile;
	/** A page holds `cloneDocsPerRequest` docs unless their grown states hit `CLONE_MAX_BYTES`. */
	const docsPerPage = Math.max(
		1,
		Math.min(
			u.cloneDocsPerRequest,
			Math.floor(CLONE_MAX_BYTES / (t.avgNoteBytes * t.stateGrowthFactor)),
		),
	);
	const cloneRequests = t.newDevicesPerDay * Math.ceil(t.notesPerWorkspace / docsPerPage);
	/**
	 * P2-12 lane: a returning device also bulk-clones when ≥ `BULK_CLONE_MIN_DOCS` notes are behind.
	 * Worst case: every session start is behind on all the notes edited that day.
	 */
	const sessionStarts = t.users * t.sessionsPerUserDay;
	const behind = t.distinctNotesPerDay >= BULK_CLONE_MIN_DOCS ? t.distinctNotesPerDay : 0;
	const returningCloneRequests = behind > 0 ? sessionStarts * Math.ceil(behind / docsPerPage) : 0;
	/** The polls include the successful one, which `accountsCallsPerDeviceLogin` also counts. */
	const deviceRequests =
		t.deviceLoginsPerDay * (u.accountsCallsPerDeviceLogin - 1 + t.devicePollsPerLogin);
	const docLoad = t.tailRowsMax + 1;
	/** Index doc load plus a scan of the `files` table. */
	const projectionRowsRead = docLoad + t.notesPerWorkspace + t.binariesPerWorkspace;
	const indexWrites = t.indexOpsPerDay + docRevBumps + uploads * u.indexMsgsPerBinaryUpload;
	const extra = t.workspacesPerUser - 1;
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
			// Every peer but the writer: since the P2-12 fix a note's own docRevs bump no longer
			// re-queues it on the writer's device.
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
			name: "Device-code sign-in (start, polls, lookup, approve)",
			scenario: "A",
			requests: deviceRequests,
			rowsWritten: t.deviceLoginsPerDay * u.rowsPerDeviceLogin,
			rowsRead: deviceRequests,
			workerRequests: deviceRequests,
			accountsEvents: deviceRequests,
		},
		{
			name: "Owner/admin ops (invites, roles, workspace create)",
			scenario: "A",
			requests: t.accountOpsPerDay,
			rowsWritten: t.accountOpsPerDay * u.rowsPerAccountOp,
			rowsRead: t.accountOpsPerDay,
			workerRequests: t.accountOpsPerDay,
			accountsEvents: t.accountOpsPerDay,
		},
		{
			// RPC to the relay, the client's REST calls (workspaces, ws-token mints) and the
			// reconnect (upgrade, frames, close).
			name: "Revocations (RPC, row, affected reconnect)",
			scenario: "A",
			msgs: t.revocationsPerDay * u.framesPerConnect,
			requests: t.revocationsPerDay * (2 + u.restCallsPerRevocation),
			closes: t.revocationsPerDay,
			rowsWritten: t.revocationsPerDay * u.rowsPerRevocation,
			rowsRead: t.revocationsPerDay * t.docsPerConnect * docLoad,
			workerRequests: t.revocationsPerDay * (1 + u.restCallsPerRevocation),
			wakeEvents: t.revocationsPerDay * (u.framesPerConnect + 3),
			accountsEvents: t.revocationsPerDay * u.restCallsPerRevocation,
		},
		{
			name: "Invite accepts",
			scenario: "A",
			requests: t.inviteAcceptsPerDay,
			rowsWritten: t.inviteAcceptsPerDay * u.rowsPerInviteAccept,
			rowsRead: t.inviteAcceptsPerDay * 5,
			workerRequests: t.inviteAcceptsPerDay,
			accountsEvents: t.inviteAcceptsPerDay,
		},
		{
			// `missing` (one R2 head per sha) before the PUT and again after the meta ack; one PUT
			// per chunk. Conflict copies are uploads too.
			name: "Binary uploads (missing, PUT, files meta, re-check)",
			scenario: "A",
			msgs: uploads * u.indexMsgsPerBinaryUpload,
			rowsWritten: uploads * u.indexMsgsPerBinaryUpload,
			workerRequests: uploads * u.missingCallsPerUpload + uploadChunks,
			r2ClassA: uploadChunks,
			r2ClassB: uploadChunks * u.missingCallsPerUpload,
			wakeEvents: uploads * u.indexMsgsPerBinaryUpload,
		},
		{
			name: "Binary downloads (every peer)",
			scenario: "A",
			workerRequests: uploadChunks * (t.users - 1),
			r2ClassB: uploadChunks * (t.users - 1),
		},
		{
			name: "New-device clone, notes",
			scenario: "A",
			requests: cloneRequests,
			rowsRead: t.newDevicesPerDay * t.notesPerWorkspace * docLoad,
			workerRequests: cloneRequests,
			wakeEvents: cloneRequests,
		},
		{
			name: "New-device clone, binaries",
			scenario: "A",
			workerRequests: cloneChunks,
			r2ClassB: cloneChunks,
		},
		{
			// No credit taken: "Background catch-up of closed notes" still counts every note as well.
			name: "Returning-device clone (notes behind at session start)",
			scenario: "A",
			requests: returningCloneRequests,
			rowsRead: sessionStarts * behind * docLoad,
			workerRequests: returningCloneRequests,
			wakeEvents: returningCloneRequests,
		},
		{
			name: "Files projection (files listings)",
			scenario: "A",
			requests: t.projectionsPerDay,
			rowsWritten:
				t.projectionChangedRows * u.projectionRowsPerChangedEntry +
				t.projectionsPerDay * u.projectionRowsUnchanged,
			rowsRead: t.projectionsPerDay * projectionRowsRead,
			workerRequests: t.projectionsPerDay,
			wakeEvents: t.projectionsPerDay,
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
		{
			// D18: `setAlarm` = 1 row written, a run = 1 request, `getAlarm` = 1 row read per wake
			// (at most one per index write). A run takes two projections and lists R2; deletes are free.
			name: "B extra: chunk GC alarm",
			scenario: "B-extra",
			requests: u.gcRunsPerDay,
			rowsWritten: u.gcRunsPerDay * (2 + 2 * u.projectionRowsUnchanged),
			rowsRead: indexWrites + u.gcRunsPerDay * 2 * projectionRowsRead,
			r2ClassA: u.gcRunsPerDay * u.gcListsPerRun,
			wakeEvents: u.gcRunsPerDay,
		},
		...(extra > 0 ? extraWorkspaceComponents(u, t, extra, connects) : []),
	];
}

/** Scenario C: each extra workspace is one more socket and WorkspaceRelay with its index doc. */
function extraWorkspaceComponents(u: Units, t: Team, extra: number, connects: number): Component[] {
	const extraConnects = connects * extra;
	return [
		{
			name: "C extra: keepalive pings of extra sockets",
			scenario: "A",
			pings: t.users * t.workHours * extra * u.pingsPerHour,
			extraWorkspaces: true,
		},
		{
			name: "C extra: index renewals, active",
			scenario: "A",
			msgs: t.users * t.workHours * extra * u.renewalsPerHourActive,
			wakeEvents: t.users * t.workHours * extra * u.renewalsPerHourActive,
			extraWorkspaces: true,
		},
		{
			name: "C extra: connects of extra sockets (index doc)",
			scenario: "A",
			msgs: extraConnects * u.framesPerBgOpen,
			requests: extraConnects,
			closes: extraConnects,
			rowsRead: extraConnects * (t.tailRowsMax + 1),
			workerRequests: extraConnects,
			wakeEvents: extraConnects * (u.framesPerBgOpen + 2),
			extraWorkspaces: true,
		},
		{
			name: "C extra: idle keepalive of extra sockets",
			scenario: "B-extra",
			pings: t.users * t.idleHours * extra * u.pingsPerHour,
			extraWorkspaces: true,
		},
		{
			name: "C extra: index renewals, idle",
			scenario: "B-extra",
			msgs: t.users * t.idleHours * extra * u.renewalsPerHourIdle,
			wakeEvents: t.users * t.idleHours * extra * u.renewalsPerHourIdle,
			extraWorkspaces: true,
		},
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
/** A: work hours. B: A plus idle hours. C: B with `workspacesPerUser = 2`. */
export type Scenario = "A" | "B" | "C";

const inScenario = (c: Component, scenario: Scenario) => c.scenario === "A" || scenario !== "A";

/**
 * GB-s under the awake-window model: each Durable Object is billed while awake (`awakeSeconds`).
 * Since R-9 this is an informational upper bound, not the gate. Every extra workspace is its own
 * WorkspaceRelay, so its events keep a separate object awake.
 */
export function awakeGbSeconds(list: Component[], scenario: Scenario, t: Team = TEAM): number {
	const events = (cs: Component[], f: (c: Component) => number | undefined) =>
		cs.reduce((n, c) => n + (f(c) ?? 0), 0);
	const relayAwake = (extra: boolean, objects: number) => {
		if (objects <= 0) return 0;
		const mine = list.filter((c) => Boolean(c.extraWorkspaces) === extra);
		const per = (s: Component["scenario"]) =>
			events(
				mine.filter((c) => c.scenario === s),
				(c) => c.wakeEvents,
			) / objects;
		return (
			objects *
			(awakeSeconds(per("A"), t.workHours, t) +
				(scenario === "A" ? 0 : awakeSeconds(per("B-extra"), t.idleHours, t)))
		);
	};
	const accountsAwake = awakeSeconds(
		events(
			list.filter((c) => c.scenario === "A"),
			(c) => c.accountsEvents,
		),
		t.workHours,
		t,
	);
	return (
		(relayAwake(false, 1) + relayAwake(true, t.workspacesPerUser - 1) + accountsAwake) * t.doGb
	);
}

export function totals(
	list: Component[],
	scenario: Scenario,
	t: Team = TEAM,
	billing: Billing = BILLING,
): Usage {
	const included = list.filter((c) => inScenario(c, scenario));
	const sum = (f: (c: Component) => number) => included.reduce((n, c) => n + f(c), 0);
	const requests = sum((c) => doRequests(c, billing));
	return {
		doRequests: requests,
		rowsWritten: sum((c) => c.rowsWritten ?? 0),
		gbSeconds:
			billing.GB_S_MODEL === "awake"
				? awakeGbSeconds(list, scenario, t)
				: requests * billing.ACTIVE_SEC_PER_REQUEST * t.doGb,
		rowsRead: sum((c) => c.rowsRead ?? 0),
		workerRequests: sum((c) => c.workerRequests ?? 0),
		storageBytes: t.notes * t.avgNoteBytes * t.stateGrowthFactor,
		r2ClassA: sum((c) => c.r2ClassA ?? 0),
		r2ClassB: sum((c) => c.r2ClassB ?? 0),
		r2StorageBytes: t.attachmentBytesLive,
	};
}

/** The gated scenarios. Every one must stay ≤ `BUDGET_FRACTION` on every cap. */
export const SCENARIOS: ReadonlyArray<{ name: Scenario; team: Team }> = [
	{ name: "A", team: TEAM },
	{ name: "B", team: TEAM },
	{ name: "C", team: { ...TEAM, workspacesPerUser: 2 } },
];

/** Caps above `BUDGET_FRACTION`. */
export function overBudget(usage: Usage): Cap[] {
	return (Object.keys(FREE_CAPS) as Cap[]).filter(
		(cap) => usage[cap] > FREE_CAPS[cap] * BUDGET_FRACTION,
	);
}

export interface ScenarioResult {
	name: Scenario;
	team: Team;
	list: Component[];
	usage: Usage;
	/** Informational: GB-s under the awake-window model. */
	awakeGbSeconds: number;
	over: Cap[];
}

export function gate(u: Units, billing: Billing = BILLING): ScenarioResult[] {
	return SCENARIOS.map(({ name, team }) => {
		const list = components(u, team, billing);
		const usage = totals(list, name, team, billing);
		return {
			name,
			team,
			list,
			usage,
			awakeGbSeconds: awakeGbSeconds(list, name, team),
			over: overBudget(usage),
		};
	});
}
