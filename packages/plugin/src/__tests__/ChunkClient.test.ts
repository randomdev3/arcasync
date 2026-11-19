import { sha256Hex } from "@arcasync/shared";
import { afterEach, describe, expect, it } from "vitest";
import {
	type RequestUrlParam,
	type RequestUrlResponse,
	requestUrlMock,
} from "../__mocks__/obsidian";
import { ChunkClient, ChunkNotFoundError } from "../files/ChunkClient";
import { ApiRequestError } from "../net/ApiClient";

const defaultImpl = requestUrlMock.impl;
afterEach(() => {
	requestUrlMock.impl = defaultImpl;
});

function response(
	status: number,
	{
		json = {},
		bytes = new Uint8Array(0),
		headers = {},
	}: { json?: unknown; bytes?: Uint8Array; headers?: Record<string, string> } = {},
): RequestUrlResponse {
	return {
		status,
		headers,
		arrayBuffer: bytes.slice().buffer,
		json,
		text: JSON.stringify(json),
	};
}

/** Answers each request with the next queued response (the last one repeats). */
function serve(...responses: Array<(param: RequestUrlParam) => RequestUrlResponse>) {
	const calls: RequestUrlParam[] = [];
	requestUrlMock.impl = async (param) => {
		calls.push(param);
		const next = responses.length > 1 ? responses.shift() : responses[0];
		if (!next) throw new Error("no response queued");
		return next(param);
	};
	return calls;
}

function client(waits: number[] = [], invalidated: string[] = []) {
	let n = 0;
	return new ChunkClient({
		auth: {
			baseUrl: () => "http://relay.test/",
			token: async () => `jwt${++n}`,
			invalidate: () => invalidated.push("ws"),
		},
		sleep: async (ms) => {
			waits.push(ms);
		},
	});
}

const sha = (i: number) => i.toString(16).padStart(64, "0");

describe("ChunkClient", () => {
	it("asks for missing chunks in batches of 40, with the workspace JWT", async () => {
		const calls = serve((param) => {
			const { shas } = JSON.parse(param.body as string) as { shas: string[] };
			return response(200, { json: { missing: shas.filter((_, i) => i % 2 === 0) } });
		});
		const shas = Array.from({ length: 85 }, (_, i) => sha(i));

		const missing = await client().missing([...shas, sha(0)]);

		expect(
			calls.map((c) => (JSON.parse(c.body as string) as { shas: string[] }).shas.length),
		).toEqual([40, 40, 5]);
		expect(calls[0]).toMatchObject({
			url: "http://relay.test/api/chunks/missing",
			method: "POST",
			contentType: "application/json",
		});
		expect(calls[0]?.headers?.Authorization).toMatch(/^Bearer jwt/);
		expect(missing).toHaveLength(43);
	});

	it("treats a PUT of an existing chunk (created: false) as a success", async () => {
		const calls = serve(() => response(200, { json: { created: false } }));
		const bytes = new Uint8Array([1, 2, 3, 4, 5]);

		await client().put(sha(1), bytes.subarray(1, 4));

		expect(calls[0]).toMatchObject({
			url: `http://relay.test/api/chunks/${sha(1)}`,
			method: "PUT",
			contentType: "application/octet-stream",
		});
		expect([...new Uint8Array(calls[0]?.body as ArrayBuffer)]).toEqual([2, 3, 4]);
	});

	it("retries 5xx and 429 after 1 s, 2 s and 4 s, then gives up", async () => {
		const waits: number[] = [];
		const calls = serve(
			() => response(503),
			() => response(429, { headers: { "Retry-After": "3" } }),
			() => response(500),
			() => response(502, { json: { error: { code: "bad_gateway", message: "down" } } }),
		);

		const error = await client(waits)
			.put(sha(2), new Uint8Array([1]))
			.catch((e: unknown) => e);

		expect(calls).toHaveLength(4);
		// The 429's Retry-After (3 s) is longer than its 2 s backoff.
		expect(waits).toEqual([1000, 3000, 4000]);
		expect(error).toBeInstanceOf(ApiRequestError);
		expect(error).toMatchObject({ status: 502, code: "bad_gateway" });
	});

	it("does not retry a 4xx, and re-mints the token once on 401", async () => {
		const invalidated: string[] = [];
		const calls = serve(
			() => response(401),
			() => response(403, { json: { error: { code: "forbidden", message: "viewer" } } }),
		);

		const error = await client([], invalidated)
			.put(sha(3), new Uint8Array([1]))
			.catch((e: unknown) => e);

		expect(calls.map((c) => c.headers?.Authorization)).toEqual(["Bearer jwt1", "Bearer jwt2"]);
		expect(invalidated).toEqual(["ws"]);
		expect(error).toMatchObject({ status: 403, code: "forbidden" });
	});

	it("GET verifies the sha256: a mismatch is fetched again, then fails", async () => {
		const good = new Uint8Array([9, 8, 7]);
		const goodSha = await sha256Hex(good);
		const bad = new Uint8Array([0]);

		serve(
			() => response(200, { bytes: bad }),
			() => response(200, { bytes: good }),
		);
		expect([...(await client().get(goodSha))]).toEqual([9, 8, 7]);

		const calls = serve(() => response(200, { bytes: bad }));
		await expect(client().get(goodSha)).rejects.toThrow(/does not match/);
		expect(calls).toHaveLength(2);
	});

	it("GET of a missing chunk throws ChunkNotFoundError without retrying", async () => {
		const calls = serve(() => response(404));
		await expect(client().get(sha(4))).rejects.toBeInstanceOf(ChunkNotFoundError);
		expect(calls).toHaveLength(1);
	});

	it("keeps at most two requests in flight", async () => {
		let inFlight = 0;
		let peak = 0;
		requestUrlMock.impl = async () => {
			inFlight++;
			peak = Math.max(peak, inFlight);
			await new Promise((r) => setTimeout(r, 5));
			inFlight--;
			return response(200, { json: { created: true } });
		};
		const c = client();
		await Promise.all(Array.from({ length: 6 }, (_, i) => c.put(sha(i), new Uint8Array([i]))));
		expect(peak).toBe(2);
	});
});
