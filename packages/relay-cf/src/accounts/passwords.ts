/**
 * Password hashing: PBKDF2-HMAC-SHA256 over `pepper:password` (NFC), with a 16-byte random salt.
 * Cloudflare's production runtime refuses a single PBKDF2 call above 100 000 iterations (local
 * workerd does not), so the work is `rounds` chained calls of `iterations` each: round n's
 * 32-byte output is round n+1's password. Both numbers are stored per row so the cost can be
 * raised later; verification uses the row's own.
 */
import { normalizePassword } from "@arcasync/shared";
import { constantTimeEqual } from "./tokens";

/** The most a single PBKDF2 call may run in production Workers. */
export const PBKDF2_MAX_ITERATIONS = 100_000;
/**
 * 7 × 100 000 = 700 000 iterations: about 45 ms of CPU per hash in local workerd on an Apple M
 * series (measured 2026-11-19; see docs/deploy-cloudflare.md). Run in AccountsDO, never in the
 * Worker (10 ms CPU on the free plan).
 */
export const PASSWORD_ROUNDS = 7;
export const PASSWORD_ITERATIONS = PBKDF2_MAX_ITERATIONS;

export interface PasswordHash {
	/** Hex, 32 bytes. */
	hash: string;
	/** Hex, 16 bytes. */
	salt: string;
	/** Per PBKDF2 call; never above `PBKDF2_MAX_ITERATIONS`. */
	iterations: number;
	rounds: number;
}

const encoder = new TextEncoder();

function hex(data: Uint8Array): string {
	return [...data].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function fromHex(value: string): Uint8Array {
	const out = new Uint8Array(value.length / 2);
	for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(value.slice(i * 2, i * 2 + 2), 16);
	return out;
}

/** The chained derivation; `pbkdf2` is injectable so tests can see every call. */
export async function derive(
	input: Uint8Array,
	salt: Uint8Array,
	iterations: number,
	rounds: number,
	pbkdf2: (
		password: Uint8Array,
		salt: Uint8Array,
		iterations: number,
	) => Promise<Uint8Array> = webPbkdf2,
): Promise<Uint8Array> {
	if (!(Number.isInteger(iterations) && iterations >= 1 && iterations <= PBKDF2_MAX_ITERATIONS)) {
		throw new Error(`PBKDF2 iterations must be 1–${PBKDF2_MAX_ITERATIONS} per call`);
	}
	if (!(Number.isInteger(rounds) && rounds >= 1)) throw new Error("PBKDF2 rounds must be ≥ 1");
	let bits = input;
	for (let r = 0; r < rounds; r++) bits = await pbkdf2(bits, salt, iterations);
	return bits;
}

async function webPbkdf2(
	password: Uint8Array,
	salt: Uint8Array,
	iterations: number,
): Promise<Uint8Array> {
	const key = await crypto.subtle.importKey(
		"raw",
		password as Uint8Array<ArrayBuffer>,
		"PBKDF2",
		false,
		["deriveBits"],
	);
	const bits = await crypto.subtle.deriveBits(
		{ name: "PBKDF2", hash: "SHA-256", salt: salt as Uint8Array<ArrayBuffer>, iterations },
		key,
		256,
	);
	return new Uint8Array(bits);
}

const material = (pepper: string, password: string) =>
	encoder.encode(`${pepper}:${normalizePassword(password)}`);

export async function hashPassword(
	pepper: string,
	password: string,
	{ iterations = PASSWORD_ITERATIONS, rounds = PASSWORD_ROUNDS } = {},
): Promise<PasswordHash> {
	const salt = crypto.getRandomValues(new Uint8Array(16));
	const hash = await derive(material(pepper, password), salt, iterations, rounds);
	return { hash: hex(hash), salt: hex(salt), iterations, rounds };
}

/** Constant-time comparison against a stored hash, with the row's own cost parameters. */
export async function verifyPassword(
	pepper: string,
	password: string,
	stored: PasswordHash,
): Promise<boolean> {
	const hash = await derive(
		material(pepper, password),
		fromHex(stored.salt),
		stored.iterations,
		stored.rounds,
	);
	return constantTimeEqual(hash, fromHex(stored.hash));
}

/**
 * Burns the same work as a real verification, for an unknown name or an account without a
 * password, so timing does not tell which names exist.
 */
export async function dummyVerify(pepper: string, password: string): Promise<false> {
	await derive(
		material(pepper, password),
		new Uint8Array(16),
		PASSWORD_ITERATIONS,
		PASSWORD_ROUNDS,
	);
	return false;
}
