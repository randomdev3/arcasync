import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	createLoginFlow,
	createSigninFlow,
	LOGIN_NAME_COPY,
	LOGIN_PASSWORD_COPY,
	safeNext,
} from "../flows/signin";
import { DEVICE, fail, fakeApi, flush, ok, sessionWith, USER } from "./fakes";

const START = ok({ deviceCode: "dc", userCode: "BCDF-GHJK", interval: 5, expiresIn: 600 });
const SESSION = ok({ sessionToken: "sess", user: USER, workspaces: [] });
const pending = () => fail(400, "authorization_pending");

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

function setup(polls: ReturnType<typeof ok | typeof fail>[], start = START) {
	const fake = fakeApi({
		"POST /api/auth/device/start": [start],
		"POST /api/auth/device/poll": polls,
	});
	const { session } = sessionWith();
	const flow = createSigninFlow({
		api: fake.api,
		session,
		device: () => DEVICE,
		next: "/approve?code=BCDF-GHJK",
	});
	return { ...fake, session, flow };
}

const polls = (calls: { path: string }[]) => calls.filter((c) => c.path.endsWith("/poll")).length;

async function tick(ms: number) {
	await vi.advanceTimersByTimeAsync(ms);
	await flush();
}

describe("signin flow", () => {
	it("starts only when asked, then polls every interval until approved", async () => {
		const { flow, calls, session } = setup([pending(), pending(), SESSION]);
		expect(flow.getState()).toEqual({ kind: "idle", error: null });
		expect(calls).toHaveLength(0);
		flow.send({ type: "start" });
		await flush();
		expect(flow.getState()).toMatchObject({ kind: "waiting", userCode: "BCDF-GHJK" });
		await tick(4_999);
		expect(polls(calls)).toBe(0);
		await tick(1);
		expect(polls(calls)).toBe(1);
		await tick(10_000);
		expect(flow.getState()).toEqual({
			kind: "approved",
			user: { name: "mara", color: "#2fae8f", isAdmin: false },
			next: "/approve?code=BCDF-GHJK",
		});
		expect(session.token()).toBe("sess");
		expect(polls(calls)).toBe(3);
	});

	it("adds 5 s on every slow_down", async () => {
		const { flow, calls } = setup([fail(400, "slow_down"), pending(), pending()]);
		flow.send({ type: "start" });
		await tick(5_000);
		expect(polls(calls)).toBe(1);
		await tick(9_999);
		expect(polls(calls)).toBe(1);
		await tick(1);
		expect(polls(calls)).toBe(2);
	});

	it("never has more than one poll in flight, even when the tab comes back", async () => {
		let release: (v: unknown) => void = () => {};
		const slow = new Promise((r) => {
			release = r;
		}).then(pending);
		const { flow, calls, maxInFlight } = setup([slow as never, pending(), pending()]);
		flow.send({ type: "start" });
		await tick(5_000);
		expect(polls(calls)).toBe(1);
		flow.send({ type: "visible" });
		await tick(20_000);
		expect(polls(calls)).toBe(1);
		release(null);
		await tick(5_000);
		expect(polls(calls)).toBe(2);
		expect(maxInFlight()).toBe(1);
	});

	it("polls at once when the tab returns after an interval (throttled timers)", async () => {
		// A hidden tab's timers may not fire: this clock's never do, only `visible` can poll.
		let now = 0;
		const clock = { now: () => now, setTimeout: () => 0, clearTimeout: () => {} };
		const fake = fakeApi({
			"POST /api/auth/device/start": [START],
			"POST /api/auth/device/poll": [pending(), pending()],
		});
		const flow = createSigninFlow({
			api: fake.api,
			session: sessionWith().session,
			device: () => DEVICE,
			next: "/account",
			clock,
		});
		flow.send({ type: "start" });
		await flush();
		now = 3_000;
		flow.send({ type: "visible" });
		await flush();
		expect(polls(fake.calls)).toBe(0);
		now = 30_000;
		flow.send({ type: "visible" });
		await flush();
		expect(polls(fake.calls)).toBe(1);
		flow.send({ type: "visible" });
		await flush();
		expect(polls(fake.calls)).toBe(1);
	});

	it("ends on access_denied and expired_token", async () => {
		const denied = setup([fail(400, "access_denied")]);
		denied.flow.send({ type: "start" });
		await tick(5_000);
		expect(denied.flow.getState()).toEqual({ kind: "denied" });
		const expired = setup([fail(400, "expired_token")]);
		expired.flow.send({ type: "start" });
		await tick(5_000);
		expect(expired.flow.getState()).toEqual({ kind: "expired" });
	});

	it("expires locally at the deadline without another request", async () => {
		const start = ok({ deviceCode: "dc", userCode: "BCDF-GHJK", interval: 5, expiresIn: 12 });
		const { flow, calls } = setup([pending(), pending(), pending()], start);
		flow.send({ type: "start" });
		await tick(12_000);
		expect(flow.getState()).toEqual({ kind: "expired" });
		expect(polls(calls)).toBe(2);
		await tick(60_000);
		expect(polls(calls)).toBe(2);
	});

	it("keeps polling through a network blip", async () => {
		const { flow } = setup([fail(0, "network"), SESSION]);
		flow.send({ type: "start" });
		await tick(10_000);
		expect(flow.getState()).toMatchObject({ kind: "approved" });
	});

	it("cancel stops all timers", async () => {
		const { flow, calls } = setup([pending()]);
		flow.send({ type: "start" });
		await flush();
		flow.send({ type: "cancel" });
		expect(flow.getState()).toEqual({ kind: "idle", error: null });
		expect(vi.getTimerCount()).toBe(0);
		await tick(60_000);
		expect(polls(calls)).toBe(0);
	});

	it("shows a start failure on idle", async () => {
		const { flow } = setup([], fail(0, "network"));
		flow.send({ type: "start" });
		await flush();
		expect(flow.getState()).toMatchObject({ kind: "idle", error: { code: "network" } });
	});
});

