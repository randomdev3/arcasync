import { encodeClone } from "@arcasync/shared";
import { afterEach, describe, expect, it } from "vitest";
import {
	type RequestUrlParam,
	type RequestUrlResponse,
	requestUrlMock,
} from "../__mocks__/obsidian";
import { CloneClient } from "../net/CloneClient";

const defaultImpl = requestUrlMock.impl;
afterEach(() => {
	requestUrlMock.impl = defaultImpl;
});

function response(status: number, body: Uint8Array, headers: Record<string, string> = {}) {
	return {
		status,
		headers,
		arrayBuffer: body.slice().buffer,
		json: status >= 400 ? { error: { code: "rate_limited", message: "slow down" } } : {},
		text: "",
	} satisfies RequestUrlResponse;
}

function client(waits: number[] = []) {
	return new CloneClient({
		auth: { baseUrl: () => "http://relay.test", token: async () => "jwt", invalidate: () => {} },
		workspaceId: "ws1",
		sleep: async (ms) => {
			waits.push(ms);
		},
	});
}

const DOC = (id: string) => `ws:ws1:md:${id}`;

describe("CloneClient", () => {
	it("posts the docs (with base64 state vectors) and decodes entries and remaining", async () => {
		const calls: RequestUrlParam[] = [];
		const body = encodeClone([{ doc: DOC("a"), update: new Uint8Array([1, 2, 3]) }], [DOC("b")]);
		requestUrlMock.impl = async (param) => {
			calls.push(param);
			return response(200, body);
		};

		const result = await client().clone([
			{ doc: DOC("a") },
			{ doc: DOC("b"), sv: new Uint8Array([0, 255]) },
		]);

		expect(calls[0]).toMatchObject({
			url: "http://relay.test/api/workspaces/ws1/docs",
			method: "POST",
			contentType: "application/json",
			headers: { Authorization: "Bearer jwt" },
		});
		expect(JSON.parse(calls[0]?.body as string)).toEqual({
			docs: [{ doc: DOC("a") }, { doc: DOC("b"), sv: "AP8=" }],
		});
		expect(result.entries).toEqual([{ doc: DOC("a"), update: new Uint8Array([1, 2, 3]) }]);
		expect(result.remaining).toEqual([DOC("b")]);
	});

	it("waits out a 429 (Retry-After, at least 1 s) and gives up after 3 attempts", async () => {
		const waits: number[] = [];
		const statuses: number[] = [];
		const ok = encodeClone([], []);
		const queue = [
			response(429, new Uint8Array(), { "retry-after": "4" }),
			response(429, new Uint8Array(), { "Retry-After": "0" }),
			response(200, ok),
		];
		requestUrlMock.impl = async () => {
			const next = queue.shift() ?? response(429, new Uint8Array());
			statuses.push(next.status);
			return next;
		};
		await expect(client(waits).clone([{ doc: DOC("a") }])).resolves.toEqual({
			entries: [],
			remaining: [],
		});
		expect(waits).toEqual([4000, 1000]);

		requestUrlMock.impl = async () => response(429, new Uint8Array(), { "retry-after": "1" });
		await expect(client().clone([{ doc: DOC("a") }])).rejects.toMatchObject({
			status: 429,
			code: "rate_limited",
		});
	});

	it("does not retry a 400", async () => {
		let calls = 0;
		requestUrlMock.impl = async () => {
			calls++;
			return response(400, new Uint8Array());
		};
		await expect(client().clone([{ doc: DOC("a") }])).rejects.toMatchObject({ status: 400 });
		expect(calls).toBe(1);
	});
});
