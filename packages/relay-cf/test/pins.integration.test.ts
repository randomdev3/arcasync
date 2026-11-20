/**
 * PIN invites under `wrangler dev --env dev`: create, list, revoke, accept (new user + password),
 * redeem (signed-in user), uniform `invalid_pin`, the per-IP limit, the server-wide lock and its
 * expiry and admin unlock. Client IPs come from `X-Test-Client-IP` (honoured with debug stats on).
 * The lock threshold (500 in production) is lowered to `LOCK_AFTER` through the dev-only
 * `ARCASYNC_PIN_LOCK_THRESHOLD`.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	AuditResponse,
	InviteCreated,
	MeResponse,
	PinSummary,
	PinsResponse,
	ServerInfo,
	SessionResponse,
	WorkspaceSummary,
	WorkspacesResponse,
} from "@arcasync/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startRelayDev } from "../scripts/dev-server.mjs";
import { acceptInvite, bootstrap, del, device, errorCode, get, post, request } from "./helpers";

const PORT = 23_400 + Math.floor(Math.random() * 400);
const PASSWORD = "correct horse battery";
const LOCK_AFTER = 20;

type Relay = { url: string; stop: () => Promise<void> };

describe("PIN invites", () => {
	let relay: Relay;
	let dir: string;
	/** Admin owner of Team. */
	let dave: SessionResponse;
	/** Editor of Team (link invite), not an owner. */
	let erin: SessionResponse;
	/** Owner of Team, not a server admin. */
	let olga: SessionResponse;
	let team: WorkspaceSummary;
	let second: WorkspaceSummary;
	let ipSeq = 0;
	/** A client IP no earlier request used. */
	const freshIp = () => `10.1.0.${++ipSeq}`;

	beforeAll(async () => {
		dir = mkdtempSync(join(tmpdir(), "relay-pins-"));
		relay = await startRelayDev({
			port: PORT,
			persistTo: dir,
			vars: { ARCASYNC_PIN_LOCK_THRESHOLD: String(LOCK_AFTER) },
		});
		const boot = await bootstrap(relay.url, "Team");
		team = boot.workspace;
		dave = await acceptInvite(relay.url, boot.invite.token, "dave");
		const linkInvite = async (role: string) =>
			InviteCreated.parse(
				await post(relay.url, `/api/workspaces/${team.id}/invites`, { role }, dave.sessionToken),
			).token;
		erin = await acceptInvite(relay.url, await linkInvite("editor"), "erin");
		olga = await acceptInvite(relay.url, await linkInvite("owner"), "olga");
		second = WorkspaceSummary.parse(
			await post(relay.url, "/api/workspaces", { name: "Second" }, dave.sessionToken),
		);
	});

	afterAll(async () => {
		await relay?.stop();
		rmSync(dir, { recursive: true, force: true });
	});

	const pinsPath = (ws = team.id) => `/api/workspaces/${ws}/pins`;
	const createPin = async (
		body: Record<string, unknown>,
		ws = team.id,
		token = dave.sessionToken,
	) => PinSummary.parse(await post(relay.url, pinsPath(ws), body, token));
	const listPins = async (ws = team.id, token = dave.sessionToken) =>
		PinsResponse.parse(await get(relay.url, pinsPath(ws), token));
	const acceptPin = (pin: string, name: string, ip = freshIp(), password = PASSWORD) =>
		request(relay.url, "POST", "/api/auth/pin/accept", {
			body: { pin, name, password, device: device(name) },
			headers: { "X-Test-Client-IP": ip },
		});
	const redeemPin = (pin: string, token: string | undefined, ip = freshIp()) =>
		request(relay.url, "POST", "/api/invites/redeem-pin", {
			body: { pin },
			token,
			headers: { "X-Test-Client-IP": ip },
		});
	/** Every usable PIN on the server (dave is an admin, so he lists both workspaces). */
	const activePins = async () => {
		const now = Date.now();
		const all = [...(await listPins(team.id)).pins, ...(await listPins(second.id)).pins];
		return all.filter((p) => !p.revoked && p.usedAt === null && p.expiresAt > now);
	};
	/** A 6-digit PIN that is not usable right now. */
	const wrongPin = async () => {
		const active = new Set((await activePins()).map((p) => p.pin));
		for (;;) {
			const pin = String(Math.floor(Math.random() * 1_000_000)).padStart(6, "0");
			if (!active.has(pin)) return pin;
		}
	};
	const unlock = () => post(relay.url, "/api/admin/pins/unlock", {}, dave.sessionToken);
	const age = (ms: number) => post(relay.url, `/api/debug/accounts/age-limits?ms=${ms}`, {});

	it("advertises features.pins and features.passwords", async () => {
		const info = ServerInfo.parse(await get(relay.url, "/api/server-info"));
		expect(info.features).toMatchObject({ pins: true, passwords: true });
	});

	describe("create, list, revoke", () => {
		it("creates a 6-digit, 72 h, single-use PIN for owners and admins only", async () => {
			const before = Date.now();
			const pin = await createPin({ role: "editor" });
			expect(pin.pin).toMatch(/^[0-9]{6}$/);
			expect(pin).toMatchObject({
				workspaceId: team.id,
				role: "editor",
				admin: false,
				createdBy: dave.user.id,
				usedAt: null,
				usedBy: null,
				revoked: false,
			});
			expect(pin.expiresAt - before).toBeGreaterThanOrEqual(72 * 3600_000 - 1000);
			expect(pin.expiresAt - before).toBeLessThanOrEqual(72 * 3600_000 + 5000);

			const byOwner = await createPin(
				{ role: "viewer", expiresInSec: 600 },
				team.id,
				olga.sessionToken,
			);
			expect(byOwner.createdBy).toBe(olga.user.id);

			for (const [method, body] of [
				["POST", { role: "viewer" }],
				["GET", undefined],
			] as const) {
				const res = await request(relay.url, method, pinsPath(), {
					body,
					token: erin.sessionToken,
				});
				expect(res.status).toBe(403);
			}
			expect((await request(relay.url, "GET", pinsPath())).status).toBe(401);
			// An owner may not mint admin PINs; a server admin may.
			const adminByOwner = await request(relay.url, "POST", pinsPath(), {
				body: { role: "editor", admin: true },
				token: olga.sessionToken,
			});
			expect(adminByOwner.status).toBe(403);
			expect((await createPin({ role: "editor", admin: true })).admin).toBe(true);
			// Bad bodies.
			for (const body of [{ role: "admin" }, { role: "editor", expiresInSec: 2_592_001 }]) {
				expect(
					(await request(relay.url, "POST", pinsPath(), { body, token: dave.sessionToken })).status,
				).toBe(400);
			}

			const { pins, locked, lockedUntil } = await listPins();
			expect(locked).toBe(false);
			expect(lockedUntil).toBeNull();
			expect(pins.map((p) => p.id)).toEqual(expect.arrayContaining([pin.id, byOwner.id]));
			// Newest first.
			expect(pins[0]?.createdAt).toBeGreaterThanOrEqual(pins[pins.length - 1]?.createdAt ?? 0);
		});

		it("revoke makes the PIN invalid; only managers revoke", async () => {
			const pin = await createPin({ role: "editor" });
			const path = `${pinsPath()}/${pin.id}`;
			expect((await request(relay.url, "DELETE", path, { token: erin.sessionToken })).status).toBe(
				403,
			);
			expect(await del(relay.url, path, dave.sessionToken)).toEqual({ ok: true });
			expect((await listPins()).pins.find((p) => p.id === pin.id)?.revoked).toBe(true);
			const res = await acceptPin(pin.pin, "rita");
			expect(res.status).toBe(404);
			expect(errorCode(res.body)).toBe("invalid_pin");
			expect(
				(await request(relay.url, "DELETE", `${pinsPath()}/nope`, { token: dave.sessionToken }))
					.status,
			).toBe(404);
		});

		it("allows at most 10 usable PINs per team (409 too_many_pins)", async () => {
			const usableIn = async (ws: string) => {
				const now = Date.now();
				return (await listPins(ws)).pins.filter(
					(p) => !p.revoked && p.usedAt === null && p.expiresAt > now,
				);
			};
			let active = (await usableIn(team.id)).length;
			while (active < 10) {
				await createPin({ role: "viewer" });
				active += 1;
			}
			const pins = await usableIn(team.id);
			expect(pins).toHaveLength(10);
			expect(new Set(pins.map((p) => p.pin)).size).toBe(10);
			const res = await request(relay.url, "POST", pinsPath(), {
				body: { role: "viewer" },
				token: dave.sessionToken,
			});
			expect(res.status).toBe(409);
			expect(errorCode(res.body)).toBe("too_many_pins");
			// Another team (Second is a team of its own) still has room.
			await createPin({ role: "viewer" }, second.id);
			for (const p of await activePins()) {
				await del(relay.url, `${pinsPath(p.workspaceId)}/${p.id}`, dave.sessionToken);
			}
			expect(await activePins()).toHaveLength(0);
		});
	});

	describe("accept", () => {
		it("creates the user with a password, single use; the PIN lists who used it", async () => {
			const pin = await createPin({ role: "editor" });
			const weak = await acceptPin(pin.pin, "pia", freshIp(), "short");
			expect(weak.status).toBe(400);
			expect(errorCode(weak.body)).toBe("weak_password");
			const common = await acceptPin(pin.pin, "pia", freshIp(), "Password123");
			expect(errorCode(common.body)).toBe("weak_password");
			const taken = await acceptPin(pin.pin, "DAVE");
			expect(taken.status).toBe(409);
			expect(errorCode(taken.body)).toBe("name_taken");

			const res = await acceptPin(pin.pin, "pia");
			expect(res.status).toBe(200);
			const pia = SessionResponse.parse(res.body);
			expect(pia.user).toMatchObject({ name: "pia", isAdmin: false });
			expect(pia.workspaces).toEqual([{ ...team, role: "editor" }]);
			const me = MeResponse.parse(await get(relay.url, "/api/auth/me", pia.sessionToken));
			expect(me.hasPassword).toBe(true);
			expect(me.device.name).toBe("pia-device");

			const listed = (await listPins()).pins.find((p) => p.id === pin.id);
			expect(listed?.usedBy).toBe("pia");
			expect(listed?.usedAt).toBeGreaterThan(0);

			const again = await acceptPin(pin.pin, "pia2");
			expect(again.status).toBe(404);
			expect(errorCode(again.body)).toBe("invalid_pin");
			// The password signs in.
			const login = await request(relay.url, "POST", "/api/auth/login", {
				body: { name: "PIA", password: PASSWORD, device: device("pia") },
				headers: { "X-Test-Client-IP": freshIp() },
			});
			expect(SessionResponse.parse(login.body).user.id).toBe(pia.user.id);
		});

		it("an admin PIN makes a server admin", async () => {
			const pin = await createPin({ role: "owner", admin: true });
			const res = await acceptPin(pin.pin, "adam");
			const adam = SessionResponse.parse(res.body);
			expect(adam.user.isAdmin).toBe(true);
			expect(adam.workspaces[0]?.role).toBe("owner");
		});

		it("answers the same 404 invalid_pin for unknown, used, revoked and expired PINs", async () => {
			const expired = await createPin({ role: "editor" });
			await post(relay.url, `/api/debug/accounts/expire-pin?id=${expired.id}`, {});
			const bodies = [];
			for (const pin of [expired.pin, await wrongPin()]) {
				const res = await acceptPin(pin, "nobody");
				expect(res.status).toBe(404);
				bodies.push(res.body);
			}
			expect(bodies[0]).toEqual(bodies[1]);
			// A malformed PIN is a 400, not a counted guess.
			for (const pin of ["123", "12345", "abcd"]) {
				expect((await acceptPin(pin, "nobody")).status).toBe(400);
			}
		});
	});

	describe("redeem", () => {
		it("adds the PIN's workspace to a signed-in user and never lowers a role", async () => {
			const viewer = await createPin({ role: "viewer" }, second.id);
			const res = await redeemPin(viewer.pin, erin.sessionToken);
			expect(res.status).toBe(200);
			expect(
				WorkspacesResponse.parse(res.body)
					.workspaces.map((w) => [w.name, w.role])
					.sort(),
			).toEqual([
				["Second", "viewer"],
				["Team", "editor"],
			]);
			// A viewer PIN to Team keeps erin an editor there.
			const lower = await createPin({ role: "viewer" });
			const kept = WorkspacesResponse.parse((await redeemPin(lower.pin, erin.sessionToken)).body);
			expect(kept.workspaces.find((w) => w.id === team.id)?.role).toBe("editor");
			expect((await listPins()).pins.find((p) => p.id === lower.id)?.usedBy).toBe("erin");

			const unauth = await redeemPin((await createPin({ role: "viewer" })).pin, undefined);
			expect(unauth.status).toBe(401);
			const wrong = await redeemPin(await wrongPin(), erin.sessionToken);
			expect(wrong.status).toBe(404);
			expect(errorCode(wrong.body)).toBe("invalid_pin");
		});
	});

	describe("brute-force limits", () => {
		it("allows 5 wrong PINs per IP per 15 min, then 429 with Retry-After", async () => {
			await unlock();
			const ip = freshIp();
			for (let i = 0; i < 5; i++) {
				const res = await acceptPin(await wrongPin(), "guess", ip);
				expect(res.status).toBe(404);
			}
			const good = await createPin({ role: "viewer" });
			const limited = await acceptPin(good.pin, "guess", ip);
			expect(limited.status).toBe(429);
			expect(errorCode(limited.body)).toBe("rate_limited");
			const retry = Number(limited.headers.get("retry-after"));
			expect(retry).toBeGreaterThan(800);
			expect(retry).toBeLessThanOrEqual(900);
			expect(limited.body).toMatchObject({ error: { details: { retryAfter: retry } } });
			// The redeem route shares the bucket.
			expect((await redeemPin(good.pin, erin.sessionToken, ip)).status).toBe(429);
			// Another IP is not limited; after 15 min this one is not either.
			await age(15 * 60_000);
			expect((await acceptPin(good.pin, "guess", ip)).status).toBe(200);
		});

		it("locks all PIN entry after LOCK_AFTER wrong PINs in 24 h (successes do not count)", async () => {
			await unlock();
			const good = await createPin({ role: "viewer" });
			const later = await createPin({ role: "viewer" });
			// 19 wrong PINs from 4 IPs, then a success, then one more wrong one.
			for (let i = 0; i < 19; i++) {
				if (i % 5 === 0) ipSeq += 1;
				expect((await acceptPin(await wrongPin(), "guess", `10.2.0.${ipSeq}`)).status).toBe(404);
			}
			expect((await acceptPin(good.pin, "lucky")).status).toBe(200);
			expect((await listPins()).locked).toBe(false);
			expect((await acceptPin(await wrongPin(), "guess")).status).toBe(404);

			const { locked, lockedUntil } = await listPins();
			expect(locked).toBe(true);
			expect((lockedUntil ?? 0) - Date.now()).toBeGreaterThan(23.9 * 3600_000);
			const res = await acceptPin(later.pin, "late");
			expect(res.status).toBe(423);
			expect(errorCode(res.body)).toBe("pins_locked");
			expect(Number(res.headers.get("retry-after"))).toBeGreaterThan(86_000);
			expect((await redeemPin(later.pin, erin.sessionToken)).status).toBe(423);

			// Only admins unlock.
			const byOwner = await request(relay.url, "POST", "/api/admin/pins/unlock", {
				token: olga.sessionToken,
			});
			expect(byOwner.status).toBe(403);
			await unlock();
			expect((await listPins()).locked).toBe(false);
			// The unlock reset the window: one more wrong PIN does not re-lock.
			expect((await acceptPin(await wrongPin(), "guess")).status).toBe(404);
			expect((await acceptPin(later.pin, "late")).status).toBe(200);
		});

		it("the lock ends by itself after 24 h", async () => {
			await unlock();
			for (let i = 0; i < 20; i++) {
				if (i % 5 === 0) ipSeq += 1;
				await acceptPin(await wrongPin(), "guess", `10.3.0.${ipSeq}`);
			}
			expect((await listPins()).locked).toBe(true);
			await age(24 * 3600_000 + 1000);
			expect((await listPins()).locked).toBe(false);
			const pin = await createPin({ role: "viewer" });
			expect((await acceptPin(pin.pin, "after-lock")).status).toBe(200);
		});
	});

	it("audits create, revoke, accept, redeem, lock and unlock without PIN digits", async () => {
		const entries: AuditResponse["entries"] = [];
		for (let before: number | null = null; ; ) {
			const page: AuditResponse = AuditResponse.parse(
				await get(
					relay.url,
					`/api/admin/audit?limit=100${before === null ? "" : `&before=${before}`}`,
					dave.sessionToken,
				),
			);
			entries.push(...page.entries);
			if (page.next === null) break;
			before = page.next;
		}
		const actions = new Set(entries.map((e) => e.action));
		for (const action of [
			"pin.create",
			"pin.revoke",
			"pin.accept",
			"pin.redeem",
			"pin.lock",
			"pin.unlock",
			"pin.limited",
		]) {
			expect(actions, action).toContain(action);
		}
		for (const e of entries.filter((x) => x.action.startsWith("pin."))) {
			expect(Object.keys(e.details as object)).not.toContain("pin");
		}
		// Failures are aggregated: far fewer audit rows than wrong PINs.
		expect(entries.filter((e) => e.action === "pin.limited").length).toBeLessThan(15);
	});
});
