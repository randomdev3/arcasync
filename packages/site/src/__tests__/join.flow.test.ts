import { describe, expect, it, vi } from "vitest";
import { createJoinFlow, NAME_RULE_COPY, NAME_TAKEN_COPY } from "../flows/join";
import { memoryStorage, PENDING_INVITE_KEY } from "../lib/session";
import { DEVICE, fail, fakeApi, flush, ok, sessionWith, USER, WORKSPACES } from "./fakes";

const TOKEN = "Qm9vdHN0cmFwLWludml0ZS10b2tlbi0wMTIzNDU2Nzg5YWI";
const SESSION = { sessionToken: "sess", user: USER, workspaces: WORKSPACES };

function setup(routes: Parameters<typeof fakeApi>[0], token: string | null = null) {
	const fake = fakeApi(routes);
	const { session } = sessionWith(token);
	const pending = memoryStorage();
	const flow = createJoinFlow({ api: fake.api, session, pending, device: () => DEVICE }, TOKEN);
	return { ...fake, session, pending, flow };
}

describe("join flow", () => {
	it("chooses without a session, keeps the invite in session storage, and joins", async () => {
		const { flow, session, pending, calls } = setup({
			"POST /api/auth/invite/accept": [ok(SESSION)],
		});
		expect(flow.getState()).toMatchObject({ kind: "choose", token: TOKEN });
		expect(pending.getItem(PENDING_INVITE_KEY)).toBe(TOKEN);
		flow.send({ type: "submit", name: "  mara " });
		await flush();
		expect(calls[0]?.options.body).toEqual({ token: TOKEN, name: "mara", device: DEVICE });
		expect(flow.getState()).toEqual({
			kind: "joined",
			user: { name: "mara", color: "#2fae8f", isAdmin: false },
			workspaces: [{ name: "Team", role: "editor" }],
			welcomeBack: false,
		});
		expect(session.token()).toBe("sess");
		expect(pending.getItem(PENDING_INVITE_KEY)).toBeNull();
	});

	it("says welcome back when a re-entry invite signs in as someone else's name", async () => {
		const { flow } = setup({ "POST /api/auth/invite/accept": [ok(SESSION)] });
		flow.send({ type: "submit", name: "typed-name" });
		await flush();
		expect(flow.getState()).toMatchObject({ kind: "joined", welcomeBack: true });
	});

	it.each([
		["not_found", 404],
		["invite_expired", 410],
		["invite_used", 410],
		["forbidden", 403],
	])("shows %s as a page error and keeps the invite", async (code, status) => {
		const { flow, pending } = setup({ "POST /api/auth/invite/accept": [fail(status, code)] });
		flow.send({ type: "submit", name: "mara" });
		await flush();
		expect(flow.getState()).toMatchObject({ kind: "error", error: { code } });
		expect(pending.getItem(PENDING_INVITE_KEY)).toBe(TOKEN);
	});

	it("puts name_taken and bad_request on the field, without spending the invite", async () => {
		const { flow, pending } = setup({
			"POST /api/auth/invite/accept": [fail(409, "name_taken"), fail(400, "bad_request")],
		});
		flow.send({ type: "submit", name: "mara" });
		await flush();
		expect(flow.getState()).toMatchObject({
			kind: "choose",
			nameError: NAME_TAKEN_COPY,
			name: "mara",
		});
		flow.send({ type: "submit", name: "mara2" });
		await flush();
		expect(flow.getState()).toMatchObject({ kind: "choose", nameError: NAME_RULE_COPY });
		expect(pending.getItem(PENDING_INVITE_KEY)).toBe(TOKEN);
	});

	it("checks the name locally first", async () => {
		const { flow, calls } = setup({});
		flow.send({ type: "submit", name: "   " });
		flow.send({ type: "submit", name: "x".repeat(61) });
		await flush();
		expect(calls).toHaveLength(0);
		expect(flow.getState()).toMatchObject({ nameError: NAME_RULE_COPY });
	});

	it("keeps the form on a network error and ignores double submits", async () => {
		let release: (v: unknown) => void = () => {};
		const { flow, calls } = setup({
			"POST /api/auth/invite/accept": [
				new Promise((r) => {
					release = r;
				}).then(() => fail(0, "network")),
			],
		});
		flow.send({ type: "submit", name: "mara" });
		flow.send({ type: "submit", name: "mara" });
		expect(flow.getState()).toMatchObject({ submitting: true });
		release(null);
		await flush();
		expect(calls).toHaveLength(1);
		expect(flow.getState()).toMatchObject({
			kind: "choose",
			submitting: false,
			formError: { code: "network" },
		});
	});

	it("cools down for 60 s after rate_limited", async () => {
		vi.useFakeTimers();
		try {
			const { flow, calls } = setup({
				"POST /api/auth/invite/accept": [fail(429, "rate_limited"), ok(SESSION)],
			});
			flow.send({ type: "submit", name: "mara" });
			await flush();
			expect(flow.getState()).toMatchObject({ cooldownUntil: expect.any(Number) });
			flow.send({ type: "submit", name: "mara" });
			await flush();
			expect(calls).toHaveLength(1);
			vi.advanceTimersByTime(60_000);
			expect(flow.getState()).toMatchObject({ cooldownUntil: null });
			flow.send({ type: "submit", name: "mara" });
			await flush();
			expect(flow.getState()).toMatchObject({ kind: "joined" });
		} finally {
			vi.useRealTimers();
		}
	});

	it("with a session, adds the workspace through redeem", async () => {
		const { flow, calls } = setup(
			{
				"GET /api/auth/me": [ok({ user: USER })],
				"POST /api/invites/redeem": [ok({ workspaces: WORKSPACES })],
			},
			"sess",
		);
		expect(flow.getState()).toMatchObject({ kind: "checking-session" });
		await flush();
		expect(flow.getState()).toMatchObject({ kind: "signed-in", me: { name: "mara" } });
		flow.send({ type: "redeem" });
		await flush();
		expect(calls[1]).toMatchObject({ options: { body: { token: TOKEN }, auth: true } });
		expect(flow.getState()).toMatchObject({ redeemed: [{ name: "Team", role: "editor" }] });
	});

	it("falls back to choose when the stored session is rejected (401)", async () => {
		const { flow } = setup({ "GET /api/auth/me": [fail(401, "unauthorized")] }, "stale");
		await flush();
		expect(flow.getState()).toMatchObject({ kind: "choose" });
	});

	it("'not you' forgets the session and offers a new account", async () => {
		const { flow, session } = setup({ "GET /api/auth/me": [ok({ user: USER })] }, "sess");
		await flush();
		flow.send({ type: "not-me" });
		expect(session.token()).toBeNull();
		expect(flow.getState()).toMatchObject({ kind: "choose" });
	});

	it("without a token, takes a pasted link for this site or relay only", async () => {
		const fake = fakeApi({});
		const { session } = sessionWith();
		const flow = createJoinFlow(
			{ api: fake.api, session, pending: memoryStorage(), device: () => DEVICE },
			null,
		);
		expect(flow.getState()).toEqual({ kind: "no-invite", pasteError: null });
		const site = "https://arca.example.com";
		const relay = "https://relay.example.com";
		flow.send({ type: "paste", input: "nope", site, relay });
		expect(flow.getState()).toMatchObject({ pasteError: expect.stringContaining("doesn't look") });
		flow.send({ type: "paste", input: `https://other.example/join?invite=${TOKEN}`, site, relay });
		expect(flow.getState()).toMatchObject({
			pasteError: expect.stringContaining("another server"),
		});
		flow.send({ type: "paste", input: `${site}/join?invite=${TOKEN}`, site, relay });
		await flush();
		expect(flow.getState()).toMatchObject({ kind: "choose", token: TOKEN });
	});

	it("resumes from session storage after a reload", () => {
		const pending = memoryStorage();
		pending.setItem(PENDING_INVITE_KEY, TOKEN);
		const flow = createJoinFlow(
			{ api: fakeApi({}).api, session: sessionWith().session, pending, device: () => DEVICE },
			null,
		);
		expect(flow.getState()).toMatchObject({ kind: "choose", token: TOKEN });
	});
});
