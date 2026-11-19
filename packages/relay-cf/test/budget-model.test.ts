import { BULK_CLONE_MIN_DOCS, CLONE_MAX_BYTES, CLONE_MAX_DOCS } from "@arcasync/shared";
import { describe, expect, it } from "vitest";
import {
	awakeGbSeconds,
	awakeSeconds,
	BILLING,
	BUDGET_FRACTION,
	type Cap,
	type Component,
	components,
	doRequests,
	ESTIMATED_UNITS,
	FREE_CAPS,
	gate,
	overBudget,
	PLAN_UNITS,
	SCENARIOS,
	TEAM,
	totals,
} from "../scripts/budget-model.ts";

/** The pre-R-9 worst case the plan's §2.B totals were computed with. */
const WORST = { ...BILLING, PINGS_BILLED: true, CLOSES_BILLED: true, DELETE_ROWS_BILLED: true };

const over = (usage: Record<Cap, number>) =>
	(Object.keys(FREE_CAPS) as Cap[]).filter((cap) => usage[cap] > FREE_CAPS[cap] * BUDGET_FRACTION);

/** P2 components and the fields each must carry (plan "Budget additions"). */
const P2_FIELDS: Record<string, Array<keyof Component>> = {
	"Device-code sign-in (start, polls, lookup, approve)": [
		"requests",
		"rowsWritten",
		"rowsRead",
		"workerRequests",
		"accountsEvents",
	],
	"Owner/admin ops (invites, roles, workspace create)": [
		"requests",
		"rowsWritten",
		"rowsRead",
		"workerRequests",
		"accountsEvents",
	],
	"Revocations (RPC, row, affected reconnect)": [
		"msgs",
		"requests",
		"closes",
		"rowsWritten",
		"rowsRead",
		"workerRequests",
		"wakeEvents",
		"accountsEvents",
	],
	"Invite accepts": ["requests", "rowsWritten", "rowsRead", "workerRequests", "accountsEvents"],
	"Binary uploads (missing, PUT, files meta, re-check)": [
		"msgs",
		"rowsWritten",
		"workerRequests",
		"r2ClassA",
		"r2ClassB",
		"wakeEvents",
	],
	"Binary downloads (every peer)": ["workerRequests", "r2ClassB"],
	"New-device clone, notes": ["requests", "rowsRead", "workerRequests", "wakeEvents"],
	"New-device clone, binaries": ["workerRequests", "r2ClassB"],
	"Returning-device clone (notes behind at session start)": [
		"requests",
		"rowsRead",
		"workerRequests",
		"wakeEvents",
	],
	"Files projection (files listings)": [
		"requests",
		"rowsWritten",
		"rowsRead",
		"workerRequests",
		"wakeEvents",
	],
	"B extra: chunk GC alarm": ["requests", "rowsWritten", "rowsRead", "r2ClassA", "wakeEvents"],
	"Password sign-ins and PIN entry": [
		"requests",
		"rowsWritten",
		"rowsRead",
		"workerRequests",
		"accountsEvents",
		"activeSec",
	],
};

/** The P1 components only, which the plan's §2.B totals describe. */
const p1 = (list: Component[]) => list.filter((c) => !(c.name in P2_FIELDS));

describe("budget model", () => {
	it("reproduces the plan's §2.B totals from the plan's unit costs", () => {
		const list = p1(components(PLAN_UNITS, TEAM, WORST));
		const a = totals(list, "A", TEAM, WORST);
		const b = totals(list, "B", TEAM, WORST);
		// Plan: A 31,640 requests / 12,120 rows; B adds 7,680 requests. The plan rounds compaction
		// and counts 100 closes plus 440 reconnect requests; the model derives both from connects.
		expect(a.doRequests).toBeGreaterThan(31_000);
		expect(a.doRequests).toBeLessThan(32_500);
		expect(b.doRequests - a.doRequests).toBeCloseTo(7680, 0);
		expect(a.rowsWritten).toBeGreaterThan(12_000);
		expect(a.rowsWritten).toBeLessThan(12_200);
		expect(over(a)).toEqual([]);
		expect(over(b)).toEqual([]);
	});

	it("fails the budget for unbatched typing (no flushDelay)", () => {
		const unbatched = {
			...PLAN_UNITS,
			updateMsgsPerKey: 1,
			awarenessMsgsPerKey: 1,
			rowsPerKey: 1,
		};
		const b = totals(components(unbatched), "B");
		expect(over(b)).toContain("doRequests");
	});

	it("fails the budget for heavy typists (10,000 keys/user/day)", () => {
		const heavy = { ...TEAM, keysPerUserDay: 10_000 };
		expect(over(totals(components(PLAN_UNITS, heavy), "A", heavy))).toContain("doRequests");
	});

	it("bills pings, closes and deletes only when the switches say so", () => {
		const free = {
			...WORST,
			PINGS_BILLED: false,
			CLOSES_BILLED: false,
			DELETE_ROWS_BILLED: false,
		};
		const worst = totals(p1(components(PLAN_UNITS, TEAM, WORST)), "B", TEAM, WORST);
		const best = totals(p1(components(PLAN_UNITS, TEAM, free)), "B", TEAM, free);
		expect(worst.doRequests - best.doRequests).toBeCloseTo(
			TEAM.users * 24 * PLAN_UNITS.pingsPerHour +
				TEAM.users * (TEAM.reconnectsPerUserDay + TEAM.sessionsPerUserDay),
			6,
		);
		expect(best.rowsWritten).toBeLessThan(worst.rowsWritten - 5000);
	});

	it("the measured billing (R-9) drops only the auto-responded pings from the worst case", () => {
		const worst = totals(components(PLAN_UNITS, TEAM, WORST), "B", TEAM, WORST);
		const measured = totals(components(PLAN_UNITS), "B");
		expect(worst.doRequests - measured.doRequests).toBeCloseTo(
			TEAM.users * 24 * PLAN_UNITS.pingsPerHour,
			6,
		);
		expect(measured.rowsWritten).toBe(worst.rowsWritten);
	});

	it("models the object as awake while events are frequent and asleep when rare", () => {
		expect(awakeSeconds(100_000, 8)).toBeCloseTo(8 * 3600, -2);
		expect(awakeSeconds(10, 16) / (16 * 3600)).toBeLessThan(0.01);
	});
});