describe("safeNext", () => {
	it("allows a few same-origin pages only", () => {
		expect(safeNext("/approve?code=BCDF-GHJK")).toBe("/approve?code=BCDF-GHJK");
		expect(safeNext("/account")).toBe("/account");
		expect(safeNext("/join")).toBe("/join");
		expect(safeNext("/join?invite=abc_DEF-123")).toBe("/join?invite=abc_DEF-123");
		expect(safeNext("/join?pin=123456")).toBe("/join?pin=123456");
		for (const bad of [
			"/auth/callback",
			"/approve?code=x#y",
			null,
			"",
			"//evil.example",
			"https://evil.example",
			"/approve/../x",
			"/admin",
			"/account#x",
			"/approve\\evil",
		]) {
			expect(safeNext(bad), String(bad)).toBe("/account");
		}
	});
});

describe("login flow (name + password)", () => {
	function loginSetup(replies: ReturnType<typeof ok | typeof fail>[]) {
		const fake = fakeApi({ "POST /api/auth/login": replies });
		const { session } = sessionWith();
		const flow = createLoginFlow({
			api: fake.api,
			session,
			device: () => DEVICE,
			next: "/account",
		});
		return { ...fake, session, flow };
	}

	it("signs in and keeps the session", async () => {
		const { flow, session, calls } = loginSetup([SESSION]);
		flow.send({ type: "login", name: " Mara ", password: "correct horse battery" });
		await flush();
		expect(calls[0]?.options.body).toEqual({
			name: "Mara",
			password: "correct horse battery",
			device: DEVICE,
		});
		expect(flow.getState()).toEqual({
			kind: "done",
			user: { name: "mara", color: "#2fae8f", isAdmin: false },
			next: "/account",
		});
		expect(session.token()).toBe("sess");
	});

	it("needs both fields, and never checks password rules at sign-in", async () => {
		const { flow, calls } = loginSetup([fail(401, "invalid_credentials")]);
		flow.send({ type: "login", name: "", password: "" });
		expect(flow.getState()).toMatchObject({
			nameError: LOGIN_NAME_COPY,
			passwordError: LOGIN_PASSWORD_COPY,
		});
		flow.send({ type: "login", name: "mara", password: "x" });
		await flush();
		expect(calls).toHaveLength(1);
		expect(flow.getState()).toMatchObject({
			kind: "form",
			submitting: false,
			error: { code: "invalid_credentials" },
		});
	});

	it("waits out a 429 for the relay's retryAfter", async () => {
		const { flow, calls } = loginSetup([fail(429, "rate_limited", "m", 300), SESSION]);
		flow.send({ type: "login", name: "mara", password: "pw" });
		await flush();
		expect(flow.getState()).toMatchObject({ error: { retryAfter: 300 } });
		flow.send({ type: "login", name: "mara", password: "pw" });
		expect(calls).toHaveLength(1);
		await tick(300_000);
		flow.send({ type: "login", name: "mara", password: "pw" });
		await flush();
		expect(flow.getState()).toMatchObject({ kind: "done" });
	});
});
