import { describe, expect, it } from "vitest";
import {
	canUnlink,
	createProfileFlow,
	createTeamsFlow,
	memberRows,
	NAME_TAKEN_COPY,
	TEAM_NAME_COPY,
	teamRows,
} from "../flows/dashboard";
import { profile } from "../flows/store";
import { fail, fakeApi, flush, ok } from "./fakes";

const TEAM = {
	id: "t1",
	slug: "studio",
	name: "Studio",
	role: "owner",
	memberCount: 2,
	folders: [{ id: "w1", slug: "notes", name: "Notes" }],
};
const MEMBERS = [
	{
		user: {
			id: "u1",
			name: "mara",
			email: "mara@example.com",
			color: "#2fae8f",
			avatarUrl: "https://avatars.githubusercontent.com/u/1",
		},
		role: "owner",
	},
	{
		user: { id: "u2", name: "kai", email: null, color: "#ff0000", avatarUrl: "http://x/y.png" },
		role: "editor",
	},
];
const PINS = ok({ pins: [], locked: false, lockedUntil: null });

function teams(routes: Parameters<typeof fakeApi>[0]) {
	const fake = fakeApi(routes);
	const flow = createTeamsFlow({ api: fake.api, meId: "u1", origin: "https://site.example" });
	return { ...fake, flow };
}

describe("parsers", () => {
	it("read teams and members defensively; avatars must be https", () => {
		expect(teamRows([TEAM, { id: 1 }, null])).toEqual([
			{
				id: "t1",
				name: "Studio",
				role: "owner",
				memberCount: 2,
				folders: [{ id: "w1", name: "Notes" }],
			},
		]);
		expect(memberRows(MEMBERS)).toEqual([
			{
				id: "u1",
				name: "mara",
				email: "mara@example.com",
				color: "#2fae8f",
				avatarUrl: "https://avatars.githubusercontent.com/u/1",
				role: "owner",
			},
			{ id: "u2", name: "kai", email: null, color: "#ff0000", avatarUrl: null, role: "editor" },
		]);
		expect(profile({ id: "u1", email: "", avatarUrl: 'https://x/"onerror' })).toEqual({
			id: "u1",
			email: null,
			avatarUrl: null,
		});
	});
});

