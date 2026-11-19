/**
 * P2 accounts under `wrangler dev --env dev`: bootstrap, invites (create, list, revoke, accept,
 * redeem) and workspace creation.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	AuditResponse,
	InviteCreated,
	InvitesResponse,
	MeResponse,
	SessionResponse,
	WorkspaceSummary,
	WorkspacesResponse,
} from "@arcasync/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startRelayDev } from "../scripts/dev-server.mjs";
import {
	acceptInvite,
	bootstrap,
	DEV_BOOTSTRAP_TOKEN,
	device,
	errorCode,
	get,
	login,
	post,
	request,
} from "./helpers";

const PORT = 23_000 + Math.floor(Math.random() * 400);

type Relay = { url: string; stop: () => Promise<void> };

describe("accounts", () => {
	let relay: Relay;
	let dir: string;
	/** dave: the bootstrap admin, owner of `Team`. */
	let dave: SessionResponse;
	let team: WorkspaceSummary;

	beforeAll(async () => {
		dir = mkdtempSync(join(tmpdir(), "relay-accounts-"));
		relay = await startRelayDev({ port: PORT, persistTo: dir });
	});

	afterAll(async () => {
		await relay?.stop();
		rmSync(dir, { recursive: true, force: true });
	});

	const invite = async (body: Record<string, unknown>, token = dave.sessionToken) =>
		InviteCreated.parse(await post(relay.url, `/api/workspaces/${team.id}/invites`, body, token));
	const accept = (inviteToken: string, name: string) =>
		request(relay.url, "POST", "/api/auth/invite/accept", {
			body: { token: inviteToken, name, device: device(name) },
		});

	describe("bootstrap", () => {
		it("refuses a wrong token", async () => {
			const res = await request(relay.url, "POST", "/api/auth/bootstrap", {
				body: { workspaceName: "Team" },
				token: `${DEV_BOOTSTRAP_TOKEN}x`,
			});
			expect(res.status).toBe(401);
			const none = await request(relay.url, "POST", "/api/auth/bootstrap", {
				body: { workspaceName: "Team" },
			});
			expect(none.status).toBe(401);
		});

		it("creates the first workspace and an owner + admin invite", async () => {
			const boot = await bootstrap(relay.url, "Team");
			team = boot.workspace;
			expect(team).toMatchObject({ name: "Team", slug: "team", role: "owner" });
			expect(boot.invite).toMatchObject({ role: "owner", admin: true, maxUses: 1 });
			expect(boot.invite.url).toBe(
				`obsidian://teamsync?server=${encodeURIComponent(relay.url)}&invite=${boot.invite.token}`,
			);
			expect(boot.invite.expiresAt - Date.now()).toBeGreaterThan(23 * 3600_000);

			dave = await acceptInvite(relay.url, boot.invite.token, "dave");
			const me = MeResponse.parse(await get(relay.url, "/api/auth/me", dave.sessionToken));
			expect(me.user.isAdmin).toBe(true);
			expect(me.device.name).toBe("dave-device");
			expect(me.workspaces).toEqual([team]);

			// Single use.
			const again = await accept(boot.invite.token, "dave2");
			expect(again.status).toBe(410);
			expect(errorCode(again.body)).toBe("invite_used");
		});

		it("is one-shot", async () => {
			const res = await request(relay.url, "POST", "/api/auth/bootstrap", {
				body: { workspaceName: "Other" },
				token: DEV_BOOTSTRAP_TOKEN,
			});
			expect(res.status).toBe(409);
			expect(errorCode(res.body)).toBe("already_bootstrapped");
		});

		it("validates the body", async () => {
			const res = await request(relay.url, "POST", "/api/auth/bootstrap", {
				body: { workspaceName: "" },
				token: DEV_BOOTSTRAP_TOKEN,
			});
			expect(res.status).toBe(400);
			expect(errorCode(res.body)).toBe("bad_request");
		});
	});

	describe("invites", () => {
		it("lets only owners and admins create, list and revoke", async () => {
			const editorInvite = await invite({ role: "editor" });
			expect(editorInvite.url).toMatch(/^obsidian:\/\/teamsync\?server=/);
			const erin = SessionResponse.parse((await accept(editorInvite.token, "erin")).body);
			expect(erin.user.isAdmin).toBe(false);
			expect(erin.workspaces).toEqual([{ ...team, role: "editor" }]);

			const path = `/api/workspaces/${team.id}/invites`;
			const create = await request(relay.url, "POST", path, {
				body: { role: "viewer" },
				token: erin.sessionToken,
			});
			expect(create.status).toBe(403);
			expect((await request(relay.url, "GET", path, { token: erin.sessionToken })).status).toBe(
				403,
			);
			const revoke = await request(relay.url, "DELETE", `${path}/${editorInvite.id}`, {
				token: erin.sessionToken,
			});
			expect(revoke.status).toBe(403);
			expect((await request(relay.url, "GET", path)).status).toBe(401);
		});

		it("counts uses: maxUses 2 admits two people, the third gets 410 invite_used", async () => {
			const inv = await invite({ role: "viewer", maxUses: 2 });
			expect(inv).toMatchObject({ role: "viewer", admin: false, maxUses: 2 });
			const frank = SessionResponse.parse((await accept(inv.token, "frank")).body);
			expect(frank.workspaces[0]?.role).toBe("viewer");
			expect((await accept(inv.token, "gina")).status).toBe(200);
			const third = await accept(inv.token, "hank");
			expect(third.status).toBe(410);
			expect(errorCode(third.body)).toBe("invite_used");

			const { invites } = InvitesResponse.parse(
				await get(relay.url, `/api/workspaces/${team.id}/invites`, dave.sessionToken),
			);
			const listed = invites.find((i) => i.id === inv.id);
			expect(listed).toMatchObject({ uses: 2, maxUses: 2, revoked: false, role: "viewer" });
			expect(listed?.createdBy).toBe(dave.user.id);
			// Lists never carry tokens.
			for (const i of invites) expect(i).not.toHaveProperty("token");
			expect(JSON.stringify(invites)).not.toContain(inv.token);
		});

		it("answers 410 invite_expired after expiry", async () => {
			const inv = await invite({ role: "editor" });
			const expire = await post(
				relay.url,
				`/api/debug/accounts/expire-invite?id=${encodeURIComponent(inv.id)}`,
				{},
			);
			expect(expire).toEqual({ ok: true });
			const res = await accept(inv.token, "ivan");
			expect(res.status).toBe(410);
			expect(errorCode(res.body)).toBe("invite_expired");
		});

		it("answers 404 for a revoked or unknown invite", async () => {
			const inv = await invite({ role: "editor" });
			const res = await request(
				relay.url,
				"DELETE",
				`/api/workspaces/${team.id}/invites/${inv.id}`,
				{ token: dave.sessionToken },
			);
			expect(res).toEqual({ status: 200, body: { ok: true } });
			const { invites } = InvitesResponse.parse(
				await get(relay.url, `/api/workspaces/${team.id}/invites`, dave.sessionToken),
			);
			expect(invites.find((i) => i.id === inv.id)?.revoked).toBe(true);
			expect((await accept(inv.token, "judy")).status).toBe(404);
			expect((await accept("not-a-real-invite-token", "judy")).status).toBe(404);
		});

		it("answers 409 name_taken for an existing name and leaves the invite unused", async () => {
			const inv = await invite({ role: "editor" });
			const res = await accept(inv.token, "dave");
			expect(res.status).toBe(409);
			expect(errorCode(res.body)).toBe("name_taken");
			expect((await accept(inv.token, "kim")).status).toBe(200);
		});

		it("rejects an invalid body", async () => {
			const bad = await request(relay.url, "POST", `/api/workspaces/${team.id}/invites`, {
				body: { role: "admin" },
				token: dave.sessionToken,
			});
			expect(bad.status).toBe(400);
			const noName = await request(relay.url, "POST", "/api/auth/invite/accept", {
				body: { token: "x", device: device("x") },
			});
			expect(noName.status).toBe(400);
		});

		it("redeem adds a workspace to an existing user and never lowers a role", async () => {
			const alice = await login(relay.url, "alice");
			const inv = await invite({ role: "editor" });
			const { workspaces } = WorkspacesResponse.parse(
				await post(
					relay.url,
					"/api/invites/redeem",
					{ token: inv.token },
					alice.session.sessionToken,
				),
			);
			expect(workspaces.map((w) => [w.slug, w.role]).sort()).toEqual([
				["dev", "owner"],
				["team", "editor"],
			]);

			const viewer = await invite({ role: "viewer" });
			const own = WorkspacesResponse.parse(
				await post(relay.url, "/api/invites/redeem", { token: viewer.token }, dave.sessionToken),
			);
			expect(own.workspaces).toEqual([team]);

			const unauth = await request(relay.url, "POST", "/api/invites/redeem", {
				body: { token: inv.token },
			});
			expect(unauth.status).toBe(401);
		});
	});

	describe("admin disable and re-entry", () => {
		it("refuses to let an admin disable themselves", async () => {
			const res = await request(relay.url, "POST", `/api/admin/users/${dave.user.id}/disable`, {
				token: dave.sessionToken,
			});
			expect(res.status).toBe(409);
			expect(errorCode(res.body)).toBe("cannot_disable_self");
			expect(
				(await request(relay.url, "GET", "/api/workspaces", { token: dave.sessionToken })).status,
			).toBe(200);
		});

		it("enable returns a single-use re-entry invite that signs the same user back in", async () => {
			const inv = await invite({ role: "editor" });
			const nora = SessionResponse.parse((await accept(inv.token, "nora")).body);
			const users = (id: string, op: string) => `/api/admin/users/${id}/${op}`;

			const active = await request(relay.url, "POST", users(nora.user.id, "enable"), {
				token: dave.sessionToken,
			});
			expect(active.status).toBe(409);
			expect(errorCode(active.body)).toBe("not_disabled");

			await post(relay.url, users(nora.user.id, "disable"), {}, dave.sessionToken);
			// Accepting a normal invite under the same name still collides.
			const other = await invite({ role: "editor" });
			expect(errorCode((await accept(other.token, "nora")).body)).toBe("name_taken");

			const byNonAdmin = await request(relay.url, "POST", users(nora.user.id, "enable"), {
				token: nora.sessionToken,
			});
			expect([401, 403]).toContain(byNonAdmin.status);
			const reentry = InviteCreated.parse(
				await post(relay.url, users(nora.user.id, "enable"), {}, dave.sessionToken),
			);
			expect(reentry).toMatchObject({ maxUses: 1, admin: false });
			expect(reentry.url).toBe(
				`obsidian://teamsync?server=${encodeURIComponent(relay.url)}&invite=${reentry.token}`,
			);
			expect(reentry.expiresAt - Date.now()).toBeGreaterThan(6.9 * 24 * 3600_000);
			// It is not a workspace invite: an existing user cannot redeem it.
			const redeem = await request(relay.url, "POST", "/api/invites/redeem", {
				body: { token: reentry.token },
				token: dave.sessionToken,
			});
			expect(redeem.status).toBe(404);

			// The `name` is ignored: the session belongs to nora, with her memberships unchanged.
			const back = SessionResponse.parse((await accept(reentry.token, "ignored-name")).body);
			expect(back.user.id).toBe(nora.user.id);
			expect(back.user.name).toBe("nora");
			expect(back.workspaces).toEqual([{ ...team, role: "editor" }]);
			const me = MeResponse.parse(await get(relay.url, "/api/auth/me", back.sessionToken));
			expect(me.user.id).toBe(nora.user.id);
			const ws = await request(relay.url, "POST", "/api/auth/ws-token", {
				body: { workspaceId: team.id },
				token: back.sessionToken,
			});
			expect(ws.status).toBe(200);
			// The old session stays revoked; the invite is single-use.
			expect(
				(await request(relay.url, "GET", "/api/workspaces", { token: nora.sessionToken })).status,
			).toBe(401);
			const again = await accept(reentry.token, "nora");
			expect(again.status).toBe(410);
			expect(errorCode(again.body)).toBe("invite_used");
			const { invites } = InvitesResponse.parse(
				await get(relay.url, `/api/workspaces/${team.id}/invites`, dave.sessionToken),
			);
			expect(invites.find((i) => i.id === reentry.id)).toBeUndefined();

			const { entries } = AuditResponse.parse(
				await get(relay.url, "/api/admin/audit", dave.sessionToken),
			);
			expect(
				entries.find((e) => e.action === "user.enable" && e.target === nora.user.id),
			).toMatchObject({
				actorId: dave.user.id,
				details: { inviteId: reentry.id },
			});
			expect(entries.find((e) => e.action === "user.reenter")).toMatchObject({
				actorId: nora.user.id,
				target: nora.user.id,
				details: { inviteId: reentry.id },
			});
		});

		it("a re-entry invite is refused while the user is disabled again", async () => {
			const inv = await invite({ role: "viewer" });
			const olga = SessionResponse.parse((await accept(inv.token, "olga")).body);
			const path = (op: string) => `/api/admin/users/${olga.user.id}/${op}`;
			await post(relay.url, path("disable"), {}, dave.sessionToken);
			const reentry = InviteCreated.parse(
				await post(relay.url, path("enable"), {}, dave.sessionToken),
			);
			await post(relay.url, path("disable"), {}, dave.sessionToken);
			expect((await accept(reentry.token, "olga")).status).toBe(403);
		});
	});

	describe("workspaces", () => {
		it("lets an admin create a workspace and owns it; others get 403", async () => {
			const created = WorkspaceSummary.parse(
				await post(relay.url, "/api/workspaces", { name: "Team" }, dave.sessionToken),
			);
			expect(created).toMatchObject({ name: "Team", slug: "team-2", role: "owner" });
			// `/api/workspaces`, not the 60 s-cached `/me` (D10).
			const { workspaces } = WorkspacesResponse.parse(
				await get(relay.url, "/api/workspaces", dave.sessionToken),
			);
			expect(workspaces.map((w) => w.slug).sort()).toEqual(["team", "team-2"]);

			const inv = await invite({ role: "editor" });
			const leo = SessionResponse.parse((await accept(inv.token, "leo")).body);
			const res = await request(relay.url, "POST", "/api/workspaces", {
				body: { name: "Mine" },
				token: leo.sessionToken,
			});
			expect(res.status).toBe(403);
		});
	});
});

describe("bootstrap without ARCASYNC_BOOTSTRAP_TOKEN", () => {
	let relay: Relay;
	let dir: string;

	beforeAll(async () => {
		dir = mkdtempSync(join(tmpdir(), "relay-accounts-"));
		relay = await startRelayDev({
			port: PORT + 500,
			persistTo: dir,
			vars: { ARCASYNC_BOOTSTRAP_TOKEN: "" },
		});
	});

	afterAll(async () => {
		await relay?.stop();
		rmSync(dir, { recursive: true, force: true });
	});

	it("answers 404", async () => {
		const res = await request(relay.url, "POST", "/api/auth/bootstrap", {
			body: { workspaceName: "Team" },
			token: DEV_BOOTSTRAP_TOKEN,
		});
		expect(res.status).toBe(404);
	});
});
