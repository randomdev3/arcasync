import { afterEach, describe, expect, it, vi } from "vitest";
import { BAD_CODE_COPY, createApproveFlow, NOT_FOUND_COPY } from "../flows/approve";
import { fail, fakeApi, flush, ok, sessionWith, USER } from "./fakes";

const LOOKUP = ok({ device: { name: "mara-phone", platform: "ios" }, expiresAt: 1_000_000 });

function setup(
	routes: Parameters<typeof fakeApi>[0],
	code: string | null,
	token: string | null = "sess",
) {
	const fake = fakeApi({ "GET /api/auth/me": [ok({ user: USER })], ...routes });
	const { session } = sessionWith(token);
	const flow = createApproveFlow({ api: fake.api, session }, code);
	return { ...fake, flow };
}

const lookups = (calls: { path: string }[]) =>
	calls.filter((c) => c.path.includes("lookup")).length;

afterEach(() => vi.useRealTimers());

describe("approve flow", () => {
	it("needs a session first", () => {
		const { flow, calls } = setup({}, "bcdf ghjk", null);
		expect(flow.getState()).toEqual({ kind: "needs-session", code: "BCDF-GHJK", notice: null });
		expect(calls).toHaveLength(0);
	});

	it("looks a URL code up once, then approves only on a click", async () => {
		const { flow, calls } = setup(
			{
				"GET /api/auth/device/lookup": [LOOKUP],
				"POST /api/auth/device/approve": [ok({ ok: true })],
			},
			"bcdfghjk",
		);
		await flush();
		expect(flow.getState()).toMatchObject({
			kind: "confirm",
			code: "BCDF-GHJK",
			device: { name: "mara-phone", platform: "ios" },
		});
		expect(lookups(calls)).toBe(1);
		expect(calls.some((c) => c.path.includes("approve"))).toBe(false);
		flow.send({ type: "approve" });
		await flush();
		expect(calls.at(-1)?.options.body).toEqual({ userCode: "BCDF-GHJK", approve: true });
		expect(flow.getState()).toMatchObject({ kind: "approved", device: { name: "mara-phone" } });
	});

	it("sends approve: false on deny", async () => {
		const { flow, calls } = setup(
			{
				"GET /api/auth/device/lookup": [LOOKUP],
				"POST /api/auth/device/approve": [ok({ ok: true })],
			},
			"BCDF-GHJK",
		);
		await flush();
		flow.send({ type: "deny" });
		await flush();
		expect(calls.at(-1)?.options.body).toEqual({ userCode: "BCDF-GHJK", approve: false });
		expect(flow.getState()).toMatchObject({ kind: "denied" });
	});

	it("makes no request for a malformed code", async () => {
		const { flow, calls } = setup({}, null);
		await flush();
		flow.send({ type: "lookup", input: "ABCD-EFGH" });
		await flush();
		expect(lookups(calls)).toBe(0);
		expect(flow.getState()).toMatchObject({ kind: "ready", fieldError: BAD_CODE_COPY });
	});

	it("puts not_found on the field", async () => {
		const { flow } = setup(
			{ "GET /api/auth/device/lookup": [fail(404, "not_found")] },
			"BCDF-GHJK",
		);
		await flush();
		expect(flow.getState()).toMatchObject({ kind: "ready", fieldError: NOT_FOUND_COPY });
	});

	it("cools down 60 s on rate_limited", async () => {
		vi.useFakeTimers();
		const { flow, calls } = setup(
			{ "GET /api/auth/device/lookup": [fail(429, "rate_limited"), LOOKUP] },
			"BCDF-GHJK",
		);
		await flush();
		expect(flow.getState()).toMatchObject({ kind: "ready", cooldownUntil: expect.any(Number) });
		flow.send({ type: "lookup", input: "BCDF-GHJK" });
		await flush();
		expect(lookups(calls)).toBe(1);
		await vi.advanceTimersByTimeAsync(60_000);
		flow.send({ type: "lookup", input: "BCDF-GHJK" });
		await flush();
		expect(lookups(calls)).toBe(2);
		expect(flow.getState()).toMatchObject({ kind: "confirm" });
	});

	it("goes to needs-session on a 401", async () => {
		const { flow } = setup(
			{ "GET /api/auth/device/lookup": [fail(401, "unauthorized")] },
			"BCDF-GHJK",
		);
		await flush();
		expect(flow.getState()).toMatchObject({ kind: "needs-session", code: "BCDF-GHJK" });
		const me401 = fakeApi({ "GET /api/auth/me": [fail(401, "unauthorized")] });
		const flow2 = createApproveFlow({ api: me401.api, session: sessionWith("x").session }, null);
		await flush();
		expect(flow2.getState()).toMatchObject({ kind: "needs-session" });
	});
});
