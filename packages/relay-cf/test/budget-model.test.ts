import { describe, expect, it } from "vitest";
import {
	awakeSeconds,
	BILLING,
	BUDGET_FRACTION,
	type Cap,
	components,
	FREE_CAPS,
	PLAN_UNITS,
	TEAM,
	totals,
} from "../scripts/budget-model.ts";

const over = (usage: Record<Cap, number>) =>
	(Object.keys(FREE_CAPS) as Cap[]).filter((cap) => usage[cap] > FREE_CAPS[cap] * BUDGET_FRACTION);

describe("budget model", () => {
	it("reproduces the plan's §2.B totals from the plan's unit costs", () => {
		const list = components(PLAN_UNITS);
		const a = totals(list, "A");
		const b = totals(list, "B");
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
			...BILLING,
			PINGS_BILLED: false,
			CLOSES_BILLED: false,
			DELETE_ROWS_BILLED: false,
		};
		const worst = totals(components(PLAN_UNITS), "B");
		const best = totals(components(PLAN_UNITS, TEAM, free), "B", TEAM, free);
		expect(worst.doRequests - best.doRequests).toBeCloseTo(
			TEAM.users * 24 * PLAN_UNITS.pingsPerHour +
				TEAM.users * (TEAM.reconnectsPerUserDay + TEAM.sessionsPerUserDay),
			6,
		);
		expect(best.rowsWritten).toBeLessThan(worst.rowsWritten - 5000);
	});

	it("models the object as awake while events are frequent and asleep when rare", () => {
		expect(awakeSeconds(100_000, 8)).toBeCloseTo(8 * 3600, -2);
		expect(awakeSeconds(10, 16) / (16 * 3600)).toBeLessThan(0.01);
	});
});
