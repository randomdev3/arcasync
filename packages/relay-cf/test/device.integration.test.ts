/**
 * P2-3: device-code sign-in (start, poll cadence, lookup, approve/deny, expiry, lookup rate
 * limit), the Worker's `me` cache and `features.accounts`.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	DEVICE_CODE_INTERVAL_S,
	DeviceCodeResponse,
	DeviceLookupResponse,
	InviteCreated,
	MeResponse,
	ServerInfo,
	type SessionResponse,
} from "@arcasync/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startRelayDev } from "../scripts/dev-server.mjs";
import {
	acceptInvite,
	bootstrap,
	device,
	errorCode,
	get,
	post,
	request,
	SITE_URL,
	sleep,
} from "./helpers";

const PORT = 26_000 + Math.floor(Math.random() * 400);
const TTL_S = 20;

type Relay = { url: string; stop: () => Promise<void> };
let relay: Relay;
let dir: string;
/** alice: bootstrap admin, the approver. */
let alice: SessionResponse;
let teamId: string;
/** Started in `beforeAll`, polled after its TTL by the last test. */
let expiring: { code: DeviceCodeResponse; startedAt: number };

const start = async (name: string) =>
	DeviceCodeResponse.parse(
		await post(relay.url, "/api/auth/device/start", { device: device(name) }),
	);
const poll = (deviceCode: string) =>
	request(relay.url, "POST", "/api/auth/device/poll", { body: { deviceCode } });
const lookup = (userCode: string, token: string) =>
	request(relay.url, "GET", `/api/auth/device/lookup?userCode=${encodeURIComponent(userCode)}`, {
		token,
	});
const approve = (userCode: string, ok: boolean, token = alice.sessionToken) =>
	post(relay.url, "/api/auth/device/approve", { userCode, approve: ok }, token);

async function joinTeam(name: string): Promise<SessionResponse> {
	const invite = InviteCreated.parse(
		await post(
			relay.url,
			`/api/workspaces/${teamId}/invites`,
			{ role: "editor" },
			alice.sessionToken,
		),
	);
	return acceptInvite(relay.url, invite.token, name);
}

const calls = async () =>
	((await get(relay.url, "/api/debug/accounts")) as { calls: number }).calls;

beforeAll(async () => {
	dir = mkdtempSync(join(tmpdir(), "relay-device-"));
	relay = await startRelayDev({
		port: PORT,
		persistTo: dir,
		vars: { ARCASYNC_DEVICE_CODE_TTL_S: String(TTL_S) },
	});
	const boot = await bootstrap(relay.url, "Team");
	teamId = boot.workspace.id;
	alice = await acceptInvite(relay.url, boot.invite.token, "alice");
	expiring = { code: await start("expiring"), startedAt: Date.now() };
});

afterAll(async () => {
	await relay?.stop();
	rmSync(dir, { recursive: true, force: true });
});

