/** HS256 WebSocket JWTs, claim-for-claim identical to `packages/server/src/auth/tokens.ts`. */
import type { Role } from "@teamsync/shared";
import { WS_TOKEN_TTL_SECONDS } from "@teamsync/shared";
import { jwtVerify, SignJWT } from "jose";
import { z } from "zod";

export const WsClaims = z.object({
	sub: z.string(),
	ws: z.string(),
	role: z.enum(["owner", "editor", "viewer"]),
	dev: z.string(),
	/** Seconds; the relay refuses a token issued at or before the user's last revocation (D5). */
	iat: z.number(),
	exp: z.number().optional(),
});
export type WsClaims = z.infer<typeof WsClaims>;

const ISSUER = "teamsync";
const AUDIENCE = "teamsync-ws";

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
