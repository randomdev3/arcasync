import { afterEach, describe, expect, it } from "vitest";
import {
	type RequestUrlParam,
	type RequestUrlResponse,
	requestUrlMock,
} from "../__mocks__/obsidian";
import { ApiClient, ApiRequestError } from "../net/ApiClient";

const defaultImpl = requestUrlMock.impl;

function respond(status: number, json: unknown) {
	const calls: RequestUrlParam[] = [];
	requestUrlMock.impl = async (param): Promise<RequestUrlResponse> => {
		calls.push(param);
		return {
			status,
			headers: {},
			arrayBuffer: new ArrayBuffer(0),
			json,
			text: JSON.stringify(json),
		};
	};
	return calls;
}

function api(token: string | null = "session-token") {
	return new ApiClient({ getBaseUrl: () => "http://relay.test/", getSessionToken: () => token });
}

afterEach(() => {
	requestUrlMock.impl = defaultImpl;
});

describe("ApiClient", () => {
	it("unwraps the {workspaces: [...]} envelope of GET /api/workspaces", async () => {
		const workspace = { id: "ws1", slug: "dev", name: "dev", role: "owner" };
		const calls = respond(200, { workspaces: [workspace] });

		const workspaces = await api().workspaces();

		expect(Array.isArray(workspaces)).toBe(true);
		expect(workspaces).toEqual([workspace]);
		expect(calls[0]?.url).toBe("http://relay.test/api/workspaces");
		expect(calls[0]?.headers?.Authorization).toBe("Bearer session-token");
	});

	it("maps an error body to ApiRequestError", async () => {
		respond(403, { error: { code: "forbidden", message: "not a member" } });

		const error = await api()
			.workspaces()
			.catch((e: unknown) => e);

		expect(error).toBeInstanceOf(ApiRequestError);
		expect(error).toMatchObject({ status: 403, code: "forbidden", message: "not a member" });
	});

	it("rejects with 401 no_session when signed out, without a request", async () => {
		const calls = respond(200, { workspaces: [] });

		const error = await api(null)
			.workspaces()
			.catch((e: unknown) => e);

		expect(error).toBeInstanceOf(ApiRequestError);
		expect(error).toMatchObject({ status: 401, code: "no_session" });
		expect(calls).toHaveLength(0);
	});

	it("sends the requested dev-login role and workspace, and omits them when unset", async () => {
		const user = {
			id: "u1",
			name: "carol",
			email: null,
			color: "#fff",
			avatarUrl: null,
			isAdmin: false,
		};
		const calls = respond(200, { sessionToken: "t", user, workspaces: [] });
		const device = { name: "vault", platform: "macos", vaultId: "v1" } as const;

		await api(null).devLogin("carol", device, "viewer");
		await api(null).devLogin("carol", device);
		await api(null).devLogin("carol", device, undefined, "second");

		expect(JSON.parse(String(calls[0]?.body))).toEqual({ name: "carol", device, role: "viewer" });
		expect(JSON.parse(String(calls[1]?.body))).toEqual({ name: "carol", device });
		expect(JSON.parse(String(calls[2]?.body))).toEqual({
			name: "carol",
			device,
			workspace: "second",
		});
	});
});
