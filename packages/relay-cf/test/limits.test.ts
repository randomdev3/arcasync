import { describe, expect, it } from "vitest";
import {
	LOGIN_IP_LIMIT,
	LOGIN_NAME_LIMIT,
	MINUTE_MS,
	nameKey,
	PIN_GLOBAL_LIMIT,
	PIN_IP_LIMIT,
	retryAfter,
} from "../src/accounts/limits";
import { newPin, randomPin } from "../src/accounts/pins";

describe("limits", () => {
	it("match the spec", () => {
		expect(PIN_IP_LIMIT).toEqual({ max: 5, windowMs: 15 * MINUTE_MS });
		expect(PIN_GLOBAL_LIMIT).toEqual({ max: 500, windowMs: 24 * 60 * MINUTE_MS });
		expect(LOGIN_NAME_LIMIT).toEqual({ max: 5, windowMs: 15 * MINUTE_MS });
		expect(LOGIN_IP_LIMIT).toEqual({ max: 20, windowMs: 15 * MINUTE_MS });
	});

	it("retryAfter is null below the max, else seconds until a slot frees", () => {
		const now = 10_000_000;
		const limit = { max: 3, windowMs: 60_000 };
		expect(retryAfter([], now, limit)).toBeNull();
		expect(retryAfter([now - 1000, now - 2000], now, limit)).toBeNull();
		// Oldest counted of the newest three: now - 50 s → frees in 10 s.
		expect(retryAfter([now - 1000, now - 2000, now - 50_000], now, limit)).toBe(10);
		// Entries outside the window do not count.
		expect(retryAfter([now - 1000, now - 2000, now - 60_000], now, limit)).toBeNull();
		// More than max: the wait is for the max-th newest.
		expect(retryAfter([now - 1, now - 2, now - 30_000, now - 55_000], now, limit)).toBe(30);
		// Never 0.
		expect(retryAfter([now, now, now - 59_999], now, limit)).toBe(1);
	});

	it("nameKey folds case beyond ASCII and normalises to NFC", () => {
		expect(nameKey("Dave")).toBe("dave");
		expect(nameKey("ÉMILE")).toBe(nameKey("émile"));
	});
});

describe("pins", () => {
	it("are six digits", () => {
		for (let i = 0; i < 500; i++) expect(randomPin()).toMatch(/^[0-9]{6}$/);
	});

	it("are roughly uniform over the first digit", () => {
		const counts = Array(10).fill(0);
		const n = 20_000;
		for (let i = 0; i < n; i++) counts[Number(randomPin()[0])] += 1;
		for (const c of counts) expect(Math.abs(c - n / 10)).toBeLessThan(n / 10 / 5);
	});

	it("newPin skips taken PINs and gives up when all are taken", () => {
		const taken = new Set<string>();
		for (let i = 0; i < 100; i++) {
			const pin = newPin((p) => taken.has(p));
			expect(pin).not.toBeNull();
			expect(taken.has(pin as string)).toBe(false);
			taken.add(pin as string);
		}
		expect(newPin(() => true, 50)).toBeNull();
	});
});