describe("device-code sign-in", () => {
	it("starts with a user code, an approve link and the server's interval", async () => {
		const code = await start("phone");
		expect(code.userCode).toMatch(/^[BCDFGHJKLMNPQRSTVWXZ]{4}-[BCDFGHJKLMNPQRSTVWXZ]{4}$/);
		expect(code.verificationUri).toBe(`${SITE_URL}/approve?code=${code.userCode}`);
		expect(code.interval).toBe(DEVICE_CODE_INTERVAL_S);
		expect(code.expiresIn).toBe(TTL_S);
		const bad = await request(relay.url, "POST", "/api/auth/device/start", { body: {} });
		expect(bad.status).toBe(400);
	});

	it("approve: pending, slow_down, lookup, then a session for the approver", async () => {
		const code = await start("phone");
		const first = await poll(code.deviceCode);
		const firstAt = Date.now();
		expect(first.status).toBe(400);
		expect(errorCode(first.body)).toBe("authorization_pending");
		const tooSoon = await poll(code.deviceCode);
		expect(tooSoon.status).toBe(400);
		expect(errorCode(tooSoon.body)).toBe("slow_down");

		// Case and dash do not matter.
		const shown = await lookup(code.userCode.toLowerCase().replace("-", ""), alice.sessionToken);
		expect(shown.status).toBe(200);
		expect(DeviceLookupResponse.parse(shown.body)).toMatchObject({
			device: { name: "phone-device", platform: "macos" },
		});
		expect(await approve(code.userCode, true)).toEqual({ ok: true });

		await sleep(Math.max(0, firstAt + DEVICE_CODE_INTERVAL_S * 1000 + 100 - Date.now()));
		const done = await poll(code.deviceCode);
		expect(done.status).toBe(200);
		const session = done.body as SessionResponse;
		expect(session.user.id).toBe(alice.user.id);
		const me = MeResponse.parse(await get(relay.url, "/api/auth/me", session.sessionToken));
		expect(me.user.id).toBe(alice.user.id);
		expect(me.device.name).toBe("phone-device");
		expect(me.device.id).not.toBe(
			MeResponse.parse(await get(relay.url, "/api/auth/me", alice.sessionToken)).device.id,
		);

		await sleep(DEVICE_CODE_INTERVAL_S * 1000 + 100);
		const replay = await poll(code.deviceCode);
		expect(replay.status).toBe(400);
		expect(errorCode(replay.body)).toBe("expired_token");
		// A spent code cannot be looked up or approved again.
		expect((await lookup(code.userCode, alice.sessionToken)).status).toBe(404);
	});

	it("deny: access_denied", async () => {
		const code = await start("tablet");
		expect(await approve(code.userCode, false)).toEqual({ ok: true });
		const res = await poll(code.deviceCode);
		expect(res.status).toBe(400);
		expect(errorCode(res.body)).toBe("access_denied");
	});

	it("needs a session to look up or approve", async () => {
		const code = await start("laptop");
		const anon = await request(relay.url, "POST", "/api/auth/device/approve", {
			body: { userCode: code.userCode, approve: true },
		});
		expect(anon.status).toBe(401);
		expect(
			(await request(relay.url, "GET", `/api/auth/device/lookup?userCode=${code.userCode}`)).status,
		).toBe(401);
	});

	it("limits lookups to 5 per minute per session", async () => {
		const bob = await joinTeam("bob");
		for (let i = 0; i < 5; i++) {
			expect((await lookup("BBBB-BBBB", bob.sessionToken)).status).toBe(404);
		}
		const sixth = await lookup("BBBB-BBBB", bob.sessionToken);
		expect(sixth.status).toBe(429);
		// Another session is not affected.
		expect((await lookup("BBBB-BBBB", alice.sessionToken)).status).toBe(404);
	});

	it("caches /me for 60 s per session and drops it on logout", async () => {
		const carol = await joinTeam("carol");
		const before = await calls();
		const a = MeResponse.parse(await get(relay.url, "/api/auth/me", carol.sessionToken));
		const b = MeResponse.parse(await get(relay.url, "/api/auth/me", carol.sessionToken));
		expect(b).toEqual(a);
		expect((await calls()) - before).toBe(1);

		await post(relay.url, "/api/auth/logout", {}, carol.sessionToken);
		const after = await request(relay.url, "GET", "/api/auth/me", { token: carol.sessionToken });
		expect(after.status).toBe(401);
		// Errors are not cached: each 401 asks the DO again.
		const n = await calls();
		await request(relay.url, "GET", "/api/auth/me", { token: carol.sessionToken });
		expect((await calls()) - n).toBe(1);
	});

	it("advertises features.accounts", async () => {
		const info = ServerInfo.parse(await get(relay.url, "/api/server-info"));
		expect(info.features.accounts).toBe(true);
	});

	it("expires an unapproved code after its TTL", async () => {
		await sleep(Math.max(0, expiring.startedAt + (TTL_S + 1) * 1000 - Date.now()));
		const res = await poll(expiring.code.deviceCode);
		expect(res.status).toBe(400);
		expect(errorCode(res.body)).toBe("expired_token");
		expect((await lookup(expiring.code.userCode, alice.sessionToken)).status).toBe(404);
	});
});
