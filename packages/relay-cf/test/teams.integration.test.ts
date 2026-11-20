/**
 * Teams under `wrangler dev --env dev`: CRUD, team roles fanned out to every folder, team
 * invites and PINs, the older folder routes acting on the folder's team, the caps, and the
 * one-time migration that gives every pre-team workspace a team of its own.
 */
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
	InviteCreated,
	InvitesResponse,
	MembersResponse,
	PinSummary,
	PinsResponse,
	ServerInfo,
	SessionResponse,
	SharedFolderSummary,
	TeamMembersResponse,
	TeamSummary,
	TeamsResponse,
	WorkspaceSummary,
	WorkspacesResponse,
} from "@arcasync/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startRelayDev } from "../scripts/dev-server.mjs";
import {
	acceptInvite,
	bootstrap,
	del,
	device,
	errorCode,
	get,
	patch,
	post,
	request,
} from "./helpers";

const PASSWORD = "correct horse battery";
const pickPort = (base: number) => base + Math.floor(Math.random() * 400);

type Relay = { url: string; stop: () => Promise<void> };

/** Calls bound to one relay. */
function api(relay: () => Relay) {
	let ip = 0;
	const url = () => relay().url;
	return {
		teams: async (token: string) =>
			TeamsResponse.parse(await get(url(), "/api/teams", token)).teams,
		/** `/api/workspaces`, not the 60 s-cached `/me` (D10). */
		folders: async (token: string) =>
			WorkspacesResponse.parse(await get(url(), "/api/workspaces", token)).workspaces,
		wsToken: (token: string, workspaceId: string) =>
			request(url(), "POST", "/api/auth/ws-token", { body: { workspaceId }, token }),
		invite: async (path: string, role: string, token: string, maxUses = 1) =>
			InviteCreated.parse(await post(url(), path, { role, maxUses }, token)),
		pin: async (path: string, role: string, token: string) =>
			PinSummary.parse(await post(url(), path, { role }, token)),
		acceptPin: (pin: string, name: string) =>
			request(url(), "POST", "/api/auth/pin/accept", {
				body: { pin, name, password: PASSWORD, device: device(name) },
				headers: { "X-Test-Client-IP": `10.7.0.${++ip}` },
			}),
		redeemPin: (pin: string, token: string) =>
			request(url(), "POST", "/api/invites/redeem-pin", {
				body: { pin },
				token,
				headers: { "X-Test-Client-IP": `10.7.1.${++ip}` },
			}),
	};
}

const byId = (a: { id: string }, b: { id: string }) => a.id.localeCompare(b.id);

