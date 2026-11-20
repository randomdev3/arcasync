/**
 * Google and GitHub sign-in under `wrangler dev --env dev`, against a fake provider in this
 * process (`ARCASYNC_OAUTH_TEST_BASE`, honoured only with debug stats on). The fake checks what
 * the real ones would: client credentials, the redirect URI, PKCE for Google, a User-Agent for
 * GitHub, and answers GitHub token errors with 200 + `error`.
 */
import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	IdentitiesResponse,
	InviteCreated,
	MeResponse,
	OAuthStartResponse,
	ServerInfo,
	SessionResponse,
	TeamSummary,
	User,
	WorkspacesResponse,
} from "@arcasync/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { startRelayDev } from "../scripts/dev-server.mjs";
import { device, errorCode, get, patch, post, request, SITE_URL } from "./helpers";

type Provider = "google" | "github";
type Relay = { url: string; stop: () => Promise<void> };

const ExchangeResponse = SessionResponse.extend({ created: z.boolean() });
const s256 = (value: string) => createHash("sha256").update(value).digest("base64url");
const pickPort = (base: number) => base + Math.floor(Math.random() * 400);

interface Account {
	/** Google `userinfo` or GitHub `/user`. */
	profile: Record<string, unknown>;
	/** GitHub `/user/emails`. */
	emails?: { email: string; primary: boolean; verified: boolean }[];
}

