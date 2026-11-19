import { afterEach, describe, expect, it } from "vitest";
import {
	type RequestUrlParam,
	type RequestUrlResponse,
	requestUrlMock,
} from "../__mocks__/obsidian";
import { ApiClient, ApiRequestError, NetworkError } from "../net/ApiClient";

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

	const user = {
		id: "u1",
		name: "dave",
		email: null,
		color: "#fff",
		avatarUrl: null,
		isAdmin: true,
	};
	const device = { name: "phone", platform: "ios", vaultId: "v2" } as const;
	const workspace = { id: "ws1", slug: "team", name: "Team", role: "owner" };

	it("accepts an invite without a session and parses the SessionResponse", async () => {
		const calls = respond(200, { sessionToken: "s1", user, workspaces: [workspace] });

		const session = await api(null).acceptInvite("inv", "dave", device);

		expect(session).toEqual({ sessionToken: "s1", user, workspaces: [workspace] });
		expect(calls[0]?.url).toBe("http://relay.test/api/auth/invite/accept");
		expect(calls[0]?.method).toBe("POST");
		expect(calls[0]?.headers?.Authorization).toBeUndefined();
		expect(JSON.parse(String(calls[0]?.body))).toEqual({ token: "inv", name: "dave", device });
	});

	it("redeems an invite with the session and unwraps the workspaces", async () => {
		const calls = respond(200, { workspaces: [workspace] });

		expect(await api().redeemInvite("inv")).toEqual([workspace]);
		expect(calls[0]?.url).toBe("http://relay.test/api/invites/redeem");
		expect(calls[0]?.headers?.Authorization).toBe("Bearer session-token");
		expect(JSON.parse(String(calls[0]?.body))).toEqual({ token: "inv" });
	});

	it("maps invite and device-code errors to ApiRequestError codes", async () => {
		respond(410, { error: { code: "invite_used", message: "used" } });
		await expect(api(null).acceptInvite("inv", "dave", device)).rejects.toMatchObject({
			status: 410,
			code: "invite_used",
		});
		respond(400, { error: { code: "authorization_pending", message: "wait" } });
		await expect(api(null).devicePoll("dc")).rejects.toMatchObject({
			status: 400,
			code: "authorization_pending",
		});
		respond(429, { error: { code: "rate_limited", message: "later" } });
		await expect(api().deviceLookup("BCDF-GHJK")).rejects.toMatchObject({
			status: 429,
			code: "rate_limited",
		});
	});

	it("parses device start, lookup and approve", async () => {
		const start = {
			deviceCode: "dc",
			userCode: "BCDF-GHJK",
			verificationUri: "obsidian://teamsync?approve=BCDF-GHJK",
			interval: 5,
			expiresIn: 600,
		};
		let calls = respond(200, start);
		expect(await api(null).deviceStart(device)).toEqual(start);
		expect(JSON.parse(String(calls[0]?.body))).toEqual({ device });
		expect(calls[0]?.headers?.Authorization).toBeUndefined();

		calls = respond(200, { device: { name: "phone", platform: "ios" }, expiresAt: 5 });
		expect(await api().deviceLookup("bcdf ghjk")).toEqual({
			device: { name: "phone", platform: "ios" },
			expiresAt: 5,
		});
		expect(calls[0]?.url).toBe("http://relay.test/api/auth/device/lookup?userCode=bcdf%20ghjk");

		calls = respond(200, { ok: true });
		await api().deviceApprove("BCDF-GHJK", false);
		expect(JSON.parse(String(calls[0]?.body))).toEqual({ userCode: "BCDF-GHJK", approve: false });
	});

	it("rejects a device start response that does not match the schema", async () => {
		respond(200, { deviceCode: "dc" });
		await expect(api(null).deviceStart(device)).rejects.toBeInstanceOf(NetworkError);
	});

	it("logs out with the session", async () => {
		const calls = respond(200, { ok: true });
		await api().logout();
		expect(calls[0]?.url).toBe("http://relay.test/api/auth/logout");
		expect(calls[0]?.method).toBe("POST");
		expect(calls[0]?.headers?.Authorization).toBe("Bearer session-token");
	});

	it("counts requests per pathname without the query string, not unsent ones", async () => {
		respond(200, { device: { name: "phone", platform: "ios" }, expiresAt: 5 });
		const client = api();
		await client.deviceLookup("A");
		await client.deviceLookup("B");
		await api(null)
			.workspaces()
			.catch(() => {});
		expect(client.requestCounts).toEqual({ "/auth/device/lookup": 2 });
	});
});
