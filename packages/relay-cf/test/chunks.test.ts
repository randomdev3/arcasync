/**
 * Chunk routes without an R2 binding (`env.probe`, which has no local env to start): 503
 * `chunks_unavailable`, and `/server-info` reports `features.chunks === false`.
 */
import { CHUNK_BYTES } from "@arcasync/shared";
import { describe, expect, it } from "vitest";
import { signWsToken } from "../src/jwt";
import { serverInfo } from "../src/serverInfo";

const SECRET = "chunks-unit-test-secret";
const SHA = "a".repeat(64);

interface App {
	request(path: string, init: RequestInit, env: unknown): Promise<Response>;
}

/**
 * `src/chunks.ts` imports the Workers-typed `Env`, which this Node/DOM test program cannot type;
 * a non-literal specifier keeps tsc out of it while vitest still loads it.
 */
async function chunksApp(): Promise<App> {
	const path = "../src/chunks";
	return ((await import(/* @vite-ignore */ path)) as { chunks: App }).chunks;
}

async function token(role: "editor" | "viewer" = "editor") {
	return (await signWsToken({ userId: "u1", workspaceId: "w1", role, deviceId: "d1" }, SECRET))
		.token;
}

const env = { ARCASYNC_SECRET: SECRET, CHUNKS: undefined };

describe("chunk routes without R2", () => {
	it("answer 503 chunks_unavailable once auth and the request are valid", async () => {
		const app = await chunksApp();
		const auth = { authorization: `Bearer ${await token()}` };
		const put = await app.request(
			`/${SHA}`,
			{ method: "PUT", headers: { ...auth, "content-length": "3" }, body: "abc" },
			env,
		);
		expect(put.status).toBe(503);
		expect(await put.json()).toMatchObject({ error: { code: "chunks_unavailable" } });
		const get = await app.request(`/${SHA}`, { headers: auth }, env);
		expect(get.status).toBe(503);
		const missing = await app.request(
			"/missing",
			{
				method: "POST",
				headers: { ...auth, "content-type": "application/json" },
				body: JSON.stringify({ shas: [SHA] }),
			},
			env,
		);
		expect(missing.status).toBe(503);
	});

	it("checks auth, sha, role and length before the binding", async () => {
		const app = await chunksApp();
		const put = (path: string, headers: Record<string, string>) =>
			app.request(path, { method: "PUT", headers, body: "abc" }, env);
		const auth = { authorization: `Bearer ${await token()}` };
		expect((await put(`/${SHA}`, { "content-length": "3" })).status).toBe(401);
		expect((await put("/not-a-sha", { ...auth, "content-length": "3" })).status).toBe(400);
		const viewer = { authorization: `Bearer ${await token("viewer")}`, "content-length": "3" };
		expect((await put(`/${SHA}`, viewer)).status).toBe(403);
		const big = { ...auth, "content-length": String(CHUNK_BYTES + 1) };
		expect((await put(`/${SHA}`, big)).status).toBe(413);
	});
});

describe("/server-info", () => {
	const base = { ARCASYNC_DEV_OPEN_LOGIN: "0", ARCASYNC_MAX_FILE_BYTES: "209715200" };

	it("advertises chunks only with an R2 binding", () => {
		expect(serverInfo(base, "https://relay.example").features.chunks).toBe(false);
		expect(serverInfo({ ...base, CHUNKS: {} }, "https://relay.example").features.chunks).toBe(true);
	});
});