describe("teams flow", () => {
	it("lists teams, and opening an owned team loads members and PINs", async () => {
		const { flow, calls } = teams({
			"GET /api/teams": [ok({ teams: [TEAM] })],
			"GET /api/teams/t1/members": [ok({ members: MEMBERS })],
			"GET /api/teams/t1/pins": [PINS],
		});
		expect(flow.getState()).toEqual({ kind: "loading" });
		await flush();
		expect(flow.getState()).toMatchObject({ kind: "ready", teams: [{ id: "t1" }], open: null });
		flow.send({ type: "open", teamId: "t1" });
		await flush();
		expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual([
			"GET /api/teams",
			"GET /api/teams/t1/members",
			"GET /api/teams/t1/pins",
		]);
		expect(flow.getState()).toMatchObject({
			open: { teamId: "t1", loading: false, members: [{ id: "u1" }, { id: "u2" }], pins: [] },
		});
	});

	it("doesn't load PINs for a team you only edit", async () => {
		const { flow, calls } = teams({
			"GET /api/teams": [ok({ teams: [{ ...TEAM, role: "editor" }] })],
			"GET /api/teams/t1/members": [ok({ members: MEMBERS })],
		});
		await flush();
		flow.send({ type: "open", teamId: "t1" });
		await flush();
		expect(calls).toHaveLength(2);
		expect(flow.getState()).toMatchObject({ open: { pins: null } });
	});

	it("creates a team, then opens it", async () => {
		const { flow, calls } = teams({
			"GET /api/teams": [ok({ teams: [] }), ok({ teams: [TEAM] })],
			"POST /api/teams": [ok(TEAM)],
			"GET /api/teams/t1/members": [ok({ members: MEMBERS.slice(0, 1) })],
			"GET /api/teams/t1/pins": [PINS],
		});
		await flush();
		flow.send({ type: "create", name: "   " });
		expect(flow.getState()).toMatchObject({ nameError: TEAM_NAME_COPY });
		flow.send({ type: "create", name: " Studio " });
		await flush();
		await flush();
		expect(calls[1]).toMatchObject({ options: { body: { name: "Studio" }, auth: true } });
		expect(flow.getState()).toMatchObject({
			creating: false,
			notice: "Created Studio.",
			open: { teamId: "t1" },
		});
	});

	it("shows the server's message at a cap", async () => {
		const { flow } = teams({
			"GET /api/teams": [ok({ teams: [] })],
			"POST /api/teams": [fail(409, "limit_reached", "You can own at most 3 teams.")],
		});
		await flush();
		flow.send({ type: "create", name: "Fourth" });
		await flush();
		expect(flow.getState()).toMatchObject({
			creating: false,
			createError: { code: "limit_reached", message: "You can own at most 3 teams." },
		});
	});

	it("changes roles and removes members, never yourself", async () => {
		const { flow, calls } = teams({
			"GET /api/teams": [ok({ teams: [TEAM] }), ok({ teams: [{ ...TEAM, memberCount: 1 }] })],
			"GET /api/teams/t1/members": [
				ok({ members: MEMBERS }),
				ok({ members: MEMBERS }),
				ok({ members: MEMBERS.slice(0, 1) }),
			],
			"GET /api/teams/t1/pins": [PINS],
			"PATCH /api/teams/t1/members/u2": [ok({ ok: true })],
			"DELETE /api/teams/t1/members/u2": [ok({ ok: true })],
		});
		await flush();
		flow.send({ type: "open", teamId: "t1" });
		await flush();
		flow.send({ type: "role", userId: "u1", role: "viewer" });
		flow.send({ type: "remove", userId: "u1" });
		flow.send({ type: "role", userId: "u2", role: "admin" });
		expect(calls).toHaveLength(3);
		flow.send({ type: "role", userId: "u2", role: "viewer" });
		await flush();
		expect(calls[3]).toMatchObject({ method: "PATCH", options: { body: { role: "viewer" } } });
		flow.send({ type: "remove", userId: "u2" });
		await flush();
		await flush();
		expect(flow.getState()).toMatchObject({
			teams: [{ memberCount: 1 }],
			open: { busy: false, members: [{ id: "u1" }] },
		});
	});

	it("makes an invite link (falling back to a join link) and PINs", async () => {
		const { flow } = teams({
			"GET /api/teams": [ok({ teams: [TEAM] })],
			"GET /api/teams/t1/members": [ok({ members: MEMBERS })],
			"GET /api/teams/t1/pins": [PINS, ok({ pins: [{ id: "p1", pin: "123456", role: "viewer" }] })],
			"POST /api/teams/t1/invites": [ok({ token: "tok_123", expiresAt: 5 })],
			"POST /api/teams/t1/pins": [ok({ id: "p1" })],
		});
		await flush();
		flow.send({ type: "open", teamId: "t1" });
		await flush();
		flow.send({ type: "invite", role: "editor" });
		await flush();
		expect(flow.getState()).toMatchObject({
			open: {
				invite: { url: "https://site.example/join?invite=tok_123", role: "editor", expiresAt: 5 },
			},
		});
		flow.send({ type: "pin-create", role: "viewer" });
		await flush();
		expect(flow.getState()).toMatchObject({ open: { pins: [{ pin: "123456" }] } });
	});

	it("says a 403 is for owners only, not a disabled account", async () => {
		const { flow } = teams({
			"GET /api/teams": [ok({ teams: [TEAM] })],
			"GET /api/teams/t1/members": [ok({ members: MEMBERS })],
			"GET /api/teams/t1/pins": [PINS],
			"POST /api/teams/t1/invites": [fail(403, "forbidden")],
		});
		await flush();
		flow.send({ type: "open", teamId: "t1" });
		await flush();
		flow.send({ type: "invite", role: "editor" });
		await flush();
		expect(flow.getState()).toMatchObject({
			open: { busy: false, error: { code: "team_forbidden" } },
		});
	});

	it("leaves (removing yourself) and deletes, then reloads the list", async () => {
		const { flow, calls } = teams({
			"GET /api/teams": [
				ok({ teams: [TEAM, { ...TEAM, id: "t2", name: "Other", role: "editor" }] }),
				ok({ teams: [TEAM] }),
				ok({ teams: [] }),
			],
			"GET /api/teams/t2/members": [ok({ members: MEMBERS })],
			"GET /api/teams/t1/members": [ok({ members: MEMBERS })],
			"GET /api/teams/t1/pins": [PINS],
			"DELETE /api/teams/t2/members/u1": [ok({ ok: true })],
			"DELETE /api/teams/t1": [ok({ ok: true })],
		});
		await flush();
		flow.send({ type: "open", teamId: "t2" });
		await flush();
		flow.send({ type: "leave" });
		await flush();
		expect(flow.getState()).toMatchObject({
			open: null,
			notice: "You left Other.",
			teams: [{ id: "t1" }],
		});
		flow.send({ type: "open", teamId: "t1" });
		await flush();
		flow.send({ type: "delete" });
		await flush();
		expect(calls.at(-2)).toMatchObject({ method: "DELETE", path: "/api/teams/t1" });
		expect(flow.getState()).toMatchObject({ open: null, notice: "Deleted Studio.", teams: [] });
	});

	it("is signed out on a 401 and retryable on other failures", async () => {
		const gone = teams({ "GET /api/teams": [fail(401, "unauthorized")] });
		const down = teams({ "GET /api/teams": [fail(0, "network"), ok({ teams: [] })] });
		await flush();
		expect(gone.flow.getState()).toEqual({ kind: "signed-out" });
		expect(down.flow.getState()).toMatchObject({ kind: "error", error: { code: "network" } });
		down.flow.send({ type: "retry" });
		await flush();
		expect(down.flow.getState()).toMatchObject({ kind: "ready", teams: [] });
	});
});

