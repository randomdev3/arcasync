/**
 * Opaque secrets (session tokens, invite tokens, device codes) and their stored hashes. Plain Web
 * Crypto, so the same code runs in workerd and under Node (unit tests).
 */

export async function sha256(input: string): Promise<Uint8Array> {
	return new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input)));
}

function hex(data: Uint8Array): string {
	return [...data].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** 32 random bytes, base64url without padding. */
export function newOpaqueToken(): string {
	const raw = crypto.getRandomValues(new Uint8Array(32));
	return btoa(String.fromCharCode(...raw))
		.replace(/\+/g, "-")
		.replace(/\//g, "_")
		.replace(/=+$/, "");
}

/** What is stored for a secret: `hex(sha256(pepper:value))`, the pepper being `ARCASYNC_SECRET`. */
export async function hashSecret(pepper: string, value: string): Promise<string> {
	return hex(await sha256(`${pepper}:${value}`));
}

export function constantTimeEqual(a: Uint8Array, b: Uint8Array): boolean {
	if (a.length !== b.length) return false;
	let diff = 0;
	for (let i = 0; i < a.length; i++) diff |= (a[i] ?? 0) ^ (b[i] ?? 0);
	return diff === 0;
}

/** Consonants only, so a code never spells a word and has no 0/O or 1/I confusion. */
export const USER_CODE_ALPHABET = "BCDFGHJKLMNPQRSTVWXZ";

/** 8 characters from `USER_CODE_ALPHABET`, formatted `XXXX-XXXX`. */
export function newUserCode(): string {
	const n = USER_CODE_ALPHABET.length;
	// Rejection sampling: bytes ≥ the largest multiple of n would bias the first letters.
	const limit = 256 - (256 % n);
	let out = "";
	while (out.length < 8) {
		for (const b of crypto.getRandomValues(new Uint8Array(16))) {
			if (b < limit && out.length < 8) out += USER_CODE_ALPHABET[b % n];
		}
	}
	return `${out.slice(0, 4)}-${out.slice(4)}`;
}

/** `bcdf ghjk`, `BCDFGHJK` and `BCDF-GHJK` all name the same code; anything else is null. */
export function normalizeUserCode(input: string): string | null {
	const letters = input.toUpperCase().replace(/[^A-Z]/g, "");
	if (letters.length !== 8) return null;
	for (const c of letters) if (!USER_CODE_ALPHABET.includes(c)) return null;
	return `${letters.slice(0, 4)}-${letters.slice(4)}`;
}