describe("teams", () => {
	let relay: Relay;
	let dir: string;
	const a = api(() => relay);
	/** Server admin, owner of the bootstrap team. */
	let dave: SessionResponse;
	/** Not an admin: owns Alpha. */
	let ann: SessionResponse;
	/** Joins Alpha through a team invite. */
	let bob: SessionResponse;
	let home: WorkspaceSummary;
	let alpha: TeamSummary;
	let notes: SharedFolderSummary;
	let docs: SharedFolderSummary;

	beforeAll(async () => {
		dir = mkdtempSync(join(tmpdir(), "relay-teams-"));
		relay = await startRelayDev({ port: pickPort(24_800), persistTo: dir });
		const boot = await bootstrap(relay.url, "Team");
		home = boot.workspace;
		dave = await acceptInvite(relay.url, boot.invite.token, "dave");
		const inv = await a.invite(`/api/workspaces/${home.id}/invites`, "editor", dave.sessionToken);
		ann = await acceptInvite(relay.url, inv.token, "ann");
	});

	afterAll(async () => {
		await relay?.stop();
		rmSync(dir, { recursive: true, force: true });
	});

	it("advertises teams, sign-in methods and the default caps", async () => {
		const info = ServerInfo.parse(await get(relay.url, "/api/server-info"));
		expect(info.features.teams).toBe(true);
		expect(info.auth).toEqual({
			providers: [],
			passwords: true,
			signups: "open",
			limits: { teamsPerUser: 3, membersPerTeam: 25, foldersPerTeam: 10 },
		});
	});

	it("gives the bootstrap workspace a team of its own", async () => {
		expect(await a.teams(dave.sessionToken)).toEqual([
			expect.objectContaining({
				name: "Team",
				role: "owner",
				memberCount: 2,
				folders: [{ id: home.id, slug: home.slug, name: home.name }],
			}),
		]);
		expect((await a.teams(ann.sessionToken))[0]).toMatchObject({ name: "Team", role: "editor" });
		expect((await request(relay.url, "GET", "/api/teams")).status).toBe(401);
	});

	it("creates a team owned by the caller; a team invite joins every folder", async () => {
		alpha = TeamSummary.parse(
			await post(relay.url, "/api/teams", { name: "  Alpha  " }, ann.sessionToken),
		);
		expect(alpha).toMatchObject({
			name: "Alpha",
			slug: "alpha",
			role: "owner",
			memberCount: 1,
			folders: [],
		});
		for (const body of [{ name: "" }, { name: "x".repeat(61) }, {}]) {
			const res = await request(relay.url, "POST", "/api/teams", { body, token: ann.sessionToken });
			expect(res.status).toBe(400);
		}

		notes = SharedFolderSummary.parse(
			await post(relay.url, `/api/teams/${alpha.id}/folders`, { name: "Notes" }, ann.sessionToken),
		);
		expect(notes).toMatchObject({ name: "Notes", slug: "notes" });
		expect((await a.folders(ann.sessionToken)).find((w) => w.id === notes.id)?.role).toBe("owner");

		const inv = await a.invite(`/api/teams/${alpha.id}/invites`, "editor", ann.sessionToken);
		bob = await acceptInvite(relay.url, inv.token, "bob");
		expect(bob.workspaces).toEqual([{ ...notes, role: "editor" }]);

		// Editors add folders too; every member gets each new one in their team role.
		docs = SharedFolderSummary.parse(
			await post(relay.url, `/api/teams/${alpha.id}/folders`, { name: "Docs" }, bob.sessionToken),
		);
		const bobs = await a.folders(bob.sessionToken);
		expect(bobs.map((w) => [w.name, w.role]).sort()).toEqual([
			["Docs", "editor"],
			["Notes", "editor"],
		]);
		expect((await a.folders(ann.sessionToken)).find((w) => w.id === docs.id)?.role).toBe("owner");
		expect((await a.wsToken(bob.sessionToken, docs.id)).status).toBe(200);
		// A server admin outside the team gets nothing.
		expect((await a.folders(dave.sessionToken)).map((w) => w.id)).toEqual([home.id]);

		const seen = (await a.teams(bob.sessionToken)).find((t) => t.id === alpha.id);
		expect(seen).toMatchObject({ role: "editor", memberCount: 2 });
		expect(seen?.folders.map((f) => f.name)).toEqual(["Docs", "Notes"]);

		// The team's invites are listed by the team route and by each folder's route.
		const teamInvites = InvitesResponse.parse(
			await get(relay.url, `/api/teams/${alpha.id}/invites`, ann.sessionToken),
		);
		const folderInvites = InvitesResponse.parse(
			await get(relay.url, `/api/workspaces/${docs.id}/invites`, ann.sessionToken),
		);
		expect(teamInvites.invites.map((i) => i.id)).toContain(inv.id);
		expect(folderInvites.invites.map((i) => i.id)).toContain(inv.id);
	});

	it("lists members; role changes fan out to every folder from either route", async () => {
		const { members } = TeamMembersResponse.parse(
			await get(relay.url, `/api/teams/${alpha.id}/members`, bob.sessionToken),
		);
		expect(members.map((m) => [m.user.name, m.role])).toEqual([
			["ann", "owner"],
			["bob", "editor"],
		]);
		expect(members[0]?.user).toEqual({
			id: ann.user.id,
			name: "ann",
			email: null,
			color: ann.user.color,
			avatarUrl: null,
		});

		expect(
			await patch(
				relay.url,
				`/api/teams/${alpha.id}/members/${bob.user.id}`,
				{ role: "viewer" },
				ann.sessionToken,
			),
		).toEqual({ ok: true });
		expect((await a.folders(bob.sessionToken)).map((w) => w.role)).toEqual(["viewer", "viewer"]);

		for (const [method, path, body] of [
			["POST", `/api/teams/${alpha.id}/folders`, { name: "X" }],
			["PATCH", `/api/teams/${alpha.id}`, { name: "Mine" }],
			["PATCH", `/api/teams/${alpha.id}/members/${ann.user.id}`, { role: "viewer" }],
			["DELETE", `/api/teams/${alpha.id}/folders/${docs.id}`, undefined],
			["DELETE", `/api/teams/${alpha.id}`, undefined],
			["POST", `/api/teams/${alpha.id}/pins`, { role: "viewer" }],
			["POST", `/api/teams/${alpha.id}/invites`, { role: "viewer" }],
			["GET", `/api/teams/${alpha.id}/invites`, undefined],
		] as const) {
			const res = await request(relay.url, method, path, { body, token: bob.sessionToken });
			expect(res.status, `${method} ${path}`).toBe(403);
		}

		// The folder route changes the role in the folder's team, so in both folders.
		expect(
			await patch(
				relay.url,
				`/api/workspaces/${docs.id}/members/${bob.user.id}`,
				{ role: "editor" },
				ann.sessionToken,
			),
		).toEqual({ ok: true });
		expect((await a.folders(bob.sessionToken)).map((w) => w.role)).toEqual(["editor", "editor"]);
		const old = MembersResponse.parse(
			await get(relay.url, `/api/workspaces/${notes.id}/members`, bob.sessionToken),
		);
		expect(old.members.map((m) => [m.user.name, m.role])).toEqual([
			["ann", "owner"],
			["bob", "editor"],
		]);

		// Outsiders do not see a team.
		const homeTeam = (await a.teams(dave.sessionToken))[0];
		const outsider = await request(relay.url, "GET", `/api/teams/${homeTeam?.id}/members`, {
			token: bob.sessionToken,
		});
		expect(outsider.status).toBe(404);
	});

	it("renames a team and keeps its last owner", async () => {
		const renamed = TeamSummary.parse(
			await patch(relay.url, `/api/teams/${alpha.id}`, { name: "Alpha Co" }, ann.sessionToken),
		);
		expect(renamed).toMatchObject({ id: alpha.id, name: "Alpha Co", slug: "alpha", role: "owner" });
		const demote = await request(
			relay.url,
			"PATCH",
			`/api/teams/${alpha.id}/members/${ann.user.id}`,
			{ body: { role: "editor" }, token: ann.sessionToken },
		);
		expect(demote.status).toBe(409);
		expect(errorCode(demote.body)).toBe("last_owner");
		const leave = await request(
			relay.url,
			"DELETE",
			`/api/teams/${alpha.id}/members/${ann.user.id}`,
			{ token: ann.sessionToken },
		);
		expect(leave.status).toBe(409);
		expect(errorCode(leave.body)).toBe("last_owner");
	});

	it("team PINs have 6 digits and join the team, by accept and by redeem", async () => {
		const pinsPath = `/api/teams/${alpha.id}/pins`;
		const viewer = await a.pin(pinsPath, "viewer", ann.sessionToken);
		expect(viewer.pin).toMatch(/^[0-9]{6}$/);
		expect(viewer.workspaceId).toBe("");

		const accepted = await a.acceptPin(viewer.pin, "cat");
		expect(accepted.status).toBe(200);
		const cat = SessionResponse.parse(accepted.body);
		expect(cat.workspaces.map((w) => [w.name, w.role]).sort()).toEqual([
			["Docs", "viewer"],
			["Notes", "viewer"],
		]);
		const listed = PinsResponse.parse(await get(relay.url, pinsPath, ann.sessionToken));
		expect(listed.pins.find((p) => p.id === viewer.id)?.usedBy).toBe("cat");
		// Listed through a folder route, a team PIN names that folder.
		const viaFolder = PinsResponse.parse(
			await get(relay.url, `/api/workspaces/${notes.id}/pins`, ann.sessionToken),
		);
		expect(viaFolder.pins.find((p) => p.id === viewer.id)?.workspaceId).toBe(notes.id);

		const editor = await a.pin(pinsPath, "editor", ann.sessionToken);
		const redeemed = await a.redeemPin(editor.pin, dave.sessionToken);
		expect(redeemed.status).toBe(200);
		const daves = WorkspacesResponse.parse(redeemed.body).workspaces;
		expect(daves.filter((w) => w.id !== home.id).map((w) => w.role)).toEqual(["editor", "editor"]);

		const spare = await a.pin(pinsPath, "viewer", ann.sessionToken);
		expect(await del(relay.url, `${pinsPath}/${spare.id}`, ann.sessionToken)).toEqual({ ok: true });
		expect((await a.acceptPin(spare.pin, "late")).status).toBe(404);
	});

	it("folder routes still create invites and remove members, on the folder's team", async () => {
		const inv = await a.invite(`/api/workspaces/${docs.id}/invites`, "viewer", ann.sessionToken);
		const dee = await acceptInvite(relay.url, inv.token, "dee");
		expect(dee.workspaces.map((w) => w.name).sort()).toEqual(["Docs", "Notes"]);
		// Removing through one folder removes from the team, so from both folders.
		expect(
			await del(relay.url, `/api/workspaces/${notes.id}/members/${dee.user.id}`, ann.sessionToken),
		).toEqual({ ok: true });
		expect(await a.folders(dee.sessionToken)).toEqual([]);

		// A revoked team invite no longer works.
		const revoked = await a.invite(`/api/teams/${alpha.id}/invites`, "viewer", ann.sessionToken);
		expect(
			await del(relay.url, `/api/teams/${alpha.id}/invites/${revoked.id}`, ann.sessionToken),
		).toEqual({ ok: true });
		const res = await request(relay.url, "POST", "/api/auth/invite/accept", {
			body: { token: revoked.token, name: "eve", device: device("eve") },
		});
		expect(res.status).toBe(404);
	});

	it("leaving, deleting a folder and deleting the team take access away", async () => {
		expect(
			await del(relay.url, `/api/teams/${alpha.id}/members/${bob.user.id}`, bob.sessionToken),
		).toEqual({ ok: true });
		expect(await a.folders(bob.sessionToken)).toEqual([]);
		expect(await a.teams(bob.sessionToken)).toEqual([]);
		expect((await a.wsToken(bob.sessionToken, notes.id)).status).toBe(404);

		expect(
			await del(relay.url, `/api/teams/${alpha.id}/folders/${docs.id}`, ann.sessionToken),
		).toEqual({ ok: true });
		expect((await a.wsToken(ann.sessionToken, docs.id)).status).toBe(404);
		const left = (await a.teams(ann.sessionToken)).find((t) => t.id === alpha.id);
		expect(left?.folders.map((f) => f.id)).toEqual([notes.id]);
		const again = await request(relay.url, "DELETE", `/api/teams/${alpha.id}/folders/${docs.id}`, {
			token: ann.sessionToken,
		});
		expect(again.status).toBe(404);

		expect(await del(relay.url, `/api/teams/${alpha.id}`, ann.sessionToken)).toEqual({ ok: true });
		expect((await a.teams(ann.sessionToken)).map((t) => t.id)).not.toContain(alpha.id);
		expect((await a.wsToken(ann.sessionToken, notes.id)).status).toBe(404);
		expect((await a.folders(dave.sessionToken)).map((w) => w.id)).toEqual([home.id]);
		const gone = await request(relay.url, "GET", `/api/teams/${alpha.id}/members`, {
			token: ann.sessionToken,
		});
		expect(gone.status).toBe(404);
	});
});

