import * as shared from "@arcasync/shared";
import { describe, expect, it } from "vitest";
import {
	DEVICE_CODE_INTERVAL_S,
	DEVICE_CODE_TTL_S,
	formatRemaining,
	normalizeUserCode,
	spellCode,
} from "../lib/codes";

describe("normalizeUserCode (the relay's tokens.ts behaviour)", () => {
	it("accepts the same code in any spacing or case", () => {
		for (const input of ["bcdf ghjk", "BCDFGHJK", "BCDF-GHJK", " bcdf-ghjk "]) {
			expect(normalizeUserCode(input), input).toBe("BCDF-GHJK");
		}
	});

	it("rejects vowels, short codes and lookalike digits", () => {
		for (const input of ["ABCD-EFGH", "BCDF-GHJ", "BCDF-GHJKL", "BCDF-GHJ0", ""]) {
			expect(normalizeUserCode(input), input).toBeNull();
		}
		// Digits are stripped like the relay does, which leaves too few letters.
		expect(normalizeUserCode("BCD1-GHJK")).toBeNull();
	});
});

describe("copied constants", () => {
	it("match @arcasync/shared", () => {
		expect(DEVICE_CODE_INTERVAL_S).toBe(shared.DEVICE_CODE_INTERVAL_S);
		expect(DEVICE_CODE_TTL_S).toBe(shared.DEVICE_CODE_TTL_S);
	});
});

describe("formatting", () => {
	it("spells a code for screen readers", () => {
		expect(spellCode("BCDF-GHJK")).toBe("B C D F, G H J K");
	});

	it("formats a countdown", () => {
		expect(formatRemaining(581_000)).toBe("9:41");
		expect(formatRemaining(-5)).toBe("0:00");
		expect(formatRemaining(1)).toBe("0:01");
	});
});
