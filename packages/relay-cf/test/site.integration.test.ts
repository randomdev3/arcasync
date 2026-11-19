/**
 * The website (packages/site, on Cloudflare Pages) calls this relay cross-origin: CORS for
 * `/api/*` allows only `ARCASYNC_SITE_ORIGINS` (plus Obsidian and localhost), with a cached
 * preflight. Invite and device-code links point at `ARCASYNC_PUBLIC_URL`, or fall back to the
 * plugin's `obsidian://arcasync` deep links when it is unset. Then the browser flows over HTTP.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	BootstrapResponse,
	DeviceCodeResponse,
	DeviceLookupResponse,
	SessionResponse,
} from "@arcasync/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startRelayDev } from "../scripts/dev-server.mjs";
import { bootstrap, DEV_BOOTSTRAP_TOKEN, get, post, SITE_URL } from "./helpers";

const PORT = 26_400 + Math.floor(Math.random() * 400);
const SITE = "https://site.example";
const EVIL = "https://evil.example";

type Relay = { url: string; stop: () => Promise<void> };
let relay: Relay;
let bare: Relay;
let boot: BootstrapResponse;
const dirs: string[] = [];

function tempDir() {
	const dir = mkdtempSync(join(tmpdir(), "relay-site-"));
	dirs.push(dir);
	return dir;
}

beforeAll(async () => {
	relay = await startRelayDev({
		port: PORT,
		persistTo: tempDir(),
		vars: { ARCASYNC_SITE_ORIGINS: `${SITE}/, http://localhost:4173` },
	});
	// No website configured: links fall back to deep links.
	bare = await startRelayDev({
		port: PORT + 1,
		persistTo: tempDir(),
		vars: { ARCASYNC_PUBLIC_URL: "", ARCASYNC_SITE_ORIGINS: "" },
	});
	boot = await bootstrap(relay.url, "Team");
});

afterAll(async () => {
	await relay?.stop();
	await bare?.stop();
	for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

const preflight = (base: string, origin: string, path = "/api/auth/me") =>
	fetch(`${base}${path}`, {
		method: "OPTIONS",
		headers: {
			Origin: origin,
			"Access-Control-Request-Method": "POST",
			"Access-Control-Request-Headers": "authorization,content-type",
		},
	});

describe("CORS for the website", () => {
	it("answers a preflight from an allowed site origin, cacheable for 2 h", async () => {
		const res = await preflight(relay.url, SITE, "/api/auth/invite/accept");
		expect(res.status).toBe(204);
		expect(res.headers.get("access-control-allow-origin")).toBe(SITE);
		const headers = res.headers.get("access-control-allow-headers")?.toLowerCase() ?? "";
		expect(headers).toContain("authorization");
		expect(headers).toContain("content-type");
		expect(res.headers.get("access-control-allow-methods")).toContain("POST");
		expect(res.headers.get("access-control-max-age")).toBe("7200");
	});

	it("never reflects an origin that is not allowed", async () => {
		const res = await preflight(relay.url, EVIL);
		expect(res.headers.get("access-control-allow-origin")).not.toBe(EVIL);
		const get = await fetch(`${relay.url}/api/health`, { headers: { Origin: EVIL } });
		expect(get.headers.get("access-control-allow-origin")).not.toBe(EVIL);
		await get.body?.cancel();
	});

	it("allows the site on real requests, and nothing extra when no site is configured", async () => {
		const ok = await fetch(`${relay.url}/api/health`, { headers: { Origin: SITE } });
		expect(ok.headers.get("access-control-allow-origin")).toBe(SITE);
		await ok.body?.cancel();
		const res = await preflight(bare.url, SITE);
		expect(res.headers.get("access-control-allow-origin")).not.toBe(SITE);
	});
});

describe("links", () => {
	it("point at the website when ARCASYNC_PUBLIC_URL is set", async () => {
		expect(boot.invite.url).toBe(`${SITE_URL}/join?invite=${boot.invite.token}`);
		const code = DeviceCodeResponse.parse(
			await post(relay.url, "/api/auth/device/start", {
				device: { name: "phone", platform: "ios", vaultId: "phone-vault" },
			}),
		);
		expect(code.verificationUri).toBe(`${SITE_URL}/approve?code=${code.userCode}`);
	});

	it("fall back to obsidian://arcasync deep links without a website", async () => {
		const bareBoot = BootstrapResponse.parse(
			await post(bare.url, "/api/auth/bootstrap", { workspaceName: "Team" }, DEV_BOOTSTRAP_TOKEN),
		);
		expect(bareBoot.invite.url).toBe(
			`obsidian://arcasync?server=${encodeURIComponent(bare.url)}&invite=${bareBoot.invite.token}`,
		);
		const code = DeviceCodeResponse.parse(
			await post(bare.url, "/api/auth/device/start", {
				device: { name: "phone", platform: "ios", vaultId: "phone-vault" },
			}),
		);
		expect(code.verificationUri).toBe(`obsidian://arcasync?approve=${code.userCode}`);
	});
});

describe("browser flows over HTTP", () => {
	const browser = (name: string) => ({
		name: `Browser · ${name}`,
		platform: "unknown" as const,
		vaultId: `web-${crypto.randomUUID()}`,
	});

	it("accepts an invite from a browser, which then approves an Obsidian sign-in", async () => {
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
