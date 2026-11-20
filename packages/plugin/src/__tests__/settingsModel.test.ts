import type { InviteSummary, PinSummary, TeamSummary } from "@arcasync/shared";
import { describe, expect, it } from "vitest";
import { ApiRequestError } from "../net/ApiClient";
import {
	browserSignInUrl,
	expiresIn,
	folderState,
	memberView,
	openInvites,
	openPins,
	sortMembers,
	teamErrorMessage,
	teamOfFolder,
	teamPermissions,
	teamViews,
} from "../ui/settings/model";

const summary: TeamSummary = {
	id: "t1",
	slug: "team",
	name: "Team",
	role: "editor",
	memberCount: 3,
	folders: [
		{ id: "ws1", slug: "notes", name: "Notes" },
		{ id: "ws2", slug: "specs", name: "Specs" },
	],
};

describe("teamViews", () => {
	it("shows the server's teams when it has them", () => {
		const [team] = teamViews(true, [summary], []);
		expect(team).toEqual({
			id: "t1",
			name: "Team",
			role: "editor",
			memberCount: 3,
			folders: [
				{ id: "ws1", name: "Notes" },
				{ id: "ws2", name: "Specs" },
			],
			legacy: false,
		});
	});

	it("shows each workspace as a team of one folder on an older server", () => {
		const teams = teamViews(false, [summary], [{ id: "ws9", slug: "w", name: "W", role: "owner" }]);
		expect(teams).toEqual([
			{
				id: "ws9",
				name: "W",
				role: "owner",
				memberCount: null,
				folders: [{ id: "ws9", name: "W" }],
				legacy: true,
			},
		]);
	});

	it("finds the team of a folder", () => {
		const teams = teamViews(true, [summary], []);
		expect(teamOfFolder(teams, "ws2")).toMatchObject({
			team: { id: "t1" },
			folder: { id: "ws2", name: "Specs" },
		});
		expect(teamOfFolder(teams, "nope")).toBeNull();
	});
});

describe("teamPermissions", () => {
	const [editorTeam] = teamViews(true, [summary], []);
	if (!editorTeam) throw new Error("no team");

	it("lets owners manage everything and editors share folders", () => {
		expect(teamPermissions({ ...editorTeam, role: "owner" }, false)).toEqual({
			rename: true,
			deleteTeam: true,
			manageMembers: true,
			invite: true,
			shareFolder: true,
			deleteFolder: true,
		});
		expect(teamPermissions(editorTeam, false)).toEqual({
			rename: false,
			deleteTeam: false,
			manageMembers: false,
			invite: false,
			shareFolder: true,
			deleteFolder: false,
		});
		expect(teamPermissions({ ...editorTeam, role: "viewer" }, false).shareFolder).toBe(false);
		expect(teamPermissions(editorTeam, true).manageMembers).toBe(true);
	});

	it("offers only members and invites for a legacy workspace", () => {
		const [legacy] = teamViews(false, [], [{ id: "w", slug: "w", name: "W", role: "owner" }]);
		if (!legacy) throw new Error("no team");
		expect(teamPermissions(legacy, false)).toEqual({
			rename: false,
			deleteTeam: false,
			manageMembers: true,
			invite: true,
			shareFolder: false,
			deleteFolder: false,
		});
	});
});

describe("folderState", () => {
	const base = { paused: false, member: true, connection: "connected", synced: true } as const;

	it("is connected only once the index synced", () => {
		expect(folderState(base)).toBe("connected");
		expect(folderState({ ...base, synced: false })).toBe("syncing");
		expect(folderState({ ...base, connection: "connecting" })).toBe("syncing");
	});

	it("reports paused, lost access, offline and errors", () => {
		expect(folderState({ ...base, paused: true, connection: "error" })).toBe("paused");
		expect(folderState({ ...base, member: false })).toBe("noaccess");
		expect(folderState({ ...base, connection: null })).toBe("offline");
		expect(folderState({ ...base, connection: "disconnected" })).toBe("offline");
		expect(folderState({ ...base, connection: "error" })).toBe("error");
	});
});

