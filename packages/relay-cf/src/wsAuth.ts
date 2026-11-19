/**
 * Bearer auth with the workspace WS-JWT (D6) for REST routes that skip AccountsDO: chunk routes
 * verify it in the Worker, files listing and bulk clone in the workspace's DO.
 */
import type { Context } from "hono";
import { errorBody } from "./errors";
import { verifyWsToken, type WsClaims } from "./jwt";

/** The claims of a valid `Authorization: Bearer <ws-jwt>`, or null. */
export async function bearerClaims(
	header: string | null | undefined,
	secret: string,
): Promise<WsClaims | null> {
	const [scheme, value] = (header ?? "").split(" ");
	if (scheme?.toLowerCase() !== "bearer" || !value) return null;
	try {
		return await verifyWsToken(value.trim(), secret);
	} catch {
		return null;
	}
}

/** The verified claims, or the 401 to answer. */
export async function requireWsJwt<E extends { TEAMSYNC_SECRET: string }>(
	c: Context<{ Bindings: E }>,
): Promise<WsClaims | Response> {
	const claims = await bearerClaims(c.req.header("authorization"), c.env.TEAMSYNC_SECRET);
	return claims ?? c.json(errorBody("unauthorized", "Missing or invalid workspace token"), 401);
}

/** R2 key prefix of a workspace's chunks (D7): `ws/<workspaceId>/<sha256>`. */
export const chunkPrefix = (workspaceId: string) => `ws/${workspaceId}/`;