describe("budget model, P2", () => {
	it("adds the R2 caps (monthly caps ÷ 30, storage a total)", () => {
		expect(FREE_CAPS.r2ClassA).toBe(33_333);
		expect(FREE_CAPS.r2ClassB).toBe(333_333);
		expect(FREE_CAPS.r2StorageBytes).toBe(10 * 1024 ** 3);
		const b = totals(components(PLAN_UNITS), "B");
		expect(b.r2StorageBytes).toBe(TEAM.attachmentBytesLive);
		expect(b.r2ClassA).toBeGreaterThan(0);
		expect(b.r2ClassB).toBeGreaterThan(0);
	});

	it("gives every new component the fields it is billed on", () => {
		const list = components(PLAN_UNITS);
		for (const [name, fields] of Object.entries(P2_FIELDS)) {
			const c = list.find((x) => x.name === name);
			expect(c, name).toBeDefined();
			for (const field of fields) expect(c?.[field], `${name}.${field}`).toBeGreaterThan(0);
		}
	});

	it("every scenario gates every cap, gbSeconds uses the calibrated model", () => {
		expect(BILLING.GB_S_MODEL).toBe("calibrated");
		const results = gate(PLAN_UNITS);
		expect(results.map((r) => r.name)).toEqual(["A", "B", "C"]);
		const caps = Object.keys(FREE_CAPS) as Cap[];
		for (const r of results) {
			expect(Object.keys(r.usage).sort()).toEqual([...caps].sort());
			expect(r.over).toEqual([]);
			for (const cap of caps) {
				const usage = { ...r.usage, [cap]: FREE_CAPS[cap] * BUDGET_FRACTION * 1.01 };
				expect(overBudget(usage), `${r.name} ${cap}`).toEqual([cap]);
			}
		}
	});

	it("calibrated gbSeconds = (billed DO requests × 0.018 s + password hashing) × 0.125 GB", () => {
		expect(BILLING.ACTIVE_SEC_PER_REQUEST).toBe(0.018);
		expect(BILLING.PASSWORD_HASH_SEC).toBe(0.09);
		const hashing = TEAM.passwordHashesPerDay * 0.09;
		expect(TEAM.doGb).toBe(0.125);
		for (const billing of [BILLING, WORST]) {
			for (const r of gate(PLAN_UNITS, billing)) {
				const requests = r.list
					.filter((c) => c.scenario === "A" || r.name !== "A")
					.reduce((n, c) => n + doRequests(c, billing), 0);
				expect(r.usage.doRequests).toBeCloseTo(requests, 6);
				expect(r.usage.gbSeconds).toBeCloseTo((requests * 0.018 + hashing) * 0.125, 6);
			}
		}
	});

	it("keeps the awake model as a switch and an informational bound", () => {
		const awake = { ...BILLING, GB_S_MODEL: "awake" as const };
		for (const r of gate(PLAN_UNITS)) {
			expect(totals(r.list, r.name, r.team, awake).gbSeconds).toBeCloseTo(r.awakeGbSeconds, 6);
			expect(r.awakeGbSeconds).toBe(awakeGbSeconds(r.list, r.name, r.team));
			expect(r.awakeGbSeconds).toBeGreaterThan(r.usage.gbSeconds);
		}
	});

	it("scenario C adds a second workspace: its own relay, renewals and connects, no rows", () => {
		const [, b, c] = gate(PLAN_UNITS);
		if (!b || !c) throw new Error("missing scenario");
		expect(SCENARIOS.find((s) => s.name === "C")?.team.workspacesPerUser).toBe(2);
		const connects = TEAM.users * (TEAM.reconnectsPerUserDay + TEAM.sessionsPerUserDay);
		expect(c.usage.doRequests - b.usage.doRequests).toBeCloseTo(
			TEAM.users * TEAM.workHours * PLAN_UNITS.renewalsPerHourActive +
				TEAM.users * TEAM.idleHours * PLAN_UNITS.renewalsPerHourIdle +
				connects * (PLAN_UNITS.framesPerBgOpen + 2),
			6,
		);
		expect(c.usage.rowsWritten).toBe(b.usage.rowsWritten);
		// The second workspace is a separate object, so it adds its own awake time.
		expect(c.awakeGbSeconds - b.awakeGbSeconds).toBeGreaterThan(1000);
	});

	it("P2-13 lane evidence: device login, account ops and revocation REST calls", () => {
		expect(ESTIMATED_UNITS).toEqual({
			rowsPerDeviceLogin: 7,
			rowsPerAccountOp: 3,
			restCallsPerRevocation: 4,
			rowsPerPasswordLogin: 5,
		});
		const units = { ...PLAN_UNITS, ...ESTIMATED_UNITS };
		const byName = (name: string) => {
			const c = components(units).find((x) => x.name === name);
			if (!c) throw new Error(`missing ${name}`);
			return c;
		};
		const device = byName("Device-code sign-in (start, polls, lookup, approve)");
		// start + 120 polls (the last one succeeds) + lookup + approve.
		expect(device.requests).toBe(123);
		expect(device.rowsWritten).toBe(7);
		const revocations = byName("Revocations (RPC, row, affected reconnect)");
		// RPC + upgrade + 2 workspace lists + 2 ws-token mints, per revocation.
		expect(revocations.requests).toBe(TEAM.revocationsPerDay * 6);
		expect(revocations.workerRequests).toBe(TEAM.revocationsPerDay * 5);
		expect(revocations.accountsEvents).toBe(TEAM.revocationsPerDay * 4);
	});

	it("binaries cost one PUT and one GET per chunk; conflict copies are uploads", () => {
		const list = components(PLAN_UNITS);
		const uploads = TEAM.users * TEAM.binariesPerUserDay + TEAM.binaryConflictCopiesPerDay;
		const chunks = uploads * TEAM.binaryChunksPerFile;
		expect(list.find((c) => c.name.startsWith("Binary uploads"))?.r2ClassA).toBe(chunks);
		expect(list.find((c) => c.name.startsWith("Binary downloads"))?.r2ClassB).toBe(
			chunks * (TEAM.users - 1),
		);
		const single = { ...TEAM, binaryChunksPerFile: 1, binaryConflictCopiesPerDay: 0 };
		const one = components(PLAN_UNITS, single).find((c) => c.name.startsWith("Binary uploads"));
		expect(one?.r2ClassA).toBe(TEAM.users * TEAM.binariesPerUserDay);
	});

	it("returning devices bulk-clone the notes they are behind on, besides the catch-up", () => {
		const returning = (t = TEAM, u = PLAN_UNITS) =>
			components(u, t).find((c) => c.name.startsWith("Returning-device clone"));
		const sessions = TEAM.users * TEAM.sessionsPerUserDay;
		expect(returning()?.requests).toBe(
			sessions * Math.ceil(TEAM.distinctNotesPerDay / CLONE_MAX_DOCS),
		);
		expect(returning()?.rowsRead).toBe(
			sessions * TEAM.distinctNotesPerDay * (TEAM.tailRowsMax + 1),
		);
		const few = { ...TEAM, distinctNotesPerDay: BULK_CLONE_MIN_DOCS - 1 };
		expect(returning(few)?.requests).toBe(0);
		expect(
			components(PLAN_UNITS).find((c) => c.name === "Background catch-up of closed notes")?.msgs,
		).toBeGreaterThan(0);
	});

	it("a clone page holds the measured docs unless the grown states hit CLONE_MAX_BYTES", () => {
		const newDevice = (t = TEAM, u = PLAN_UNITS) =>
			components(u, t).find((c) => c.name === "New-device clone, notes")?.requests;
		expect(newDevice()).toBe(TEAM.notesPerWorkspace / CLONE_MAX_DOCS);
		expect(newDevice(TEAM, { ...PLAN_UNITS, cloneDocsPerRequest: 50 })).toBe(
			TEAM.notesPerWorkspace / 50,
		);
		const big = { ...TEAM, avgNoteBytes: CLONE_MAX_BYTES / (10 * TEAM.stateGrowthFactor) };
		expect(newDevice(big)).toBe(TEAM.notesPerWorkspace / 10);
	});

	it("projection rows scale with the changed entries plus the unchanged listings", () => {
		const rows = (u = PLAN_UNITS) =>
			components(u).find((c) => c.name === "Files projection (files listings)")?.rowsWritten;
		expect(rows()).toBe(TEAM.projectionChangedRows);
		expect(
			rows({ ...PLAN_UNITS, projectionRowsPerChangedEntry: 2, projectionRowsUnchanged: 1 }),
		).toBe(2 * TEAM.projectionChangedRows + TEAM.projectionsPerDay);
	});

	it("the estimated units keep every scenario within the budget", () => {
		for (const r of gate({ ...PLAN_UNITS, ...ESTIMATED_UNITS })) expect(r.over, r.name).toEqual([]);
	});
});