describe("team caps", () => {
	let relay: Relay;
	let dir: string;
	const a = api(() => relay);
	let dave: SessionResponse;
	let ann: SessionResponse;
	let home: WorkspaceSummary;

	beforeAll(async () => {
		dir = mkdtempSync(join(tmpdir(), "relay-team-caps-"));
		relay = await startRelayDev({
			port: pickPort(25_200),
			persistTo: dir,
			vars: {
				ARCASYNC_TEAMS_PER_USER: "2",
				ARCASYNC_MEMBERS_PER_TEAM: "3",
				ARCASYNC_FOLDERS_PER_TEAM: "2",
				ARCASYNC_MAX_USERS: "5",
			},
		});
		const boot = await bootstrap(relay.url, "Team");
		home = boot.workspace;
		dave = await acceptInvite(relay.url, boot.invite.token, "dave");
		const inv = await a.invite(`/api/workspaces/${home.id}/invites`, "editor", dave.sessionToken);
		ann = await acceptInvite(relay.url, inv.token, "ann");
	});

	afterAll(async () => {
		await relay?.stop();
		rmSync(dir, { recursive: true, force: true });
	});

	const createTeam = (name: string, token: string) =>
		request(relay.url, "POST", "/api/teams", { body: { name }, token });
	const expectLimit = (res: { status: number; body: unknown }, code = "limit_reached") => {
		expect(res.status).toBe(409);
		expect(errorCode(res.body)).toBe(code);
	};
	let first: TeamSummary;

	it("are in server-info", async () => {
		const info = ServerInfo.parse(await get(relay.url, "/api/server-info"));
		expect(info.auth?.limits).toEqual({ teamsPerUser: 2, membersPerTeam: 3, foldersPerTeam: 2 });
	});

	it("limits the teams a user owns (server admins exempt)", async () => {
		first = TeamSummary.parse((await createTeam("One", ann.sessionToken)).body);
		expect((await createTeam("Two", ann.sessionToken)).status).toBe(200);
		expectLimit(await createTeam("Three", ann.sessionToken));
		for (const name of ["D1", "D2", "D3"]) {
			expect((await createTeam(name, dave.sessionToken)).status).toBe(200);
		}
	});

	it("limits the folders of a team", async () => {
		const path = `/api/teams/${first.id}/folders`;
		for (const name of ["F1", "F2"]) await post(relay.url, path, { name }, ann.sessionToken);
		expectLimit(
			await request(relay.url, "POST", path, { body: { name: "F3" }, token: ann.sessionToken }),
		);
	});

	it("limits the members of a team, for new and existing users", async () => {
		const inv = await a.invite(`/api/teams/${first.id}/invites`, "editor", ann.sessionToken, 5);
		await acceptInvite(relay.url, inv.token, "m2");
		await acceptInvite(relay.url, inv.token, "m3");
		expectLimit(
			await request(relay.url, "POST", "/api/auth/invite/accept", {
				body: { token: inv.token, name: "m4", device: device("m4") },
			}),
		);
		expectLimit(
			await request(relay.url, "POST", "/api/invites/redeem", {
				body: { token: inv.token },
				token: dave.sessionToken,
			}),
		);
		const pin = await a.pin(`/api/teams/${first.id}/pins`, "viewer", ann.sessionToken);
		expectLimit(await a.acceptPin(pin.pin, "m5"));
		expectLimit(await a.redeemPin(pin.pin, dave.sessionToken));
	});

	it("limits the accounts on the server (409 too_many_users)", async () => {
		// dave, ann, m2, m3: one more fits.
		const daveTeam = (await a.teams(dave.sessionToken)).find((t) => t.name === "D1");
		const inv = await a.invite(
			`/api/teams/${daveTeam?.id}/invites`,
			"viewer",
			dave.sessionToken,
			5,
		);
		await acceptInvite(relay.url, inv.token, "u5");
		expectLimit(
			await request(relay.url, "POST", "/api/auth/invite/accept", {
				body: { token: inv.token, name: "u6", device: device("u6") },
			}),
			"too_many_users",
		);
	});
});

