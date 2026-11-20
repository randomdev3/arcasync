import { describe, expect, it } from "vitest";
import {
	CONFIRM_COPY,
	CURRENT_REQUIRED_COPY,
	CURRENT_WRONG_COPY,
	createAccountFlow,
	PASSWORD_CHANGED_COPY,
	PASSWORD_SET_COPY,
	SIGNED_OUT_OFFLINE_COPY,
} from "../flows/account";
import { fail, fakeApi, flush, ok, sessionWith, USER, WORKSPACES } from "./fakes";

const ME = ok({
	user: { ...USER, isAdmin: true },
	device: { name: "Browser · Firefox" },
	workspaces: WORKSPACES,
	hasPassword: false,
});
/** Admins manage every workspace, so the PIN panel loads w1's PINs. */
const NO_PINS = () => ok({ pins: [], locked: false, lockedUntil: null });
const PIN = {
	id: "p1",
	pin: "0420",
	workspaceId: "w1",
	role: "editor",
	admin: false,
	createdAt: 1,
	createdBy: "u1",
	expiresAt: Date.now() + 3600_000,
	usedAt: null,
	usedBy: null,
	revoked: false,
};

describe("account flow", () => {
	it("is signed out without a token, making no request", () => {
		const { api, calls } = fakeApi({});
		const flow = createAccountFlow({ api, session: sessionWith().session });
		expect(flow.getState()).toEqual({ kind: "signed-out", notice: null });
		expect(calls).toHaveLength(0);
	});

	it("shows who is signed in", async () => {
		const { api } = fakeApi({ "GET /api/auth/me": [ME], "GET /api/workspaces/w1/pins": NO_PINS });
		const flow = createAccountFlow({ api, session: sessionWith("sess").session });
		await flush();
		expect(flow.getState()).toEqual({
			kind: "ready",
			me: { name: "mara", color: "#2fae8f", isAdmin: true },
			profile: { id: "u1", email: null, avatarUrl: null },
			deviceName: "Browser · Firefox",
			workspaces: [{ name: "Team", role: "editor" }],
			signingOut: false,
			hasPassword: false,
			password: {
				submitting: false,
				currentError: null,
				nextError: null,
				confirmError: null,
				error: null,
				done: null,
			},
			managed: [{ id: "w1", name: "Team" }],
			pins: {
				workspaceId: "w1",
				loading: false,
				busy: false,
				items: [],
				locked: false,
				lockedUntil: null,
				error: null,
			},
		});
	});

	it("signs out, clearing the token even when the relay can't be reached", async () => {
		for (const [reply, notice] of [
			[ok({ ok: true }), "Signed out."],
			[fail(0, "network"), SIGNED_OUT_OFFLINE_COPY],
		] as const) {
			const { api, calls } = fakeApi({
				"GET /api/auth/me": [ME],
				"GET /api/workspaces/w1/pins": NO_PINS,
				"POST /api/auth/logout": [reply],
			});
			const { session } = sessionWith("sess");
			const flow = createAccountFlow({ api, session });
			await flush();
			flow.send({ type: "logout" });
			await flush();
			expect(calls.at(-1)).toMatchObject({ path: "/api/auth/logout", options: { auth: true } });
			expect(session.token()).toBeNull();
			expect(flow.getState()).toEqual({ kind: "signed-out", notice });
		}
	});

	it("treats a 401 as signed out and other failures as retryable errors", async () => {
		const gone = createAccountFlow({
			api: fakeApi({ "GET /api/auth/me": [fail(401, "unauthorized")] }).api,
			session: sessionWith("sess").session,
		});
		const down = createAccountFlow({
			api: fakeApi({
				"GET /api/auth/me": [fail(0, "network"), ME],
				"GET /api/workspaces/w1/pins": NO_PINS,
			}).api,
			session: sessionWith("sess").session,
		});
		await flush();
		expect(gone.getState()).toEqual({ kind: "signed-out", notice: null });
		expect(down.getState()).toMatchObject({ kind: "error", error: { code: "network" } });
		down.send({ type: "retry" });
		await flush();
		expect(down.getState()).toMatchObject({ kind: "ready" });
	});

	describe("password", () => {
		const setup = (hasPassword: boolean, replies: ReturnType<typeof ok>[] = []) => {
			const fake = fakeApi({
				"GET /api/auth/me": [ok({ ...(ME.ok ? ME.data : {}), user: USER, hasPassword })],
				"POST /api/auth/password": replies,
			});
			const flow = createAccountFlow({ api: fake.api, session: sessionWith("sess").session });
			return { ...fake, flow };
		};
		const panel = (flow: ReturnType<typeof createAccountFlow>) => {
			const state = flow.getState();
			if (state.kind !== "ready") throw new Error(state.kind);
			return { ...state.password, hasPassword: state.hasPassword };
		};

		it("sets a first password without `current` and reports it", async () => {
			const { flow, calls } = setup(false, [ok({ ok: true })]);
			await flush();
			expect(flow.getState()).toMatchObject({ kind: "ready", pins: null, managed: [] });
			flow.send({ type: "password", current: "", next: "short", confirm: "short" });
			expect(panel(flow).nextError).toMatch(/at least 10/);
			flow.send({ type: "password", current: "", next: "long enough pw", confirm: "other" });
			expect(panel(flow).confirmError).toBe(CONFIRM_COPY);
			expect(calls).toHaveLength(1);
			flow.send({
				type: "password",
				current: "",
				next: "long enough pw",
				confirm: "long enough pw",
			});
			await flush();
			expect(calls.at(-1)).toMatchObject({
				method: "POST",
				path: "/api/auth/password",
				options: { auth: true, body: { new: "long enough pw" } },
			});
			expect(panel(flow)).toMatchObject({ done: PASSWORD_SET_COPY, hasPassword: true });
		});

		it("changes it with `current`, mapping a wrong one and a weak new one to their fields", async () => {
			const { flow, calls } = setup(true, [
				fail(403, "invalid_credentials"),
				fail(400, "weak_password", "That password is too common; pick another"),
				fail(429, "rate_limited", "x", 600),
				ok({ ok: true }),
			]);
			await flush();
			const change = (current: string) =>
				flow.send({ type: "password", current, next: "new password!", confirm: "new password!" });
			change("");
			expect(panel(flow).currentError).toBe(CURRENT_REQUIRED_COPY);
			change("old password");
			await flush();
			expect(calls.at(-1)?.options.body).toEqual({ current: "old password", new: "new password!" });
			expect(panel(flow).currentError).toBe(CURRENT_WRONG_COPY);
			change("old password");
			await flush();
			expect(panel(flow).nextError).toBe("That password is too common; pick another");
			change("old password");
			await flush();
			expect(panel(flow).error).toMatchObject({ code: "rate_limited", retryAfter: 600 });
			change("old password");
			await flush();
			expect(panel(flow)).toMatchObject({ done: PASSWORD_CHANGED_COPY, error: null });
		});

		it("a 401 while changing means signed out", async () => {
			const { flow } = setup(true, [fail(401, "unauthorized")]);
			await flush();
			flow.send({
				type: "password",
				current: "old password",
				next: "new password!",
				confirm: "new password!",
			});
			await flush();
			expect(flow.getState()).toEqual({ kind: "signed-out", notice: null });
		});
	});

	describe("PINs", () => {
		const OWNER_ME = ok({
			user: USER,
			device: { name: "b" },
			workspaces: [
				{ id: "w1", slug: "team", name: "Team", role: "owner" },
				{ id: "w2", slug: "x", name: "X", role: "editor" },
				{ id: "w3", slug: "y", name: "Y", role: "owner" },
			],
			hasPassword: true,
		});
		const pinsOf = (flow: ReturnType<typeof createAccountFlow>) => {
			const state = flow.getState();
			if (state.kind !== "ready" || !state.pins) throw new Error("no pin panel");
			return state.pins;
		};

		it("lists, creates and revokes PINs of the workspaces the user owns", async () => {
			const lists = [
				ok({ pins: [], locked: false, lockedUntil: null }),
				ok({ pins: [PIN], locked: false, lockedUntil: null }),
				ok({ pins: [{ ...PIN, revoked: true }], locked: false, lockedUntil: null }),
			];
			const { api, calls } = fakeApi({
				"GET /api/auth/me": [OWNER_ME],
				"GET /api/workspaces/w1/pins": lists,
				"GET /api/workspaces/w3/pins": [ok({ pins: [], locked: false, lockedUntil: null })],
				"POST /api/workspaces/w1/pins": [ok(PIN)],
				"DELETE /api/workspaces/w1/pins/p1": [ok({ ok: true })],
			});
			const flow = createAccountFlow({ api, session: sessionWith("sess").session });
			await flush();
			const state = flow.getState();
			expect(state.kind === "ready" && state.managed).toEqual([
				{ id: "w1", name: "Team" },
				{ id: "w3", name: "Y" },
			]);
			flow.send({ type: "pin-create", role: "viewer" });
			await flush();
			expect(calls.find((c) => c.method === "POST")?.options).toEqual({
				auth: true,
				body: { role: "viewer" },
			});
			expect(pinsOf(flow).items).toEqual([
				{
					id: "p1",
					pin: "0420",
					role: "editor",
					admin: false,
					expiresAt: PIN.expiresAt,
					usedAt: null,
					usedBy: null,
					revoked: false,
				},
			]);
			flow.send({ type: "pin-revoke", id: "p1" });
			await flush();
			expect(pinsOf(flow).items[0]?.revoked).toBe(true);
			flow.send({ type: "pins-workspace", workspaceId: "w3" });
			await flush();
			expect(pinsOf(flow)).toMatchObject({ workspaceId: "w3", items: [], loading: false });
			// Not a managed workspace: ignored.
			flow.send({ type: "pins-workspace", workspaceId: "w2" });
			expect(pinsOf(flow).workspaceId).toBe("w3");
		});

		it("shows too_many_pins and the lock; only admins unlock", async () => {
			const until = Date.now() + 3600_000;
			const { api, calls } = fakeApi({
				"GET /api/auth/me": [OWNER_ME],
				"GET /api/workspaces/w1/pins": [ok({ pins: [], locked: true, lockedUntil: until })],
				"POST /api/workspaces/w1/pins": [fail(409, "too_many_pins")],
			});
			const flow = createAccountFlow({ api, session: sessionWith("sess").session });
			await flush();
			expect(pinsOf(flow)).toMatchObject({ locked: true, lockedUntil: until });
			flow.send({ type: "pin-create", role: "editor" });
			await flush();
			expect(pinsOf(flow)).toMatchObject({ busy: false, error: { code: "too_many_pins" } });
			flow.send({ type: "pins-unlock" });
			await flush();
			expect(calls.some((c) => c.path === "/api/admin/pins/unlock")).toBe(false);
		});

		it("an admin unlocks PIN entry", async () => {
			const { api, calls } = fakeApi({
				"GET /api/auth/me": [ME],
				"GET /api/workspaces/w1/pins": [
					ok({ pins: [], locked: true, lockedUntil: Date.now() + 1000 }),
					ok({ pins: [], locked: false, lockedUntil: null }),
				],
				"POST /api/admin/pins/unlock": [ok({ ok: true })],
			});
			const flow = createAccountFlow({ api, session: sessionWith("sess").session });
			await flush();
			flow.send({ type: "pins-unlock" });
			await flush();
			expect(calls.at(-2)).toMatchObject({ method: "POST", path: "/api/admin/pins/unlock" });
			expect(pinsOf(flow).locked).toBe(false);
		});
	});
});
