/**
 * The relay's password rules (`passwordProblem` in `@arcasync/shared`), copied so the browser
 * bundle has no zod; `passwords.test.ts` checks the copy against the shared package.
 */
export const PASSWORD_MIN_LENGTH = 10;
export const PASSWORD_MAX_LENGTH = 256;

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

/** Why `password` cannot be set, or null: 10–256 code points after NFC, not a common one. */
export function passwordProblem(password: string): string | null {
	const normalized = password.normalize("NFC");
	const length = [...normalized].length;
	if (length < PASSWORD_MIN_LENGTH) return `Use at least ${PASSWORD_MIN_LENGTH} characters.`;
	if (length > PASSWORD_MAX_LENGTH) return `Use at most ${PASSWORD_MAX_LENGTH} characters.`;
	if (COMMON_PASSWORDS.includes(normalized.toLowerCase())) {
		return "That password is too common. Pick another.";
	}
	return null;
}

/** A 4- or 6-digit PIN (spaces and dashes ignored), or null. New PINs have 6 digits. */
export function normalizePin(input: string): string | null {
	const digits = input.replace(/[\s-]/g, "");
	return /^[0-9]{4}([0-9]{2})?$/.test(digits) ? digits : null;
}