describe("browserSignInUrl", () => {
	it("signs in with the provider, then approves this device's code", () => {
		const url = browserSignInUrl("https://arca.example/", "github", "ABCD-EFGH");
		expect(url).toBe(
			"https://arca.example/signin?provider=github&next=%2Fapprove%3Fcode%3DABCD-EFGH",
		);
		const next = new URL(url ?? "").searchParams.get("next");
		expect(next).toBe("/approve?code=ABCD-EFGH");
	});

	it("keeps a path prefix and refuses non-web URLs", () => {
		expect(browserSignInUrl("https://x.dev/arca", "google", "C")).toBe(
			"https://x.dev/arca/signin?provider=google&next=%2Fapprove%3Fcode%3DC",
		);
		expect(browserSignInUrl("javascript:alert(1)", "google", "C")).toBeNull();
		expect(browserSignInUrl("not a url", "google", "C")).toBeNull();
	});
});

describe("members", () => {
	it("normalises team and legacy members and sorts by role", () => {
		const members = [
			memberView({ user: { id: "u2", name: "bob", color: "#00f" }, role: "viewer" }),
			memberView({
				user: { id: "u1", name: "zed", email: "z@x", color: "#f00", avatarUrl: "https://a/b" },
				role: "owner",
			}),
			memberView({ user: { id: "u3", name: "amy", color: "#0f0" }, role: "viewer" }),
		];
		expect(members[0]).toEqual({
			id: "u2",
			name: "bob",
			email: null,
			color: "#00f",
			avatarUrl: null,
			role: "viewer",
		});
		expect(sortMembers(members).map((m) => m.name)).toEqual(["zed", "amy", "bob"]);
	});
});

describe("invites", () => {
	const now = 1000;
	const invite = (patch: Partial<InviteSummary>): InviteSummary => ({
		id: "i",
		role: "editor",
		admin: false,
		uses: 0,
		maxUses: 1,
		expiresAt: 2000,
		createdBy: "u1",
		revoked: false,
		...patch,
	});
	const pin = (patch: Partial<PinSummary>): PinSummary => ({
		id: "p",
		pin: "123456",
		workspaceId: "ws1",
		role: "editor",
		admin: false,
		createdAt: 0,
		createdBy: "u1",
		expiresAt: 2000,
		usedAt: null,
		usedBy: null,
		revoked: false,
		...patch,
	});

	it("keeps only usable invites and PINs", () => {
		expect(
			openInvites(
				[
					invite({ id: "ok" }),
					invite({ revoked: true }),
					invite({ uses: 1 }),
					invite({ expiresAt: 1000 }),
				],
				now,
			).map((i) => i.id),
		).toEqual(["ok"]);
		expect(
			openPins(
				[pin({ id: "ok" }), pin({ usedAt: 5 }), pin({ revoked: true }), pin({ expiresAt: 9 })],
				now,
			).map((p) => p.id),
		).toEqual(["ok"]);
	});

	it("says when something expires", () => {
		expect(expiresIn(5 * 60_000, 0)).toBe("in 5 min");
		expect(expiresIn(5 * 3_600_000, 0)).toBe("in 5 h");
		expect(expiresIn(7 * 86_400_000, 0)).toBe("in 7 days");
	});
});

describe("teamErrorMessage", () => {
	it("explains the common refusals", () => {
		expect(teamErrorMessage(new ApiRequestError(409, "last_owner", "x"))).toBe(
			"A team needs at least one owner",
		);
		expect(teamErrorMessage(new ApiRequestError(409, "limit_reached", "Max 3 teams"))).toBe(
			"Max 3 teams",
		);
		expect(teamErrorMessage(new Error("boom"))).toBe("boom");
	});
});
