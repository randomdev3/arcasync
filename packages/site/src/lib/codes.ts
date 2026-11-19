/**
 * Copies of relay constants the browser needs, so nothing from `@arcasync/shared` (zod, yjs) is
 * bundled. `codes.test.ts` checks them against the shared package and the relay's behaviour.
 */
export const USER_CODE_ALPHABET = "BCDFGHJKLMNPQRSTVWXZ";
export const DEVICE_CODE_INTERVAL_S = 5;
export const DEVICE_CODE_TTL_S = 600;

/**
 * The relay's `normalizeUserCode`: uppercase, letters only, 8 from the alphabet, `XXXX-XXXX`.
 * `bcdf ghjk`, `BCDFGHJK` and `BCDF-GHJK` are the same code; anything else is null.
 */
export function normalizeUserCode(input: string): string | null {
	const letters = input.toUpperCase().replace(/[^A-Z]/g, "");
	if (letters.length !== 8) return null;
	for (const c of letters) if (!USER_CODE_ALPHABET.includes(c)) return null;
	return `${letters.slice(0, 4)}-${letters.slice(4)}`;
}

/** "BCDF-GHJK" → "B C D F, G H J K", so screen readers spell the code. */
export function spellCode(code: string): string {
	return code
		.split("-")
		.map((part) => part.split("").join(" "))
		.join(", ");
}

/** Milliseconds → "m:ss" (never negative). */
export function formatRemaining(ms: number): string {
	const s = Math.max(0, Math.ceil(ms / 1000));
	return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}
