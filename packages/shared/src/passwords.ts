import { PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH } from "./constants.js";

/**
 * Twenty of the most common breached passwords that are long enough to pass the length rule
 * (shorter ones, `123456` and friends, already fail it). Compared case-insensitively.
 */
export const COMMON_PASSWORDS: readonly string[] = [
	"1234567890",
	"0987654321",
	"1111111111",
	"0000000000",
	"1q2w3e4r5t",
	"qwertyuiop",
	"password123",
	"password1234",
	"password12",
	"qwerty1234",
	"qwerty12345",
	"qwerty123456",
	"1234512345",
	"1qaz2wsx3edc",
	"123456789a",
	"abcd123456",
	"iloveyou12",
	"1234567891",
	"12345678910",
	"123123123123",
];

/** The password as hashed and length-checked: Unicode NFC. */
export function normalizePassword(password: string): string {
	return password.normalize("NFC");
}

/**
 * Why `password` cannot be set (a sentence for the user), or null when it is acceptable: 10–256
 * code points after NFC, not one of `COMMON_PASSWORDS`. No composition rules.
 */
export function passwordProblem(password: string): string | null {
	const normalized = normalizePassword(password);
	const length = [...normalized].length;
	if (length < PASSWORD_MIN_LENGTH) {
		return `Use at least ${PASSWORD_MIN_LENGTH} characters`;
	}
	if (length > PASSWORD_MAX_LENGTH) return `Use at most ${PASSWORD_MAX_LENGTH} characters`;
	if (COMMON_PASSWORDS.includes(normalized.toLowerCase())) {
		return "That password is too common; pick another";
	}
	return null;
}
