import { describe, expect, it } from "vitest";
import {
	advance,
	createSim,
	PAGE,
	stillFrame,
	TRAIL,
	trailPoint,
	X_END,
	X_START,
} from "../loom/paths";

describe("loom paths", () => {
	it("keeps every head inside the loom's bounds over two minutes, following now and then", () => {
		const sim = createSim(3);
		let follows = 0;
		let wasFollowing = false;
		for (let s = 0; s < 120 * 10; s++) {
			advance(sim, 0.1);
			if (sim.follow && !wasFollowing) follows += 1;
			wasFollowing = sim.follow !== null;
			for (const head of sim.heads) {
				expect(head.x).toBeGreaterThanOrEqual(X_START);
				expect(head.x).toBeLessThanOrEqual(X_END);
				expect(Math.abs(head.y)).toBeLessThanOrEqual(PAGE.height / 2);
			}
		}
		expect(follows).toBeGreaterThanOrEqual(5);
	});

	it("ends each trail at its head", () => {
		const sim = createSim();
		advance(sim, 3);
		for (const head of sim.heads) {
			const [x, y] = trailPoint(head, TRAIL - 1, [0, 0]);
			expect(x).toBeCloseTo(head.x, 5);
			expect(y).toBeCloseTo(head.y, 5);
		}
	});

	it("composes the still frame with two carets mid-follow", () => {
		const sim = stillFrame();
		const [leader, follower] = [sim.heads[0], sim.heads[1]];
		expect(sim.follow).toMatchObject({ follower: 1, leader: 0 });
		expect(Math.abs((leader?.y ?? 0) - (follower?.y ?? 9))).toBeLessThan(0.3);
		expect(stillFrame().heads.map((h) => h.x)).toEqual(sim.heads.map((h) => h.x));
	});
});
