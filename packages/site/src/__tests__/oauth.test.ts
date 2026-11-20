import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
	base64url,
	OAUTH_REDEEM_KEY,
	OAUTH_VERIFIER_KEY,
	type OAuthCrypto,
	oauthErrorCopy,
	saveRedeem,
	startOAuth,
	takeRedeem,
	verifierHash,
} from "../lib/oauth";
import { LEGACY_INFO, parseServerInfo } from "../lib/serverInfo";
import { memoryStorage } from "../lib/session";
import { fail, fakeApi, ok, sessionWith } from "./fakes";

/** Fixed random bytes, real SHA-256. */
const fixed: OAuthCrypto = {
	random: (n) => new Uint8Array(n).fill(7),
	sha256: (data) => globalThis.crypto.subtle.digest("SHA-256", data as BufferSource),
};

describe("oauth verifier", () => {
	it("is 43 base64url characters, and its hash is base64url SHA-256 (43 characters)", async () => {
		const verifier = base64url(fixed.random(32));
		expect(verifier).toMatch(/^[A-Za-z0-9_-]{43}$/);
		const hash = await verifierHash(verifier, fixed);
		expect(hash).toMatch(/^[A-Za-z0-9_-]{43}$/);
		expect(hash).toBe(createHash("sha256").update(verifier).digest("base64url"));
	});

	it("base64url has no padding or +/", () => {
		expect(base64url(new Uint8Array([251, 255, 191]))).toBe("-_-_");
		expect(base64url(new Uint8Array([1]))).toBe("AQ");
	});
});

describe("startOAuth", () => {
	it("keeps the verifier in session storage and sends only its hash", async () => {
		const fake = fakeApi({
			"POST /api/auth/oauth/google/start": [ok({ url: "https://accounts.google.com/o/oauth2?x" })],
		});
		const pending = memoryStorage();
		const res = await startOAuth({ api: fake.api, pending, crypto: fixed }, "google", {
			intent: "signin",
			next: "/approve?code=BCDF-GHJK",
		});
		expect(res).toEqual({ ok: true, url: "https://accounts.google.com/o/oauth2?x" });
		const verifier = pending.getItem(OAUTH_VERIFIER_KEY) ?? "";
		expect(verifier).toHaveLength(43);
		expect(fake.calls[0]?.options).toEqual({
			body: {
				intent: "signin",
				next: "/approve?code=BCDF-GHJK",
				verifierHash: createHash("sha256").update(verifier).digest("base64url"),
			},
			auth: false,
		});
	});

	it("sends the session for link, and refuses a non-http URL", async () => {
		const fake = fakeApi({
			"POST /api/auth/oauth/github/start": [ok({ url: "javascript:alert(1)" })],
		});
		const res = await startOAuth(
			{ api: fake.api, pending: memoryStorage(), crypto: fixed },
			"github",
			{ intent: "link", next: "/account" },
		);
		expect(fake.calls[0]?.options.auth).toBe(true);
		expect(res).toMatchObject({ ok: false, error: { code: "server_error" } });
	});

	it("passes relay errors through", async () => {
		const fake = fakeApi({ "POST /api/auth/oauth/google/start": [fail(404, "not_found")] });
		const res = await startOAuth(
			{ api: fake.api, pending: memoryStorage(), crypto: fixed },
			"google",
			{ intent: "signin", next: "/account" },
		);
		expect(res).toMatchObject({ ok: false, error: { code: "not_found" } });
	});
});

describe("pending redeem", () => {
	it("round-trips an invite or a PIN once", () => {
		const { storage } = sessionWith();
		saveRedeem(storage, { kind: "invite", token: "tok_abc:def" });
		expect(takeRedeem(storage)).toEqual({ kind: "invite", token: "tok_abc:def" });
		expect(takeRedeem(storage)).toBeNull();
		saveRedeem(storage, { kind: "pin", pin: "123456" });
		expect(takeRedeem(storage)).toEqual({ kind: "pin", pin: "123456" });
		storage.setItem(OAUTH_REDEEM_KEY, "junk");
		expect(takeRedeem(storage)).toBeNull();
	});
});

describe("oauth error copy", () => {
	it("has friendly copy for every relay code, and the server's message for limits", () => {
		for (const code of [
			"signup_closed",
			"identity_in_use",
			"oauth_denied",
			"oauth_failed",
			"state_expired",
			"too_many_users",
		]) {
			expect(oauthErrorCopy(code)).not.toBe(oauthErrorCopy("oauth_failed") + code);
			expect(oauthErrorCopy(code).length).toBeGreaterThan(10);
		}
		expect(oauthErrorCopy("signup_closed")).toMatch(/invite/);
		expect(oauthErrorCopy("limit_reached", "At most 3 teams.")).toBe("At most 3 teams.");
		expect(oauthErrorCopy("weird")).toBe(oauthErrorCopy("oauth_failed"));
	});
});

describe("server info", () => {
	it("reads auth and teams defensively", () => {
		expect(
			parseServerInfo({
				features: { teams: true },
				auth: {
					providers: ["github", "google", "myspace"],
					passwords: true,
					signups: "open",
					limits: { teamsPerUser: 3, membersPerTeam: 25, foldersPerTeam: 10 },
				},
			}),
		).toEqual({
			teams: true,
			auth: true,
			providers: ["google", "github"],
			signups: "open",
			limits: { teamsPerUser: 3, membersPerTeam: 25, foldersPerTeam: 10 },
		});
		expect(parseServerInfo({ features: {} })).toEqual(LEGACY_INFO);
		expect(parseServerInfo(null)).toEqual(LEGACY_INFO);
	});
});
