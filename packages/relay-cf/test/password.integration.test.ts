/**
 * Passwords under `wrangler dev --env dev`: set and change (other sessions revoked, `me` cache
 * dropped), name + password sign-in with uniform 401s, the per-name and per-IP limits, re-entry
 * clearing a forgotten password, and the migration on an AccountsDO that predates passwords.
 */

import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
	AuditResponse,
	InviteCreated,
	MeResponse,
	PinSummary,
	SessionResponse,
} from "@arcasync/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startRelayDev } from "../scripts/dev-server.mjs";
import { acceptInvite, bootstrap, device, errorCode, get, post, request } from "./helpers";

const PORT = 23_800 + Math.floor(Math.random() * 400);
const PASSWORD = "correct horse battery";
const NEW_PASSWORD = "tr0ub4dor & three";

type Relay = { url: string; stop: () => Promise<void> };

describe("passwords", () => {
	let relay: Relay;
	let dir: string;
	let dave: SessionResponse;
	let erin: SessionResponse;
	let ipSeq = 0;
	const freshIp = () => `10.9.0.${++ipSeq}`;

	beforeAll(async () => {
		dir = mkdtempSync(join(tmpdir(), "relay-password-"));
		relay = await startRelayDev({ port: PORT, persistTo: dir });
		const boot = await bootstrap(relay.url, "Team");
		dave = await acceptInvite(relay.url, boot.invite.token, "dave");
		const inv = InviteCreated.parse(
			await post(
				relay.url,
				`/api/workspaces/${boot.workspace.id}/invites`,
				{ role: "editor" },
				dave.sessionToken,
			),
		);
		erin = await acceptInvite(relay.url, inv.token, "erin");
	});

	afterAll(async () => {
		await relay?.stop();
		rmSync(dir, { recursive: true, force: true });
	});

	const login = (name: string, password: string, ip = freshIp()) =>
		request(relay.url, "POST", "/api/auth/login", {
			body: { name, password, device: device(name.toLowerCase()) },
			headers: { "X-Test-Client-IP": ip },
		});
	const setPassword = (token: string, next: string, current?: string) =>
		request(relay.url, "POST", "/api/auth/password", {
			body: current === undefined ? { new: next } : { current, new: next },
			token,
			headers: { "X-Test-Client-IP": freshIp() },
		});
	const me = async (token: string) => MeResponse.parse(await get(relay.url, "/api/auth/me", token));
	const age = (ms: number) => post(relay.url, `/api/debug/accounts/age-limits?ms=${ms}`, {});
	const uncached = async (token: string) =>
		(await request(relay.url, "GET", "/api/workspaces", { token })).status;

	describe("set and change", () => {
		it("sets a first password without `current`; `me` shows it at once", async () => {
			// Cached first: the change must drop the cached `me`.
			expect((await me(dave.sessionToken)).hasPassword).toBe(false);
			for (const weak of ["short", "x".repeat(257), "1234567890"]) {
				const res = await setPassword(dave.sessionToken, weak);
				expect(res.status).toBe(400);
				expect(errorCode(res.body)).toBe("weak_password");
			}
			const res = await setPassword(dave.sessionToken, PASSWORD);
			expect(res).toEqual({ status: 200, body: { ok: true } });
			expect((await me(dave.sessionToken)).hasPassword).toBe(true);
			expect(
				(await request(relay.url, "POST", "/api/auth/password", { body: { new: PASSWORD } }))
					.status,
			).toBe(401);
		});

		it("signs in by name (any case) and password", async () => {
			const res = await login("DaVe", PASSWORD);
			expect(res.status).toBe(200);
			const session = SessionResponse.parse(res.body);
			expect(session.user.id).toBe(dave.user.id);
			expect(session.workspaces.map((w) => w.name)).toEqual(["Team"]);
			expect((await me(session.sessionToken)).device.name).toBe("dave-device");
		});

		it("changing needs the current password (403, not 401) and revokes the other sessions", async () => {
			const b = SessionResponse.parse((await login("dave", PASSWORD)).body);
			const c = SessionResponse.parse((await login("dave", PASSWORD)).body);
			await me(dave.sessionToken); // cached in this isolate
			const missing = await setPassword(b.sessionToken, NEW_PASSWORD);
			expect(missing.status).toBe(403);
			expect(errorCode(missing.body)).toBe("invalid_credentials");
			const wrong = await setPassword(b.sessionToken, NEW_PASSWORD, "not the password");
			expect(wrong.status).toBe(403);
			expect(errorCode(wrong.body)).toBe("invalid_credentials");

			expect((await setPassword(b.sessionToken, NEW_PASSWORD, PASSWORD)).status).toBe(200);
			expect(await uncached(b.sessionToken)).toBe(200);
			expect(await uncached(c.sessionToken)).toBe(401);
			expect(await uncached(dave.sessionToken)).toBe(401);
			// Its cached `me` was dropped too.
			expect(
				(await request(relay.url, "GET", "/api/auth/me", { token: dave.sessionToken })).status,
			).toBe(401);

			expect((await login("dave", PASSWORD)).status).toBe(401);
			dave = SessionResponse.parse((await login("dave", NEW_PASSWORD)).body);
		});
	});

	describe("sign-in failures", () => {
		it("answers one uniform 401 for wrong password, unknown name, no password and short input", async () => {
			const wrong = await login("dave", "wrong password!");
			expect(wrong.status).toBe(401);
			for (const res of [
				await login("nobody-here", NEW_PASSWORD),
				await login("erin", NEW_PASSWORD), // erin has no password
				await login("dave", "x"), // too short to set, but sign-in never says so
			]) {
				expect(res).toEqual(wrong);
			}
			expect(errorCode(wrong.body)).toBe("invalid_credentials");
			const bad = await request(relay.url, "POST", "/api/auth/login", {
				body: { name: "dave", password: "" },
			});
			expect(bad.status).toBe(400);
		});

		it("limits 5 failures per name per 15 min (any IP); a success clears only itself", async () => {
			await age(15 * 60_000);
			for (let i = 0; i < 4; i++) expect((await login("dave", "wrong password!")).status).toBe(401);
			expect((await login("dave", NEW_PASSWORD)).status).toBe(200);
			expect((await login("dave", "wrong password!")).status).toBe(401);
			const limited = await login("dave", NEW_PASSWORD);
			expect(limited.status).toBe(429);
			expect(errorCode(limited.body)).toBe("rate_limited");
			const retry = Number(limited.headers.get("retry-after"));
			expect(retry).toBeGreaterThan(800);
			expect(retry).toBeLessThanOrEqual(900);
			// Other names are not limited.
			expect((await login("erin", NEW_PASSWORD)).status).toBe(401);
			await age(15 * 60_000);
			expect((await login("dave", NEW_PASSWORD)).status).toBe(200);
		});

		it("limits 20 failures per IP per 15 min across names", async () => {
			const ip = freshIp();
			for (let i = 0; i < 20; i++)
				expect((await login(`spray-${i}`, "guess guess", ip)).status).toBe(401);
			const limited = await login("dave", NEW_PASSWORD, ip);
			expect(limited.status).toBe(429);
			expect((await login("dave", NEW_PASSWORD)).status).toBe(200);
			await age(15 * 60_000);
			expect((await login("dave", NEW_PASSWORD, ip)).status).toBe(200);
		});

		it("counts parallel guesses before hashing: 10 at once get 5 × 401 and 5 × 429", async () => {
			await age(15 * 60_000);
			const results = await Promise.all(
				Array.from({ length: 10 }, () => login("dave", "parallel guess")),
			);
			const statuses = results.map((r) => r.status).sort();
			expect(statuses).toEqual([401, 401, 401, 401, 401, 429, 429, 429, 429, 429]);
			await age(15 * 60_000);
		});

		it("audits failures in aggregate, never passwords", async () => {
			const { entries } = AuditResponse.parse(
				await get(relay.url, "/api/admin/audit?limit=100", dave.sessionToken),
			);
			const limited = entries.filter((e) => e.action === "auth.login.limited");
			expect(limited.length).toBeGreaterThan(0);
			expect(limited.length).toBeLessThan(6);
			expect(entries.some((e) => e.action === "user.login")).toBe(true);
			expect(entries.some((e) => e.action === "user.password.set")).toBe(true);
			expect(entries.some((e) => e.action === "user.password.change")).toBe(true);
			const text = JSON.stringify(entries);
			for (const secret of [PASSWORD, NEW_PASSWORD, "wrong password!"]) {
				expect(text).not.toContain(secret);
			}
		});
	});

	describe("disabled users and re-entry", () => {
		it("a disabled user gets the uniform 401; re-entry clears the password for a new one", async () => {
			expect((await setPassword(erin.sessionToken, PASSWORD)).status).toBe(200);
			expect((await login("erin", PASSWORD)).status).toBe(200);
			await post(relay.url, `/api/admin/users/${erin.user.id}/disable`, {}, dave.sessionToken);
			const disabled = await login("erin", PASSWORD);
			expect(disabled.status).toBe(401);
			expect(errorCode(disabled.body)).toBe("invalid_credentials");

			const reentry = InviteCreated.parse(
				await post(relay.url, `/api/admin/users/${erin.user.id}/enable`, {}, dave.sessionToken),
			);
			erin = await acceptInvite(relay.url, reentry.token, "erin");
			expect((await me(erin.sessionToken)).hasPassword).toBe(false);
			expect((await login("erin", PASSWORD)).status).toBe(401);
			expect((await setPassword(erin.sessionToken, NEW_PASSWORD)).status).toBe(200);
			expect((await login("erin", NEW_PASSWORD)).status).toBe(200);
		});
	});

	describe("migration", () => {
		it("an AccountsDO without the new tables gets them on wake and keeps its data", async () => {
			await relay.stop();
			const doDir = readdirSync(join(dir, "v3", "do")).find((d) => d.endsWith("AccountsDO"));
			if (!doDir) throw new Error("no AccountsDO state");
			const file = readdirSync(join(dir, "v3", "do", doDir)).find((f) => f.endsWith(".sqlite"));
			if (!file) throw new Error("no AccountsDO sqlite file");
			const db = new DatabaseSync(join(dir, "v3", "do", doDir, file));
			const users = db.prepare("SELECT COUNT(*) AS n FROM users").get();
			for (const t of ["user_passwords", "invite_pins", "pin_failures", "login_failures"]) {
				db.exec(`DROP TABLE ${t}`);
			}
			db.close();

			relay = await startRelayDev({ port: PORT, persistTo: dir });
			// Old sessions, users and memberships are intact; passwords are gone with the table.
			const after = await me(dave.sessionToken);
			expect(after.user.id).toBe(dave.user.id);
			expect(after.hasPassword).toBe(false);
			expect(after.workspaces.map((w) => w.name)).toEqual(["Team"]);
			expect((await login("dave", NEW_PASSWORD)).status).toBe(401);
			expect((await setPassword(dave.sessionToken, PASSWORD)).status).toBe(200);
			expect((await login("dave", PASSWORD)).status).toBe(200);
			PinSummary.parse(
				await post(
					relay.url,
					`/api/workspaces/${after.workspaces[0]?.id}/pins`,
					{ role: "viewer" },
					dave.sessionToken,
				),
			);
			const reopened = new DatabaseSync(join(dir, "v3", "do", doDir, file), { readOnly: true });
			expect(reopened.prepare("SELECT COUNT(*) AS n FROM users").get()).toEqual(users);
			reopened.close();
		});
	});
});
