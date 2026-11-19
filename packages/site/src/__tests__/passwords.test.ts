import * as shared from "@arcasync/shared";
import { describe, expect, it } from "vitest";
import {
	COMMON_PASSWORDS,
	normalizePin,
	PASSWORD_MAX_LENGTH,
	PASSWORD_MIN_LENGTH,
	passwordProblem,
} from "../lib/passwords";

describe("site password rules", () => {
	it("are the shared package's", () => {
		expect(PASSWORD_MIN_LENGTH).toBe(shared.PASSWORD_MIN_LENGTH);
		expect(PASSWORD_MAX_LENGTH).toBe(shared.PASSWORD_MAX_LENGTH);
		expect(COMMON_PASSWORDS).toEqual(shared.COMMON_PASSWORDS);
		for (const p of ["short", "a".repeat(10), "a".repeat(257), "Password123", "é".repeat(9)]) {
			expect(passwordProblem(p) === null, p).toBe(shared.passwordProblem(p) === null);
		}
	});

	it("normalizePin takes four digits, ignoring spaces and dashes", () => {
		expect(normalizePin(" 04 20 ")).toBe("0420");
		expect(normalizePin("04-20")).toBe("0420");
		for (const bad of ["042", "04201", "o420", ""]) expect(normalizePin(bad)).toBeNull();
	});
});
