import type { DeviceCodeResponse, SessionResponse } from "@arcasync/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	type RequestUrlParam,
	type RequestUrlResponse,
	requestUrlMock,
} from "../__mocks__/obsidian";
import { DeviceLogin, DeviceLoginError } from "../auth/DeviceLogin";
import { ApiClient } from "../net/ApiClient";

const defaultImpl = requestUrlMock.impl;
const device = { name: "dave-phone", platform: "ios", vaultId: "v2" } as const;
const user = {
	id: "u1",
	name: "dave",
	email: null,
	color: "#fff",
	avatarUrl: null,
	isAdmin: false,
};
const SESSION: SessionResponse = { sessionToken: "s1", user, workspaces: [] };

type Reply = { status: number; json: unknown } | Promise<{ status: number; json: unknown }>;

/** Routes `/auth/device/start` and `/auth/device/poll`; polls take replies from `polls`. */
function relay({ interval = 5, expiresIn = 600 } = {}) {
	const start: DeviceCodeResponse = {
		deviceCode: "dc",
		userCode: "BCDF-GHJK",
		verificationUri: "obsidian://teamsync?approve=BCDF-GHJK",
		interval,
		expiresIn,
	};
	const polls: Reply[] = [];
	const pollTimes: number[] = [];
	requestUrlMock.impl = async (param: RequestUrlParam): Promise<RequestUrlResponse> => {
		let reply: { status: number; json: unknown };
		if (param.url.endsWith("/auth/device/start")) reply = { status: 200, json: start };
		else {
			pollTimes.push(Date.now());
			reply = await (polls.shift() ?? pending());
		}
		return { ...reply, headers: {}, arrayBuffer: new ArrayBuffer(0), text: "" };
	};
	return { polls, pollTimes };
}

const pending = () => ({
	status: 400,
	json: { error: { code: "authorization_pending", message: "wait" } },
});
const error = (code: string) => ({ status: 400, json: { error: { code, message: code } } });

function login() {
	const api = new ApiClient({ getBaseUrl: () => "http://relay.test", getSessionToken: () => null });
	const codes: DeviceCodeResponse[] = [];
	const deviceLogin = new DeviceLogin({ api, device });
	const result = deviceLogin.run((code) => codes.push(code));
	// Keep a rejection from surfacing as unhandled before the test awaits it.
	result.catch(() => {});
	return { api, codes, deviceLogin, result };
}

beforeEach(() => {
	vi.useFakeTimers({ now: 1_000_000 });
});

afterEach(() => {
	vi.useRealTimers();
	requestUrlMock.impl = defaultImpl;
});

describe("DeviceLogin", () => {
	it("polls no faster than every 5 s, even when the server asks for less", async () => {
		const { pollTimes } = relay({ interval: 1 });
		const { codes } = login();
		await vi.advanceTimersByTimeAsync(0);
		expect(codes.map((c) => c.userCode)).toEqual(["BCDF-GHJK"]);

		await vi.advanceTimersByTimeAsync(4999);
		expect(pollTimes).toHaveLength(0);
		await vi.advanceTimersByTimeAsync(1);
		expect(pollTimes).toHaveLength(1);
		await vi.advanceTimersByTimeAsync(5000);
		expect(pollTimes).toHaveLength(2);
		expect((pollTimes[1] ?? 0) - (pollTimes[0] ?? 0)).toBeGreaterThanOrEqual(5000);
	});

	it("sends exactly N polls in N intervals", async () => {
		const { pollTimes } = relay();
		const { api } = login();
		await vi.advanceTimersByTimeAsync(7 * 5000);
		expect(pollTimes).toHaveLength(7);
		expect(api.requestCounts["/auth/device/poll"]).toBe(7);
		expect(api.requestCounts["/auth/device/start"]).toBe(1);
	});

	it("raises the interval to 10 s after slow_down", async () => {
		const { polls, pollTimes } = relay();
		polls.push(error("slow_down"));
		login();
		await vi.advanceTimersByTimeAsync(5000);
		expect(pollTimes).toHaveLength(1);
		await vi.advanceTimersByTimeAsync(9999);
		expect(pollTimes).toHaveLength(1);
		await vi.advanceTimersByTimeAsync(1);
		expect(pollTimes).toHaveLength(2);
		await vi.advanceTimersByTimeAsync(10_000);
		expect(pollTimes).toHaveLength(3);
	});

	it("resolves with the session once approved", async () => {
		const { polls } = relay();
		polls.push(pending(), { status: 200, json: SESSION });
		const { result } = login();
		await vi.advanceTimersByTimeAsync(10_000);
		await expect(result).resolves.toEqual(SESSION);
	});

	it("stops sending requests when cancelled", async () => {
		const { pollTimes } = relay();
		const { deviceLogin, result } = login();
		await vi.advanceTimersByTimeAsync(5000);
		expect(pollTimes).toHaveLength(1);
		deviceLogin.cancel();
		await vi.advanceTimersByTimeAsync(60_000);
		expect(pollTimes).toHaveLength(1);
		await expect(result).rejects.toMatchObject({ code: "cancelled" });
	});

	it("rejects on expired_token and access_denied", async () => {
		const first = relay();
		first.polls.push(error("expired_token"));
		const expired = login();
		await vi.advanceTimersByTimeAsync(5000);
		await expect(expired.result).rejects.toBeInstanceOf(DeviceLoginError);
		await expect(expired.result).rejects.toMatchObject({ code: "expired_token" });

		const second = relay();
		second.polls.push(error("access_denied"));
		const denied = login();
		await vi.advanceTimersByTimeAsync(5000);
		await expect(denied.result).rejects.toMatchObject({ code: "access_denied" });
		await vi.advanceTimersByTimeAsync(30_000);
		expect(second.pollTimes).toHaveLength(1);
	});

	it("rejects without a request once the code's lifetime is over", async () => {
		const { pollTimes } = relay({ expiresIn: 12 });
		const { result } = login();
		await vi.advanceTimersByTimeAsync(15_000);
		expect(pollTimes).toHaveLength(2);
		await expect(result).rejects.toMatchObject({ code: "expired_token" });
	});

	it("keeps exactly one poll in flight while an answer is slow", async () => {
		const { polls, pollTimes } = relay();
		let answer: (r: { status: number; json: unknown }) => void = () => {};
		polls.push(new Promise((r) => (answer = r)));
		login();
		await vi.advanceTimersByTimeAsync(30_000);
		expect(pollTimes).toHaveLength(1);
		answer(pending());
		await vi.advanceTimersByTimeAsync(4999);
		expect(pollTimes).toHaveLength(1);
		await vi.advanceTimersByTimeAsync(1);
		expect(pollTimes).toHaveLength(2);
	});
});
