import { describe, expect, it, vi } from "vitest";
import { createApi } from "../lib/api";
import { sessionWith } from "./fakes";

const BASE = "https://relay.example.com";

function response(status: number, body: string, type = "application/json") {
	return new Response(body, { status, headers: { "content-type": type } });
}

function setup(reply: () => Promise<Response>, token: string | null = "tok") {
	const { session } = sessionWith(token);
	const fetch = vi.fn((_url: RequestInfo | URL, _init?: RequestInit) => reply());
	const onSignedOut = vi.fn();
	const onMisconfigured = vi.fn();
	const api = createApi({ base: BASE, fetch, session, onSignedOut, onMisconfigured });
	return { api, fetch, session, onSignedOut, onMisconfigured };
}

describe("createApi", () => {
	it("calls the relay base with a bearer and JSON body, and returns the data", async () => {
		const { api, fetch } = setup(async () => response(200, '{"ok":true}'));
		const res = await api.call("POST", "/api/x", { body: { a: 1 }, auth: true });
		expect(res).toEqual({ ok: true, data: { ok: true } });
		const [url, init = {}] = fetch.mock.calls[0] ?? [];
		expect(url).toBe(`${BASE}/api/x`);
		expect(init.credentials).toBe("omit");
		expect((init.headers as Record<string, string>).Authorization).toBe("Bearer tok");
		expect(init.body).toBe('{"a":1}');
	});

	it("does not send the bearer unless asked", async () => {
		const { api, fetch } = setup(async () => response(200, "{}"));
		await api.call("GET", "/api/x");
		const init = fetch.mock.calls[0]?.[1] ?? {};
		expect((init.headers as Record<string, string>).Authorization).toBeUndefined();
	});

	it("reads a JSON error body as {code, message}", async () => {
		const { api } = setup(async () =>
			response(410, '{"error":{"code":"invite_used","message":"Already used"}}'),
		);
		expect(await api.call("POST", "/api/x")).toEqual({
			ok: false,
			status: 410,
			code: "invite_used",
			message: "Already used",
		});
	});

	it("maps non-JSON failures by status", async () => {
		const html = (status: number) => setup(async () => response(status, "<html>", "text/html"));
		expect(await html(429).api.call("GET", "/api/x")).toMatchObject({ code: "rate_limited" });
		expect(await html(502).api.call("GET", "/api/x")).toMatchObject({ code: "server_error" });
		expect(await html(418).api.call("GET", "/api/x")).toMatchObject({ code: "http_418" });
	});

	it("maps a fetch rejection (offline, CORS) to network", async () => {
		const { api } = setup(async () => {
			throw new TypeError("Failed to fetch");
		});
		expect(await api.call("GET", "/api/x")).toMatchObject({
			ok: false,
			status: 0,
			code: "network",
		});
	});

	it("clears the session and signals sign-out on a 401 to an authenticated call", async () => {
		const unauthorized = '{"error":{"code":"unauthorized","message":"no"}}';
		const authed = setup(async () => response(401, unauthorized));
		await authed.api.call("GET", "/api/auth/me", { auth: true });
		expect(authed.session.token()).toBeNull();
		expect(authed.onSignedOut).toHaveBeenCalledOnce();

		const anon = setup(async () => response(401, unauthorized));
		await anon.api.call("POST", "/api/x");
		expect(anon.session.token()).toBe("tok");
		expect(anon.onSignedOut).not.toHaveBeenCalled();
	});

	it("signals a misconfigured relay (503)", async () => {
		const { api, onMisconfigured } = setup(async () =>
			response(503, '{"error":{"code":"misconfigured","message":"no secret"}}'),
		);
		expect(await api.call("GET", "/api/x")).toMatchObject({ code: "misconfigured" });
		expect(onMisconfigured).toHaveBeenCalledOnce();
	});

	it("reads the wait of a 429 or 423 from details.retryAfter, else Retry-After", async () => {
		const body = setup(async () =>
			response(429, '{"error":{"code":"rate_limited","message":"m","details":{"retryAfter":840}}}'),
		);
		expect(await body.api.call("POST", "/api/x")).toMatchObject({
			code: "rate_limited",
			retryAfter: 840,
		});
		const header = setup(
			async () =>
				new Response('{"error":{"code":"pins_locked","message":"m"}}', {
					status: 423,
					headers: { "content-type": "application/json", "retry-after": "86400" },
				}),
		);
		expect(await header.api.call("POST", "/api/x")).toMatchObject({
			code: "pins_locked",
			retryAfter: 86400,
		});
		const none = setup(async () => response(404, '{"error":{"code":"invalid_pin","message":"m"}}'));
		expect(await none.api.call("POST", "/api/x")).not.toHaveProperty("retryAfter");
	});

	it("sends DELETE", async () => {
		const { api, fetch } = setup(async () => response(200, '{"ok":true}'));
		await api.call("DELETE", "/api/workspaces/w/pins/p", { auth: true });
		expect(fetch.mock.calls[0]?.[1]?.method).toBe("DELETE");
	});
});
