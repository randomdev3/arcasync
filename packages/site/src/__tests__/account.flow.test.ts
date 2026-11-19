import { describe, expect, it } from "vitest";
import { createAccountFlow, SIGNED_OUT_OFFLINE_COPY } from "../flows/account";
import { fail, fakeApi, flush, ok, sessionWith, USER, WORKSPACES } from "./fakes";

const ME = ok({
	user: { ...USER, isAdmin: true },
	device: { name: "Browser · Firefox" },
	workspaces: WORKSPACES,
});

describe("account flow", () => {
	it("is signed out without a token, making no request", () => {
		const { api, calls } = fakeApi({});
		const flow = createAccountFlow({ api, session: sessionWith().session });
		expect(flow.getState()).toEqual({ kind: "signed-out", notice: null });
		expect(calls).toHaveLength(0);
	});

	it("shows who is signed in", async () => {
		const { api } = fakeApi({ "GET /api/auth/me": [ME] });
		const flow = createAccountFlow({ api, session: sessionWith("sess").session });
		await flush();
		expect(flow.getState()).toEqual({
			kind: "ready",
			me: { name: "mara", color: "#2fae8f", isAdmin: true },
			deviceName: "Browser · Firefox",
			workspaces: [{ name: "Team", role: "editor" }],
			signingOut: false,
		});
	});

	it("signs out, clearing the token even when the relay can't be reached", async () => {
		for (const [reply, notice] of [
			[ok({ ok: true }), "Signed out."],
			[fail(0, "network"), SIGNED_OUT_OFFLINE_COPY],
		] as const) {
			const { api, calls } = fakeApi({
				"GET /api/auth/me": [ME],
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
			api: fakeApi({ "GET /api/auth/me": [fail(0, "network"), ME] }).api,
			session: sessionWith("sess").session,
		});
		await flush();
		expect(gone.getState()).toEqual({ kind: "signed-out", notice: null });
		expect(down.getState()).toMatchObject({ kind: "error", error: { code: "network" } });
		down.send({ type: "retry" });
		await flush();
		expect(down.getState()).toMatchObject({ kind: "ready" });
	});
});
