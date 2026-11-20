import { describe, expect, it } from "vitest";
import { callbackParams, createCallbackFlow, retryHref } from "../flows/callback";
import { OAUTH_VERIFIER_KEY, oauthErrorCopy } from "../lib/oauth";
import { memoryStorage } from "../lib/session";
import { DEVICE, fail, fakeApi, flush, ok, sessionWith, USER } from "./fakes";

const VERIFIER = "v".repeat(43);

function setup(search: string, reply = ok({ sessionToken: "sess", user: USER, created: true })) {
	const fake = fakeApi({ "POST /api/auth/oauth/exchange": [reply] });
	const { session } = sessionWith();
	const pending = memoryStorage();
	pending.setItem(OAUTH_VERIFIER_KEY, VERIFIER);
	const flow = createCallbackFlow(
		{ api: fake.api, session, pending, device: () => DEVICE },
		callbackParams(search),
	);
	return { ...fake, session, pending, flow };
}

describe("oauth callback flow", () => {
	it("exchanges the handoff with this tab's verifier, stores the session, goes to next", async () => {
		const { flow, calls, session, pending } = setup(
			`${"?handoff=h".padEnd(30, "x")}&next=%2Fapprove%3Fcode%3DBCDF-GHJK`,
		);
		expect(flow.getState()).toEqual({ kind: "exchanging" });
		await flush();
		expect(calls[0]?.options.body).toEqual({
			handoff: "h".padEnd(21, "x"),
			verifier: VERIFIER,
			device: DEVICE,
		});
		expect(session.token()).toBe("sess");
		expect(pending.getItem(OAUTH_VERIFIER_KEY)).toBeNull();
		expect(flow.getState()).toEqual({
			kind: "done",
			user: { name: "mara", color: "#2fae8f", isAdmin: false },
			created: true,
			next: "/approve?code=BCDF-GHJK",
		});
	});

	it("never goes to an unsafe next", async () => {
		const { flow } = setup("?handoff=hhhhhhhhhhhhhhhhhhhh&next=https%3A%2F%2Fevil.example");
		await flush();
		expect(flow.getState()).toMatchObject({ kind: "done", next: "/account" });
	});

	it("shows the relay's error code without calling it", () => {
		const { flow, calls, pending } = setup("?error=signup_closed&next=%2Fjoin%3Finvite%3Dabc");
		expect(calls).toHaveLength(0);
		expect(pending.getItem(OAUTH_VERIFIER_KEY)).toBeNull();
		expect(flow.getState()).toEqual({
			kind: "error",
			code: "signup_closed",
			message: oauthErrorCopy("signup_closed"),
			retry: "/signin?next=%2Fjoin%3Finvite%3Dabc",
		});
	});

	it("refuses a handoff that started in another tab (no verifier here)", () => {
		const fake = fakeApi({});
		const flow = createCallbackFlow(
			{
				api: fake.api,
				session: sessionWith().session,
				pending: memoryStorage(),
				device: () => DEVICE,
			},
			callbackParams("?handoff=hhhhhhhhhhhhhhhhhhhh"),
		);
		expect(fake.calls).toHaveLength(0);
		expect(flow.getState()).toMatchObject({ kind: "error", code: "missing_verifier" });
	});

	it("maps a failed exchange to friendly copy and keeps no session", async () => {
		const { flow, session } = setup(
			"?handoff=hhhhhhhhhhhhhhhhhhhh",
			fail(400, "state_expired", "expired"),
		);
		await flush();
		expect(session.token()).toBeNull();
		expect(flow.getState()).toEqual({
			kind: "error",
			code: "state_expired",
			message: oauthErrorCopy("state_expired"),
			retry: "/signin",
		});
	});

	it("says so when the server can't be reached", async () => {
		const { flow } = setup("?handoff=hhhhhhhhhhhhhhhhhhhh", fail(0, "network"));
		await flush();
		expect(flow.getState()).toMatchObject({ kind: "error", code: "network" });
		expect((flow.getState() as { message: string }).message).toMatch(/reach/);
	});

	it("retry goes back to sign-in, never auto-starting a provider", () => {
		expect(retryHref("/account")).toBe("/signin");
		expect(retryHref("/approve?code=BCDF-GHJK")).toBe("/signin?next=%2Fapprove%3Fcode%3DBCDF-GHJK");
	});
});
