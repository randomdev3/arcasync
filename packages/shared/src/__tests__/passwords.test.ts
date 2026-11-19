import { describe, expect, it } from "vitest";
import { COMMON_PASSWORDS, normalizePassword, passwordProblem } from "../passwords.js";
import { LoginRequest, PasswordChangeRequest, Pin, PinCreateRequest } from "../protocol.js";

describe("passwordProblem", () => {
	it("accepts 10 to 256 code points", () => {
		expect(passwordProblem("a".repeat(10))).toBeNull();
		expect(passwordProblem("a".repeat(256))).toBeNull();
		expect(passwordProblem("a".repeat(9))).toMatch(/at least 10/);
		expect(passwordProblem("a".repeat(257))).toMatch(/at most 256/);
	});

	it("counts code points after NFC, not UTF-16 units", () => {
		// 10 astral characters are 20 UTF-16 units; 9 are too few.
		expect(passwordProblem("😀".repeat(9))).toMatch(/at least/);
		expect(passwordProblem("😀".repeat(10))).toBeNull();
		// "e" + combining acute is two code points, one after NFC: 8 of them + "x" is 9.
		const decomposed = `${"e\u0301".repeat(8)}x`;
		expect([...decomposed].length).toBe(17);
		expect(passwordProblem(decomposed)).toMatch(/at least/);
		expect(passwordProblem(`${decomposed}y`)).toBeNull();
		expect(normalizePassword("e\u0301")).toBe("\u00e9");
	});

	it("rejects the common list case-insensitively and has 20 entries of length ≥ 10", () => {
		expect(COMMON_PASSWORDS).toHaveLength(20);
		for (const p of COMMON_PASSWORDS) expect([...p].length).toBeGreaterThanOrEqual(10);
		expect(passwordProblem("Password123")).toMatch(/common/);
		expect(passwordProblem("QWERTYUIOP")).toMatch(/common/);
		expect(passwordProblem("correct horse battery")).toBeNull();
	});
});

describe("schemas", () => {
	it("Pin is exactly four digits", () => {
		expect(Pin.safeParse("0042").success).toBe(true);
		for (const bad of ["042", "12345", "12a4", " 1234", 1234]) {
			expect(Pin.safeParse(bad).success).toBe(false);
		}
	});

	it("sign-in passwords are only bounded, not rule-checked", () => {
		const device = { name: "d", platform: "macos", vaultId: "v" };
		expect(LoginRequest.safeParse({ name: "a", password: "short", device }).success).toBe(true);
		expect(LoginRequest.safeParse({ name: "a", password: "x".repeat(1025), device }).success).toBe(
			false,
		);
		expect(PasswordChangeRequest.parse({ new: "x" })).toEqual({ new: "x" });
	});

	it("PIN create defaults to 72 h, no admin, and caps at 30 days", () => {
		expect(PinCreateRequest.parse({ role: "editor" })).toEqual({
			role: "editor",
			admin: false,
			expiresInSec: 259_200,
		});
		expect(PinCreateRequest.safeParse({ role: "editor", expiresInSec: 2_592_001 }).success).toBe(
			false,
		);
	});
});
