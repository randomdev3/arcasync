import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { Role } from "@arcasync/shared";
import { WS_TOKEN_TTL_SECONDS } from "@arcasync/shared";
import { jwtVerify, SignJWT } from "jose";
import { z } from "zod";

export const SESSION_TTL_SECONDS = 90 * 24 * 60 * 60;

/** Opaque session token: 32 random bytes, base64url. Only its hash is stored. */
export function newOpaqueToken(): string {
	return randomBytes(32).toString("base64url");
}

/** SHA-256 of `<pepper>:<token>` — the value stored in `sessions.token_hash`. */
export function hashToken(token: string, pepper: string): string {
	return createHash("sha256").update(`${pepper}:${token}`).digest("hex");
}

export function constantTimeEqual(a: string, b: string): boolean {
	const ab = Buffer.from(a);
	const bb = Buffer.from(b);
	if (ab.length !== bb.length) return false;
	return timingSafeEqual(ab, bb);
}

export const WsClaims = z.object({
	sub: z.string(),
	ws: z.string(),
	role: z.enum(["owner", "editor", "viewer"]),
	dev: z.string(),
	exp: z.number().optional(),
});
export type WsClaims = z.infer<typeof WsClaims>;

const ISSUER = "arcasync";
const AUDIENCE = "arcasync-ws";

function key(secret: string): Uint8Array {
	return new TextEncoder().encode(secret);
}

export interface WsTokenInput {
	userId: string;
	workspaceId: string;
	role: Role;
	deviceId: string;
}

export async function signWsToken(
	input: WsTokenInput,
	secret: string,
	ttlSeconds: number = WS_TOKEN_TTL_SECONDS,
): Promise<{ token: string; expiresAt: number }> {
	const now = Math.floor(Date.now() / 1000);
	const exp = now + ttlSeconds;
	const token = await new SignJWT({ ws: input.workspaceId, role: input.role, dev: input.deviceId })
		.setProtectedHeader({ alg: "HS256" })
		.setSubject(input.userId)
		.setIssuer(ISSUER)
		.setAudience(AUDIENCE)
		.setIssuedAt(now)
		.setExpirationTime(exp)
		.sign(key(secret));
	return { token, expiresAt: exp * 1000 };
}

export async function verifyWsToken(token: string, secret: string): Promise<WsClaims> {
	const { payload } = await jwtVerify(token, key(secret), {
		issuer: ISSUER,
		audience: AUDIENCE,
		algorithms: ["HS256"],
	});
	return WsClaims.parse(payload);
}

const PALETTE = [
	"#e8534a",
	"#e88a34",
	"#d9b021",
	"#69b32d",
	"#2fae8f",
	"#2f90d0",
	"#5a6ee0",
	"#8f5ad8",
	"#d24fa8",
	"#c9575f",
];

/** Deterministic per-user colour so every client agrees without coordination. */
export function userColor(seed: string): string {
	const digest = createHash("sha256").update(seed).digest();
	const idx = digest[0] !== undefined ? digest[0] % PALETTE.length : 0;
	return PALETTE[idx] ?? "#2f90d0";
}
