import { describe, expect, it } from "vitest";
import {
	derive,
	dummyVerify,
	hashPassword,
	PASSWORD_ITERATIONS,
	PASSWORD_ROUNDS,
	PBKDF2_MAX_ITERATIONS,
	verifyPassword,
} from "../src/accounts/passwords";

const PEPPER = "test-pepper";
/** Fast parameters for behaviour tests; the shipped cost is checked separately. */
const CHEAP = { iterations: 1000, rounds: 2 };

describe("password hashing", () => {
	it("never asks PBKDF2 for more than the production cap in one call", async () => {
		expect(PASSWORD_ITERATIONS).toBeLessThanOrEqual(PBKDF2_MAX_ITERATIONS);
		expect(PBKDF2_MAX_ITERATIONS).toBe(100_000);
		const calls: number[] = [];
		await derive(
			new Uint8Array([1]),
			new Uint8Array(16),
			PASSWORD_ITERATIONS,
			PASSWORD_ROUNDS,
			async (p, _s, n) => {
				calls.push(n);
				return p;
			},
		);
		expect(calls).toEqual(Array(PASSWORD_ROUNDS).fill(PASSWORD_ITERATIONS));
		expect(PASSWORD_ROUNDS * PASSWORD_ITERATIONS).toBe(600_000);
		await expect(derive(new Uint8Array([1]), new Uint8Array(16), 100_001, 1)).rejects.toThrow(
			/iterations/,
		);
	});

	it("chains rounds: round n's output is round n+1's password", async () => {
		const seen: number[][] = [];
		await derive(new Uint8Array([7]), new Uint8Array(16), 5, 3, async (p) => {
			seen.push([...p]);
			return new Uint8Array([p[0] ?? 0, seen.length]);
		});
		expect(seen).toEqual([[7], [7, 1], [7, 2]]);
	});

	it("verifies the right password only, with a fresh 16-byte salt each time", async () => {
		const a = await hashPassword(PEPPER, "correct horse battery", CHEAP);
		const b = await hashPassword(PEPPER, "correct horse battery", CHEAP);
		expect(a.salt).toMatch(/^[0-9a-f]{32}$/);
		expect(a.hash).toMatch(/^[0-9a-f]{64}$/);
		expect(a.salt).not.toBe(b.salt);
		expect(a.hash).not.toBe(b.hash);
		expect(a).toMatchObject(CHEAP);
		expect(await verifyPassword(PEPPER, "correct horse battery", a)).toBe(true);
		expect(await verifyPassword(PEPPER, "correct horse batterY", a)).toBe(false);
		expect(await verifyPassword("other-pepper", "correct horse battery", a)).toBe(false);
	});

	it("normalises to NFC before hashing", async () => {
		const h = await hashPassword(PEPPER, "café-password", CHEAP);
		expect(await verifyPassword(PEPPER, "café-password", h)).toBe(true);
	});

	it("verifies with the row's own cost, so it can be raised later", async () => {
		const h = await hashPassword(PEPPER, "correct horse battery", { iterations: 10, rounds: 1 });
		expect(await verifyPassword(PEPPER, "correct horse battery", h)).toBe(true);
		expect(await verifyPassword(PEPPER, "correct horse battery", { ...h, rounds: 2 })).toBe(false);
	});

	it("dummyVerify is always false", async () => {
		expect(await dummyVerify(PEPPER, "anything")).toBe(false);
	});
});