/** A fake Google + GitHub: `<base>/<provider>/{token,user,user/emails}`. */
async function fakeProvider() {
	const codes = new Map<string, { account: Account; challenge: string | null; redirect: string }>();
	const tokens = new Map<string, Account>();
	const server: Server = createServer((req, res) => {
		let raw = "";
		req.on("data", (chunk) => {
			raw += chunk;
		});
		req.on("end", () => {
			const send = (status: number, body: unknown) => {
				res.writeHead(status, { "Content-Type": "application/json" });
				res.end(JSON.stringify(body));
			};
			const [provider = "", ...rest] = new URL(req.url ?? "/", "http://fake").pathname
				.slice(1)
				.split("/");
			const path = rest.join("/");
			if (path === "token" && req.method === "POST") {
				const form = new URLSearchParams(raw);
				const code = form.get("code") ?? "";
				const entry = codes.get(code);
				codes.delete(code);
				const pkce =
					provider !== "google" ||
					(form.get("grant_type") === "authorization_code" &&
						s256(form.get("code_verifier") ?? "") === entry?.challenge);
				const good =
					entry &&
					pkce &&
					form.get("client_id") === `${provider}-client` &&
					form.get("client_secret") === `${provider}-secret` &&
					form.get("redirect_uri") === entry.redirect;
				if (!good) {
					return provider === "github"
						? send(200, { error: "bad_verification_code" })
						: send(400, { error: "invalid_grant" });
				}
				const token = randomBytes(16).toString("hex");
				tokens.set(token, entry.account);
				return send(200, { access_token: token, token_type: "bearer" });
			}
			const account = tokens.get((req.headers.authorization ?? "").replace(/^Bearer /, ""));
			if (!account) return send(401, { message: "Bad credentials" });
			if (provider === "github" && !req.headers["user-agent"]) {
				return send(403, { message: "User-Agent required" });
			}
			if (path === "user") return send(200, account.profile);
			if (path === "user/emails" && provider === "github") return send(200, account.emails ?? []);
			return send(404, { message: "Not found" });
		});
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const { port } = server.address() as AddressInfo;
	return {
		base: `http://127.0.0.1:${port}`,
		codes,
		close: () => new Promise<void>((resolve) => server.close(() => resolve())),
	};
}

type Fake = Awaited<ReturnType<typeof fakeProvider>>;

const google = (sub: string, name: string, extra: Record<string, unknown> = {}): Account => ({
	profile: {
		sub,
		name,
		email: `${sub}@example.com`,
		email_verified: true,
		picture: `https://lh3.googleusercontent.com/${sub}`,
		...extra,
	},
});
const github = (id: number, login: string, name: string | null, email?: string): Account => ({
	profile: { id, login, name, avatar_url: `https://avatars.githubusercontent.com/u/${id}` },
	emails: email
		? [
				{ email: `old-${email}`, primary: false, verified: true },
				{ email, primary: true, verified: true },
			]
		: [],
});

/** Start → (fake consent) → callback, as a browser would; returns the redirect's parameters. */
function flows(relay: () => Relay, fake: () => Fake) {
	let n = 0;
	const start = (provider: Provider, body: Record<string, unknown>, token?: string) =>
		request(relay().url, "POST", `/api/auth/oauth/${provider}/start`, { body, token });

	const callback = async (provider: Provider, query: string) => {
		const res = await fetch(`${relay().url}/api/auth/oauth/${provider}/callback?${query}`, {
			redirect: "manual",
		});
		expect(res.status).toBe(302);
		const location = res.headers.get("location") ?? "";
		const url = new URL(location);
		expect(`${url.origin}${url.pathname}`).toBe(`${SITE_URL}/auth/callback`);
		return { location, params: url.searchParams };
	};

	const signIn = async (
		provider: Provider,
		account: Account,
		{ intent = "signin", next, token }: { intent?: string; next?: string; token?: string } = {},
	) => {
		const verifier = randomBytes(32).toString("base64url");
		const res = await start(provider, { intent, next, verifierHash: s256(verifier) }, token);
		expect(res.status, JSON.stringify(res.body)).toBe(200);
		const url = new URL(OAuthStartResponse.parse(res.body).url);
		const redirect = `${relay().url}/api/auth/oauth/${provider}/callback`;
		expect(`${url.origin}${url.pathname}`).toBe(`${fake().base}/${provider}/authorize`);
		expect(url.searchParams.get("client_id")).toBe(`${provider}-client`);
		expect(url.searchParams.get("redirect_uri")).toBe(redirect);
		const state = url.searchParams.get("state") ?? "";
		const challenge = url.searchParams.get("code_challenge");
		if (provider === "google") {
			expect(url.searchParams.get("code_challenge_method")).toBe("S256");
			expect(url.searchParams.get("scope")).toBe("openid email profile");
		} else {
			expect(challenge).toBeNull();
		}
		const code = `code-${++n}`;
		fake().codes.set(code, { account, challenge, redirect });
		const back = await callback(provider, `code=${code}&state=${encodeURIComponent(state)}`);
		return { ...back, verifier, state };
	};

	const exchange = (handoff: string, verifier: string, name = "browser") =>
		request(relay().url, "POST", "/api/auth/oauth/exchange", {
			body: { handoff, verifier, device: device(name) },
		});

	/** A full sign-in that must succeed. */
	const session = async (provider: Provider, account: Account, name = "browser") => {
		const { params, verifier } = await signIn(provider, account);
		expect(params.get("error")).toBeNull();
		const res = await exchange(params.get("handoff") ?? "", verifier, name);
		expect(res.status, JSON.stringify(res.body)).toBe(200);
		return ExchangeResponse.parse(res.body);
	};

	return { start, callback, signIn, exchange, session };
}

const OAUTH_VARS = (base: string) => ({
	ARCASYNC_OAUTH_TEST_BASE: base,
	GOOGLE_CLIENT_ID: "google-client",
	GOOGLE_CLIENT_SECRET: "google-secret",
	GITHUB_CLIENT_ID: "github-client",
	GITHUB_CLIENT_SECRET: "github-secret",
});

describe("OAuth sign-in", () => {
	let relay: Relay;
	let fake: Fake;
	let dir: string;
	const f = flows(
		() => relay,
		() => fake,
	);
	let ada: z.infer<typeof ExchangeResponse>;

	beforeAll(async () => {
		fake = await fakeProvider();
		dir = mkdtempSync(join(tmpdir(), "relay-oauth-"));
		relay = await startRelayDev({
			port: pickPort(26_000),
			persistTo: dir,
			vars: OAUTH_VARS(fake.base),
		});
	});

	afterAll(async () => {
		await relay?.stop();
		await fake?.close();
		rmSync(dir, { recursive: true, force: true });
	});

	const identities = async (token: string) =>
		IdentitiesResponse.parse(await get(relay.url, "/api/auth/identities", token));

	it("lists both providers and open signups in server-info", async () => {
		const info = ServerInfo.parse(await get(relay.url, "/api/server-info"));
		expect(info.auth).toMatchObject({
			providers: ["google", "github"],
			passwords: true,
			signups: "open",
		});
	});

	it("validates start requests", async () => {
		const verifierHash = s256("x".repeat(43));
		expect((await f.start("google", { verifierHash: "short" })).status).toBe(400);
		const unknown = await request(relay.url, "POST", "/api/auth/oauth/gitlab/start", {
			body: { verifierHash },
		});
		expect(unknown.status).toBe(404);
		// Linking needs the account it links to.
		expect((await f.start("github", { intent: "link", verifierHash })).status).toBe(401);
	});

	it("creates an account on first Google sign-in and hands it to the website once", async () => {
		const next = "/approve?code=BCDF-GHJK";
		const { params, location, verifier } = await f.signIn(
			"google",
			google("g-ada", "Ada Lovelace"),
			{ next },
		);
		expect(params.get("error")).toBeNull();
		expect(params.get("next")).toBe(next);
		// Nested `next` is URL-encoded, after the handoff.
		expect(location).toMatch(/\?handoff=[A-Za-z0-9_-]+&next=%2Fapprove%3Fcode%3DBCDF-GHJK$/);
		const handoff = params.get("handoff") ?? "";

		const res = await f.exchange(handoff, verifier, "ada");
		expect(res.status).toBe(200);
		ada = ExchangeResponse.parse(res.body);
		expect(ada.created).toBe(true);
		expect(ada.user).toMatchObject({
			name: "Ada Lovelace",
			email: "g-ada@example.com",
			avatarUrl: "https://lh3.googleusercontent.com/g-ada",
			isAdmin: false,
		});
		expect(ada.workspaces).toEqual([]);
		const me = MeResponse.parse(await get(relay.url, "/api/auth/me", ada.sessionToken));
		expect(me).toMatchObject({ hasPassword: false, device: { name: "ada-device" } });
		expect(await identities(ada.sessionToken)).toEqual({
			identities: [
				{ provider: "google", email: "g-ada@example.com", linkedAt: expect.any(Number) },
			],
			hasPassword: false,
		});

		// The handoff is single use.
		const reused = await f.exchange(handoff, verifier);
		expect(reused.status).toBe(400);
		expect(errorCode(reused.body)).toBe("oauth_failed");
	});

	it("signs the same Google account in again without creating another", async () => {
		const again = await f.session("google", google("g-ada", "Ada Lovelace"));
		expect(again.created).toBe(false);
		expect(again.user.id).toBe(ada.user.id);
	});

	it("binds the handoff to the browser that started it", async () => {
		const { params } = await f.signIn("google", google("g-ada", "Ada Lovelace"));
		const handoff = params.get("handoff") ?? "";
		const other = randomBytes(32).toString("base64url");
		const res = await f.exchange(handoff, other);
		expect(res.status).toBe(400);
		expect(errorCode(res.body)).toBe("oauth_failed");
	});

	it("dedupes names and never links accounts by email", async () => {
		const twin = await f.session(
			"google",
			google("g-twin", "Ada Lovelace", { email: "g-ada@example.com" }),
		);
		expect(twin.created).toBe(true);
		expect(twin.user.id).not.toBe(ada.user.id);
		expect(twin.user.name).toBe("Ada Lovelace 2");
	});

	it("refuses unverified Google addresses, denied consent and used or unknown states", async () => {
		const unverified = await f.signIn(
			"google",
			google("g-unverified", "Eve", { email_verified: false }),
		);
		expect(unverified.params.get("error")).toBe("oauth_failed");
		expect(unverified.params.get("handoff")).toBeNull();

		const verifier = randomBytes(32).toString("base64url");
		const started = await f.start("google", {
			next: "/account",
			verifierHash: s256(verifier),
		});
		const state = new URL(OAuthStartResponse.parse(started.body).url).searchParams.get("state");
		const denied = await f.callback(
			"google",
			`error=access_denied&state=${encodeURIComponent(state ?? "")}`,
		);
		expect(denied.params.get("error")).toBe("oauth_denied");
		expect(denied.params.get("next")).toBe("/account");
		// The state was used up by the denial.
		const replay = await f.callback("google", `code=x&state=${encodeURIComponent(state ?? "")}`);
		expect(replay.params.get("error")).toBe("state_expired");
		expect((await f.callback("google", "code=x&state=nope")).params.get("error")).toBe(
			"state_expired",
		);
		// A code the provider rejects (GitHub answers 200 + error).
		const ghVerifier = randomBytes(32).toString("base64url");
		const gh = await f.start("github", { verifierHash: s256(ghVerifier) });
		const ghState = new URL(OAuthStartResponse.parse(gh.body).url).searchParams.get("state");
		const bad = await f.callback(
			"github",
			`code=unknown&state=${encodeURIComponent(ghState ?? "")}`,
		);
		expect(bad.params.get("error")).toBe("oauth_failed");
	});

	it("signs up with GitHub: login as the name, the primary verified email", async () => {
		const grace = await f.session("github", github(4242, "ghopper", null, "grace@example.com"));
		expect(grace.created).toBe(true);
		expect(grace.user).toMatchObject({
			name: "ghopper",
			email: "grace@example.com",
			avatarUrl: "https://avatars.githubusercontent.com/u/4242",
		});
		const noEmail = await f.session("github", github(4343, "anon", "Anon Ymous"));
		expect(noEmail.user).toMatchObject({ name: "Anon Ymous", email: null });
	});

	it("links and unlinks providers, keeping one way to sign in", async () => {
		const linked = await f.signIn("github", github(777, "ada-gh", "Ada"), {
			intent: "link",
			token: ada.sessionToken,
			next: "/account",
		});
		expect(linked.params.get("error")).toBeNull();
		const res = await f.exchange(linked.params.get("handoff") ?? "", linked.verifier);
		expect(ExchangeResponse.parse(res.body)).toMatchObject({
			created: false,
			user: { id: ada.user.id },
		});
		expect((await identities(ada.sessionToken)).identities.map((i) => i.provider)).toEqual([
			"github",
			"google",
		]);
		// GitHub 777 now signs in as Ada.
		expect((await f.session("github", github(777, "ada-gh", "Ada"))).user.id).toBe(ada.user.id);

		// An identity of someone else cannot be linked.
		const taken = await f.signIn("github", github(4242, "ghopper", null), {
			intent: "link",
			token: ada.sessionToken,
		});
		expect(taken.params.get("error")).toBe("identity_in_use");

		const unlink = (provider: string) =>
			request(relay.url, "DELETE", `/api/auth/identities/${provider}`, {
				token: ada.sessionToken,
			});
		expect(IdentitiesResponse.parse((await unlink("google")).body).identities).toHaveLength(1);
		expect((await unlink("google")).status).toBe(404);
		const last = await unlink("github");
		expect(last.status).toBe(409);
		expect(errorCode(last.body)).toBe("last_sign_in_method");
		await post(relay.url, "/api/auth/password", { new: "correct horse battery" }, ada.sessionToken);
		expect((await unlink("github")).status).toBe(200);
		expect(await identities(ada.sessionToken)).toEqual({ identities: [], hasPassword: true });
	});

	it("renames through PATCH /api/auth/profile (unique, case-insensitively)", async () => {
		const renamed = z
			.object({ user: User })
			.parse(await patch(relay.url, "/api/auth/profile", { name: "Countess" }, ada.sessionToken));
		expect(renamed.user).toMatchObject({ id: ada.user.id, name: "Countess" });
		const clash = await request(relay.url, "PATCH", "/api/auth/profile", {
			body: { name: "GHOPPER" },
			token: ada.sessionToken,
		});
		expect(clash.status).toBe(409);
		expect(errorCode(clash.body)).toBe("name_taken");
		expect(
			(await request(relay.url, "PATCH", "/api/auth/profile", { body: { name: "" } })).status,
		).toBe(400);
	});

	it("an OAuth account creates teams and joins others by invite", async () => {
		const grace = await f.session("github", github(4242, "ghopper", null, "grace@example.com"));
		const team = TeamSummary.parse(
			await post(relay.url, "/api/teams", { name: "Compilers" }, grace.sessionToken),
		);
		await post(relay.url, `/api/teams/${team.id}/folders`, { name: "Specs" }, grace.sessionToken);
		const inv = InviteCreated.parse(
			await post(
				relay.url,
				`/api/teams/${team.id}/invites`,
				{ role: "viewer" },
				grace.sessionToken,
			),
		);
		const joined = WorkspacesResponse.parse(
			await post(relay.url, "/api/invites/redeem", { token: inv.token }, ada.sessionToken),
		);
		expect(joined.workspaces.map((w) => [w.name, w.role])).toEqual([["Specs", "viewer"]]);
	});
});

describe("OAuth with invite-only signups", () => {
	let relay: Relay;
	let fake: Fake;
	let dir: string;
	const f = flows(
		() => relay,
		() => fake,
	);

	beforeAll(async () => {
		fake = await fakeProvider();
		dir = mkdtempSync(join(tmpdir(), "relay-oauth-closed-"));
		relay = await startRelayDev({
			port: pickPort(26_400),
			persistTo: dir,
			vars: { ...OAUTH_VARS(fake.base), ARCASYNC_SIGNUPS: "invite" },
		});
	});

	afterAll(async () => {
		await relay?.stop();
		await fake?.close();
		rmSync(dir, { recursive: true, force: true });
	});

	it("refuses new accounts with signup_closed", async () => {
		const info = ServerInfo.parse(await get(relay.url, "/api/server-info"));
		expect(info.auth?.signups).toBe("invite");
		const { params } = await f.signIn("google", google("g-new", "Newcomer"), { next: "/account" });
		expect(params.get("error")).toBe("signup_closed");
		expect(params.get("next")).toBe("/account");
		expect(params.get("handoff")).toBeNull();
	});
});