describe("profile flow", () => {
	const IDS = ok({
		identities: [{ provider: "google", email: "mara@example.com", linkedAt: 1 }, { provider: "x" }],
		hasPassword: false,
	});

	it("loads linked providers; the only sign-in method can't be unlinked", async () => {
		const { api, calls } = fakeApi({ "GET /api/auth/identities": [IDS] });
		const flow = createProfileFlow({ api, hasPassword: false });
		await flush();
		const state = flow.getState();
		expect(state.identities).toEqual([
			{ provider: "google", email: "mara@example.com", linkedAt: 1 },
		]);
		expect(canUnlink(state, "google")).toBe(false);
		flow.send({ type: "unlink", provider: "google" });
		await flush();
		expect(calls).toHaveLength(1);
		expect(canUnlink({ ...state, hasPassword: true }, "google")).toBe(true);
	});

	it("unlinks when another method is left", async () => {
		const { api, calls } = fakeApi({
			"GET /api/auth/identities": [
				ok({
					identities: [
						{ provider: "google", email: null, linkedAt: 1 },
						{ provider: "github", email: null, linkedAt: 2 },
					],
					hasPassword: false,
				}),
				IDS,
			],
			"DELETE /api/auth/identities/github": [ok({ ok: true })],
		});
		const flow = createProfileFlow({ api, hasPassword: false });
		await flush();
		flow.send({ type: "unlink", provider: "github" });
		await flush();
		expect(calls[1]).toMatchObject({ method: "DELETE", options: { auth: true } });
		expect(flow.getState()).toMatchObject({
			unlinking: null,
			notice: "Unlinked.",
			identities: [{ provider: "google" }],
		});
	});

	it("renames, and says when the name is taken", async () => {
		const renamed: string[] = [];
		const { api, calls } = fakeApi({
			"GET /api/auth/identities": [IDS],
			"PATCH /api/auth/profile": [fail(409, "name_taken"), ok({ user: { name: "Mara K" } })],
		});
		const flow = createProfileFlow({ api, hasPassword: false, onRenamed: (n) => renamed.push(n) });
		await flush();
		flow.send({ type: "rename", name: "mara", current: "mara" });
		expect(calls).toHaveLength(1);
		flow.send({ type: "rename", name: "kai", current: "mara" });
		await flush();
		expect(flow.getState()).toMatchObject({ renaming: false, nameError: NAME_TAKEN_COPY });
		flow.send({ type: "rename", name: " Mara K ", current: "mara" });
		await flush();
		expect(calls.at(-1)).toMatchObject({ method: "PATCH", options: { body: { name: "Mara K" } } });
		expect(flow.getState()).toMatchObject({ renamed: "Mara K", nameError: null });
		expect(renamed).toEqual(["Mara K"]);
	});
});
