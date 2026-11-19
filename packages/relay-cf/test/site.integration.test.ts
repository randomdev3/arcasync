/**
 * The website (packages/site) served by Workers static assets under `wrangler dev`: clean URLs
 * answer 200, `_headers` is applied, unknown paths get the HTML 404 from the asset layer, and only
 * `/api/*` and `/ws` reach the Worker. A second relay with a broken secret (every Worker response
 * is a 503) proves that static pages never invoke the Worker. Then the browser flows over HTTP:
 * invite links and device-code links point at the site.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DeviceCodeResponse, DeviceLookupResponse, SessionResponse } from "@arcasync/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startRelayDev } from "../scripts/dev-server.mjs";
import { bootstrap, errorCode, get, post, request } from "./helpers";

const PORT = 26_400 + Math.floor(Math.random() * 400);

type Relay = { url: string; stop: () => Promise<void> };
let relay: Relay;
let broken: Relay;
const dirs: string[] = [];

const PAGES = ["/", "/join?invite=abc", "/guide", "/signin", "/approve", "/account"];

function tempDir() {
	const dir = mkdtempSync(join(tmpdir(), "relay-site-"));
	dirs.push(dir);
	return dir;
}

/** No redirect following: `/join` must be a 200, never a 307 to `/join/`. */
const fetchRaw = (base: string, path: string, init: RequestInit = {}) =>
	fetch(`${base}${path}`, { redirect: "manual", ...init });

beforeAll(async () => {
	relay = await startRelayDev({ port: PORT, persistTo: tempDir() });
	// A secret the config check rejects: every request the Worker handles answers 503.
	broken = await startRelayDev({
		port: PORT + 1,
		persistTo: tempDir(),
		vars: { ARCASYNC_SECRET: "too-short", ARCASYNC_ALLOW_DEV_SECRET: "0" },
	});
});

afterAll(async () => {
	await relay?.stop();
	await broken?.stop();
	for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

describe("static site", () => {
	it("serves the landing page with the security headers from _headers", async () => {
		const res = await fetchRaw(relay.url, "/");
		expect(res.status).toBe(200);
		expect(res.headers.get("content-type")).toMatch(/^text\/html/);
		expect(await res.text()).toContain("<title>ArcaSync");
		expect(res.headers.get("content-security-policy")).toContain("script-src 'self'");
		expect(res.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
		expect(res.headers.get("referrer-policy")).toBe("no-referrer");
		expect(res.headers.get("x-content-type-options")).toBe("nosniff");
	});

	it("answers every page at its clean URL with a 200 (no trailing-slash redirect)", async () => {
		for (const path of PAGES) {
			const res = await fetchRaw(relay.url, path);
			expect(res.status, path).toBe(200);
			expect(res.headers.get("content-type"), path).toMatch(/^text\/html/);
			await res.body?.cancel();
		}
	});

	it("answers unknown paths with the HTML 404 page, not the Worker's JSON", async () => {
		const res = await fetchRaw(relay.url, "/definitely-not-here");
		expect(res.status).toBe(404);
		expect(res.headers.get("content-type")).toMatch(/^text\/html/);
		const body = await res.text();
		expect(body).toContain("<title>ArcaSync");
		expect(body).not.toContain('"error"');
	});

	it("serves every referenced script and stylesheet, immutable", async () => {
		const html = await (await fetchRaw(relay.url, "/")).text();
		const assets = [...html.matchAll(/(?:src|href)="(\/assets\/[^"]+\.(?:js|css))"/g)].map(
			(m) => m[1] ?? "",
		);
		expect(assets.length).toBeGreaterThan(0);
		for (const path of assets) {
			const res = await fetchRaw(relay.url, path);
			expect(res.status, path).toBe(200);
			expect(res.headers.get("cache-control"), path).toContain("immutable");
			await res.body?.cancel();
		}
	});

	it("still routes /api/* and /ws to the Worker", async () => {
		expect(await get(relay.url, "/api/health")).toMatchObject({ ok: true });
		const nope = await request(relay.url, "GET", "/api/nope");
		expect(nope.status).toBe(404);
		expect(errorCode(nope.body)).toBe("not_found");
		const ws = await request(relay.url, "GET", "/ws");
		expect(ws.status).toBe(426);
		expect(errorCode(ws.body)).toBe("bad_request");
	});

	it("never invokes the Worker for static pages (a relay whose Worker only answers 503)", async () => {
		for (const path of [...PAGES, "/favicon.svg", "/theme.js"]) {
			const res = await fetchRaw(broken.url, path);
			expect(res.status, path).toBe(200);
			await res.body?.cancel();
		}
		const missing = await fetchRaw(broken.url, "/definitely-not-here");
		expect(missing.status).toBe(404);
		expect(missing.headers.get("content-type")).toMatch(/^text\/html/);
		await missing.body?.cancel();
		// The Worker itself is up and refusing: the static answers above did not come from it.
		for (const path of ["/api/nope", "/api/auth/me", "/ws"]) {
			const res = await request(broken.url, "GET", path);
			expect(res.status, path).toBe(503);
			expect(errorCode(res.body), path).toBe("misconfigured");
		}
	});
});

describe("browser flows over HTTP", () => {
	const browser = (name: string) => ({
		name: `Browser · ${name}`,
		platform: "unknown" as const,
		vaultId: `web-${crypto.randomUUID()}`,
	});

	it("links invites and device codes to the site, and a browser session approves a device", async () => {
		const boot = await bootstrap(relay.url, "Team");
		expect(boot.invite.url).toBe(`${relay.url}/join?invite=${boot.invite.token}`);

		const web = SessionResponse.parse(
			await post(relay.url, "/api/auth/invite/accept", {
				token: boot.invite.token,
				name: "wendy",
				device: browser("Firefox"),
			}),
		);
		expect(web.user.name).toBe("wendy");

		const code = DeviceCodeResponse.parse(
			await post(relay.url, "/api/auth/device/start", {
				device: { name: "wendy-laptop", platform: "macos", vaultId: "wendy-vault" },
			}),
		);
		expect(code.verificationUri).toBe(`${relay.url}/approve?code=${code.userCode}`);

		const found = DeviceLookupResponse.parse(
			await get(
				relay.url,
				`/api/auth/device/lookup?userCode=${encodeURIComponent(code.userCode)}`,
				web.sessionToken,
			),
		);
		expect(found.device).toEqual({ name: "wendy-laptop", platform: "macos" });
		await post(
			relay.url,
			"/api/auth/device/approve",
			{ userCode: code.userCode, approve: true },
			web.sessionToken,
		);
		const laptop = SessionResponse.parse(
			await post(relay.url, "/api/auth/device/poll", { deviceCode: code.deviceCode }),
		);
		expect(laptop.user.id).toBe(web.user.id);
	});
});
