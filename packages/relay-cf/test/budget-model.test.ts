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
	"Files projection (files listings)": [
		"requests",
		"rowsWritten",
		"rowsRead",
		"workerRequests",
		"wakeEvents",
	],
	"B extra: chunk GC alarm": ["requests", "rowsWritten", "rowsRead", "r2ClassA", "wakeEvents"],
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

	it("calibrated gbSeconds = billed DO requests × 0.018 s × 0.125 GB", () => {
		expect(BILLING.ACTIVE_SEC_PER_REQUEST).toBe(0.018);
		expect(TEAM.doGb).toBe(0.125);
		for (const billing of [BILLING, WORST]) {
			for (const r of gate(PLAN_UNITS, billing)) {
				const requests = r.list
					.filter((c) => c.scenario === "A" || r.name !== "A")
					.reduce((n, c) => n + doRequests(c, billing), 0);
				expect(r.usage.doRequests).toBeCloseTo(requests, 6);
				expect(r.usage.gbSeconds).toBeCloseTo(requests * 0.018 * 0.125, 6);
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
});
