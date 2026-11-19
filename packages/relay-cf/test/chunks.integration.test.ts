/**
 * P2-4 chunk routes against `wrangler dev --env dev` with local R2: streamed PUT with the
 * `sha256` and `onlyIf` checks left to R2, GET, `missing`, roles and per-workspace keys (D7).
 */
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CHUNK_BYTES, CHUNKS_MISSING_MAX, ServerInfo } from "@arcasync/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startRelayDev } from "../scripts/dev-server.mjs";
import {
	debugChunks,
	errorCode,
	get,
	getChunk,
	loginTo,
	putChunk,
	request,
	sha256Hex,
} from "./helpers";

const PORT = 27_000 + Math.floor(Math.random() * 400);

type Relay = { url: string; stop: () => Promise<void> };
let relay: Relay;
let dir: string;
/** alice owns `chunks-a` and `chunks-b`; vic is a viewer of `chunks-a`. */
let a: { workspaceId: string; jwt: string; session: string };
let b: { workspaceId: string; jwt: string };
let viewer: string;

const MiB = 1024 * 1024;
const blob = randomBytes(3 * MiB);
const blobSha = sha256Hex(blob);

beforeAll(async () => {
	dir = mkdtempSync(join(tmpdir(), "relay-chunks-"));
	relay = await startRelayDev({ port: PORT, persistTo: dir });
	const inA = await loginTo(relay.url, "alice", "chunks-a");
	const inB = await loginTo(relay.url, "alice", "chunks-b");
	const vic = await loginTo(relay.url, "vic", "chunks-a", "viewer");
	a = { workspaceId: inA.workspaceId, jwt: await inA.token(), session: inA.session.sessionToken };
	b = { workspaceId: inB.workspaceId, jwt: await inB.token() };
	viewer = await vic.token();
});

afterAll(async () => {
	await relay?.stop();
	rmSync(dir, { recursive: true, force: true });
});

/** A PUT without Content-Length (chunked transfer encoding), which `fetch` cannot send. */
function putChunked(sha: string, jwt: string): Promise<number> {
	return new Promise((resolve, reject) => {
		const url = new URL(`${relay.url}/api/chunks/${sha}`);
		const req = http.request(
			{
				hostname: url.hostname,
				port: url.port,
				path: url.pathname,
				method: "PUT",
				headers: { authorization: `Bearer ${jwt}`, "transfer-encoding": "chunked" },
			},
			(res) => {
				res.resume();
				res.on("end", () => resolve(res.statusCode ?? 0));
			},
		);
		req.on("error", reject);
		req.write(blob.subarray(0, 1024));
		req.end();
	});
}

const missing = (jwt: string, shas: string[]) =>
	request(relay.url, "POST", "/api/chunks/missing", { body: { shas }, token: jwt });

describe("chunks", () => {
	it("advertises features.chunks", async () => {
		const info = ServerInfo.parse(await get(relay.url, "/api/server-info"));
		expect(info.features.chunks).toBe(true);
	});

	it("stores a 3 MiB chunk once and serves it byte-identical", async () => {
		expect(await putChunk(relay.url, a.jwt, blobSha, blob)).toEqual({
			status: 200,
			body: { created: true },
		});
		const got = await getChunk(relay.url, a.jwt, blobSha);
		expect(got.status).toBe(200);
		expect(got.headers.get("content-type")).toBe("application/octet-stream");
		expect(got.headers.get("content-length")).toBe(String(blob.length));
		expect(got.headers.get("cache-control")).toBe("private, max-age=31536000, immutable");
		expect(got.headers.get("etag")).toBeTruthy();
		expect(Buffer.from(got.bytes).equals(blob)).toBe(true);

		// `onlyIf` is honoured by local R2: the second PUT stores nothing.
		expect(await putChunk(relay.url, a.jwt, blobSha, blob)).toEqual({
			status: 200,
			body: { created: false },
		});
		const objects = await debugChunks(relay.url, a.workspaceId);
		expect(objects).toEqual([
			{ key: `ws/${a.workspaceId}/${blobSha}`, size: blob.length, uploaded: expect.any(Number) },
		]);
	});

	it("refuses a body that does not match its sha (R2 verifies sha256 locally)", async () => {
		const wrong = sha256Hex(randomBytes(16));
		const res = await putChunk(relay.url, a.jwt, wrong, blob.subarray(0, 4096));
		expect(res.status).toBe(400);
		expect(errorCode(res.body)).toBe("checksum_mismatch");
		expect((await getChunk(relay.url, a.jwt, wrong)).status).toBe(404);
		expect(await debugChunks(relay.url, a.workspaceId)).toHaveLength(1);
	});

	it("requires Content-Length and caps a chunk at CHUNK_BYTES", async () => {
		expect(await putChunked(blobSha, a.jwt)).toBe(411);
		const big = randomBytes(CHUNK_BYTES + 1);
		const res = await putChunk(relay.url, a.jwt, sha256Hex(big), big);
		expect(res.status).toBe(413);
		const exact = randomBytes(CHUNK_BYTES);
		expect((await putChunk(relay.url, a.jwt, sha256Hex(exact), exact)).body).toEqual({
			created: true,
		});
	});

	it("authenticates with the workspace JWT only", async () => {
		expect((await getChunk(relay.url, "", blobSha)).status).toBe(401);
		// The session token is not a chunk credential.
		expect((await getChunk(relay.url, a.session, blobSha)).status).toBe(401);
		expect((await putChunk(relay.url, a.session, blobSha, blob)).status).toBe(401);
		expect((await missing(a.session, [blobSha])).status).toBe(401);
		expect((await getChunk(relay.url, a.jwt, "not-a-sha")).status).toBe(400);
	});

	it("lets viewers read but not upload", async () => {
		const small = randomBytes(1000);
		const res = await putChunk(relay.url, viewer, sha256Hex(small), small);
		expect(res.status).toBe(403);
		const got = await getChunk(relay.url, viewer, blobSha);
		expect(got.status).toBe(200);
		expect(Buffer.from(got.bytes).equals(blob)).toBe(true);
		expect(await missing(viewer, [blobSha])).toEqual({ status: 200, body: { missing: [] } });
	});

	it("keeps workspaces apart", async () => {
		expect((await getChunk(relay.url, b.jwt, blobSha)).status).toBe(404);
		expect((await missing(b.jwt, [blobSha])).body).toEqual({ missing: [blobSha] });
		expect(await debugChunks(relay.url, b.workspaceId)).toEqual([]);
	});

	it("missing: lists exactly the absent shas, at most CHUNKS_MISSING_MAX per call", async () => {
		const absent = [sha256Hex(randomBytes(8)), sha256Hex(randomBytes(8))];
		const res = await missing(a.jwt, [absent[0] as string, blobSha, absent[1] as string]);
		expect(res).toEqual({ status: 200, body: { missing: absent } });
		const tooMany = Array.from({ length: CHUNKS_MISSING_MAX + 1 }, () => sha256Hex(randomBytes(8)));
		expect((await missing(a.jwt, tooMany)).status).toBe(400);
		expect((await missing(a.jwt, ["nope"])).status).toBe(400);
	});
});
