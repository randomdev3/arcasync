/**
 * R2 chunk routes (P2-4), mounted at `/api/chunks`. Auth is the workspace WS-JWT, verified here
 * (D6: no AccountsDO call per chunk). Keys are `ws/<workspaceId>/<sha256>` (D7).
 *
 * Bodies are streamed straight into R2: the Worker never reads or hashes them. R2 verifies the
 * `sha256` and refuses an existing key through `onlyIf` (`created: false`).
 */
import { CHUNK_BYTES, ChunkSha, ChunksMissingRequest } from "@teamsync/shared";
import { type Context, Hono } from "hono";
import type { Env } from "./env";
import { errorBody } from "./errors";
import { chunkPrefix, requireWsJwt } from "./wsAuth";

type Ctx = Context<{ Bindings: Env }>;

const fail = (c: Ctx, status: 400 | 403 | 404 | 411 | 413 | 503, code: string, message: string) =>
	c.json(errorBody(code, message), status);
const unavailable = (c: Ctx) => fail(c, 503, "chunks_unavailable", "No chunk storage configured");

/**
 * R2's checksum refusal. Local emulation throws "put: The SHA-256 checksum you specified did not
 * match what we received."; the R2 API documents the same error as code 10037.
 */
function isChecksumError(err: unknown): boolean {
	const message = String((err as { message?: unknown } | null)?.message ?? err);
	return /\(10037\)|checksum you specified did not match/i.test(message);
}

export const chunks = new Hono<{ Bindings: Env }>();

chunks.put("/:sha", async (c) => {
	const claims = await requireWsJwt(c);
	if (claims instanceof Response) return claims;
	const sha = c.req.param("sha");
	if (!ChunkSha.safeParse(sha).success) return fail(c, 400, "bad_request", "Invalid chunk sha");
	if (claims.role === "viewer") return fail(c, 403, "forbidden", "Viewers cannot upload");
	const length = c.req.header("content-length");
	if (length === undefined || !/^\d+$/.test(length)) {
		return fail(c, 411, "length_required", "Content-Length is required");
	}
	if (Number(length) > CHUNK_BYTES) {
		return fail(c, 413, "too_large", `A chunk is at most ${CHUNK_BYTES} bytes`);
	}
	const bucket = c.env.CHUNKS;
	if (!bucket) return unavailable(c);
	try {
		const stored = await bucket.put(chunkPrefix(claims.ws) + sha, c.req.raw.body, {
			sha256: sha,
			onlyIf: { etagDoesNotMatch: "*" },
			httpMetadata: { contentType: "application/octet-stream" },
		});
		return c.json({ created: stored !== null });
	} catch (err) {
		if (isChecksumError(err)) {
			return fail(c, 400, "checksum_mismatch", "The body does not match its sha256");
		}
		throw err;
	}
});

chunks.post("/missing", async (c) => {
	const claims = await requireWsJwt(c);
	if (claims instanceof Response) return claims;
	let raw: unknown;
	try {
		raw = await c.req.json();
	} catch {
		raw = undefined;
	}
	const body = ChunksMissingRequest.safeParse(raw);
	if (!body.success) return fail(c, 400, "bad_request", "Invalid request");
	const bucket = c.env.CHUNKS;
	if (!bucket) return unavailable(c);
	const prefix = chunkPrefix(claims.ws);
	const heads = await Promise.all(body.data.shas.map((sha) => bucket.head(prefix + sha)));
	return c.json({ missing: body.data.shas.filter((_, i) => heads[i] === null) });
});

chunks.get("/:sha", async (c) => {
	const claims = await requireWsJwt(c);
	if (claims instanceof Response) return claims;
	const sha = c.req.param("sha");
	if (!ChunkSha.safeParse(sha).success) return fail(c, 400, "bad_request", "Invalid chunk sha");
	const bucket = c.env.CHUNKS;
	if (!bucket) return unavailable(c);
	const obj = await bucket.get(chunkPrefix(claims.ws) + sha);
	if (!obj) return fail(c, 404, "not_found", "No such chunk");
	return new Response(obj.body, {
		headers: {
			"content-type": "application/octet-stream",
			"content-length": String(obj.size),
			etag: obj.httpEtag,
			"cache-control": "private, max-age=31536000, immutable",
		},
	});
});