describe("pre-team migration", () => {
	let relay: Relay;
	let dir: string;
	let port: number;
	const a = api(() => relay);
	let dave: SessionResponse;
	let erin: SessionResponse;
	let friends: WorkspaceSummary;
	let work: WorkspaceSummary;
	let pendingInvite: InviteCreated;
	let pendingPin: PinSummary;

	beforeAll(async () => {
		dir = mkdtempSync(join(tmpdir(), "relay-team-migration-"));
		port = pickPort(25_600);
		relay = await startRelayDev({ port, persistTo: dir });
		const boot = await bootstrap(relay.url, "Friends");
		friends = boot.workspace;
		dave = await acceptInvite(relay.url, boot.invite.token, "dave");
		const inv = await a.invite(
			`/api/workspaces/${friends.id}/invites`,
			"editor",
			dave.sessionToken,
		);
		erin = await acceptInvite(relay.url, inv.token, "erin");
		work = WorkspaceSummary.parse(
			await post(relay.url, "/api/workspaces", { name: "Work" }, dave.sessionToken),
		);
		const toWork = await a.invite(
			`/api/workspaces/${work.id}/invites`,
			"viewer",
			dave.sessionToken,
		);
		await post(relay.url, "/api/invites/redeem", { token: toWork.token }, erin.sessionToken);
		pendingInvite = await a.invite(
			`/api/workspaces/${friends.id}/invites`,
			"viewer",
			dave.sessionToken,
		);
		pendingPin = await a.pin(`/api/workspaces/${friends.id}/pins`, "editor", dave.sessionToken);
	});

	afterAll(async () => {
		await relay?.stop();
		rmSync(dir, { recursive: true, force: true });
	});

	it("gives each existing workspace its own team with the same members and keeps invites", async () => {
		const before = {
			dave: (await a.folders(dave.sessionToken)).sort(byId),
			erin: (await a.folders(erin.sessionToken)).sort(byId),
			members: MembersResponse.parse(
				await get(relay.url, `/api/workspaces/${friends.id}/members`, dave.sessionToken),
			).members,
		};
		expect(before.erin.map((w) => [w.name, w.role]).sort()).toEqual([
			["Friends", "editor"],
			["Work", "viewer"],
		]);

		// Back to the schema before teams: no team tables, no team_id columns.
		await relay.stop();
		const doDir = readdirSync(join(dir, "v3", "do")).find((d) => d.endsWith("AccountsDO"));
		if (!doDir) throw new Error("no AccountsDO state");
		const file = readdirSync(join(dir, "v3", "do", doDir)).find((f) => f.endsWith(".sqlite"));
		if (!file) throw new Error("no AccountsDO sqlite file");
		const db = new DatabaseSync(join(dir, "v3", "do", doDir, file));
		db.exec("DROP INDEX IF EXISTS workspaces_team");
		for (const table of ["workspaces", "invites", "invite_pins"]) {
			db.exec(`ALTER TABLE ${table} DROP COLUMN team_id`);
		}
		db.exec("DROP TABLE teams");
		db.exec("DROP TABLE team_members");
		db.close();

		relay = await startRelayDev({ port, persistTo: dir });
		expect((await a.folders(dave.sessionToken)).sort(byId)).toEqual(before.dave);
		expect((await a.folders(erin.sessionToken)).sort(byId)).toEqual(before.erin);
		const after = MembersResponse.parse(
			await get(relay.url, `/api/workspaces/${friends.id}/members`, dave.sessionToken),
		).members;
		expect(after).toEqual(before.members);

		const teams = await a.teams(erin.sessionToken);
		expect(
			teams.map((t) => [t.name, t.role, t.memberCount, t.folders.map((f) => f.id)]).sort(),
		).toEqual([
			["Friends", "editor", 2, [friends.id]],
			["Work", "viewer", 2, [work.id]],
		]);
		const friendsTeam = teams.find((t) => t.name === "Friends");
		const teamMembers = TeamMembersResponse.parse(
			await get(relay.url, `/api/teams/${friendsTeam?.id}/members`, dave.sessionToken),
		).members;
		expect(teamMembers.map((m) => [m.user.name, m.role])).toEqual([
			["dave", "owner"],
			["erin", "editor"],
		]);

		// Invites and PINs issued before the migration still work and join the team.
		const fay = await acceptInvite(relay.url, pendingInvite.token, "fay");
		expect(fay.workspaces).toEqual([{ ...friends, role: "viewer" }]);
		const gil = await a.acceptPin(pendingPin.pin, "gil");
		expect(gil.status).toBe(200);
		expect(SessionResponse.parse(gil.body).workspaces).toEqual([{ ...friends, role: "editor" }]);
		expect(
			TeamMembersResponse.parse(
				await get(relay.url, `/api/teams/${friendsTeam?.id}/members`, dave.sessionToken),
			).members.map((m) => m.user.name),
		).toEqual(["dave", "erin", "fay", "gil"]);
	});
});
