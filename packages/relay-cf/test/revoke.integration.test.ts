/**
 * P2-2: membership and role changes reach live sockets (D5). The relay closes the user's sockets
 * with 4401, refuses JWTs issued up to the revocation second, and a fresh token carries the new
 * role. Also member listing, last-owner protection, admin disable and the audit log.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	AuditResponse,
	CLOSE_MEMBERSHIP_CHANGED,
	docName,
	InviteCreated,
	MembersResponse,
	type SessionResponse,
	type WorkspaceSummary,
} from "@teamsync/shared";
import { decodeJwt } from "jose";
import * as decoding from "lib0/decoding";
import * as encoding from "lib0/encoding";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { startRelayDev } from "../scripts/dev-server.mjs";
import {
	acceptInvite,
	bootstrap,
	client,
	del,
	errorCode,
	get,
	patch,
	post,
	request,
	sleep,
	waitFor,
	wsTokenFor,
} from "./helpers";

const PORT = 25_000 + Math.floor(Math.random() * 400);

type Relay = { url: string; stop: () => Promise<void> };
let relay: Relay;
let dir: string;
const cleanup: Array<() => void> = [];

let team: WorkspaceSummary;
/** alice: bootstrap admin and the only owner of `team`. */
let alice: SessionResponse;
let bob: SessionResponse;
let carol: SessionResponse;
let dan: SessionResponse;

async function joinTeam(name: string): Promise<SessionResponse> {
	const invite = InviteCreated.parse(
		await post(
			relay.url,
			`/api/workspaces/${team.id}/invites`,
			{ role: "editor" },
			alice.sessionToken,
		),
	);
	return acceptInvite(relay.url, invite.token, name);
}

const tokenOf = (s: SessionResponse) => wsTokenFor(relay.url, s.sessionToken, team.id);
const memberPath = (s: SessionResponse) => `/api/workspaces/${team.id}/members/${s.user.id}`;

async function debugRows(doc: string): Promise<Record<string, number>> {
	const res = await fetch(
		`${relay.url}/api/debug/doc?ws=${encodeURIComponent(team.id)}&doc=${encodeURIComponent(doc)}`,
	);
	return ((await res.json()) as { rowsByUser: Record<string, number> }).rowsByUser;
}

/** Records close codes of a test client's raw sockets. */
function closeCodes(c: ReturnType<typeof client>): number[] {
	const codes: number[] = [];
	for (const raw of c.rawSockets) raw.on("close", (code: number) => codes.push(code));
	return codes;
}

/** One Auth frame on a fresh raw socket; resolves with the relay's answer. */
async function rawAuth(doc: string, token: string): Promise<"authenticated" | "permission-denied"> {
	const socket = new WebSocket(`${relay.url.replace(/^http/, "ws")}/ws?ws=${team.id}`);
	try {
		await new Promise<void>((resolve, reject) => {
			socket.once("open", () => resolve());
			socket.once("error", reject);
		});
		const answer = new Promise<"authenticated" | "permission-denied">((resolve, reject) => {
			socket.on("message", (data: Buffer) => {
				const decoder = decoding.createDecoder(new Uint8Array(data));
				if (decoding.readVarString(decoder) !== doc) return;
				if (decoding.readVarUint(decoder) !== 2) return;
				const type = decoding.readVarUint(decoder);
				if (type === 1) resolve("permission-denied");
				else if (type === 2) resolve("authenticated");
			});
			setTimeout(() => reject(new Error("no Auth answer")), 5000);
		});
		const encoder = encoding.createEncoder();
		encoding.writeVarString(encoder, doc);
		encoding.writeVarUint(encoder, 2); // Auth
		encoding.writeVarUint(encoder, 0); // Token
		encoding.writeVarString(encoder, token);
		socket.send(encoding.toUint8Array(encoder));
		return await answer;
	} finally {
		socket.terminate();
	}
}

beforeAll(async () => {
	dir = mkdtempSync(join(tmpdir(), "relay-revoke-"));
	relay = await startRelayDev({ port: PORT, persistTo: dir });
	const boot = await bootstrap(relay.url, "Team");
	team = boot.workspace;
	alice = await acceptInvite(relay.url, boot.invite.token, "alice");
	bob = await joinTeam("bob");
	carol = await joinTeam("carol");
	dan = await joinTeam("dan");
});

afterAll(async () => {
	for (const fn of cleanup) fn();
	await relay?.stop();
	rmSync(dir, { recursive: true, force: true });
});

describe("revocation", () => {
	const doc = () => docName({ workspaceId: team.id, kind: "md", fileId: "revoke1" });

	it("lists members to any member", async () => {
		const { members } = MembersResponse.parse(
			await get(relay.url, `/api/workspaces/${team.id}/members`, dan.sessionToken),
		);
		expect(members.map((m) => [m.user.name, m.role])).toEqual([
			["alice", "owner"],
			["bob", "editor"],
			["carol", "editor"],
			["dan", "editor"],
		]);
		expect(members[0]?.user).toEqual({
			id: alice.user.id,
			name: "alice",
			color: alice.user.color,
		});
	});

	it("demotion: 4401 close, stale JWT refused, fresh token is read-only", async () => {
		const a = client(relay.url, team.id);
		const b = client(relay.url, team.id);
		cleanup.push(a.destroy, b.destroy);
		const aDoc = await a.open(doc(), tokenOf(alice));
		await b.open(doc(), tokenOf(bob));
		const bCloses = closeCodes(b);
		aDoc.document.getText("body").insert(0, "owner text");
		await waitFor(() => !aDoc.provider.hasUnsyncedChanges, { label: "alice acked" });

		const stale = await tokenOf(bob)();
		await patch(relay.url, memberPath(bob), { role: "viewer" }, alice.sessionToken);
		await waitFor(() => bCloses.includes(CLOSE_MEMBERSHIP_CHANGED), {
			timeout: 2000,
			label: "bob's socket closed with 4401",
		});
		b.destroy();
		expect(await rawAuth(doc(), stale)).toBe("permission-denied");

		// A token minted in a later second carries the new role.
		await sleep(1100);
		const v = client(relay.url, team.id);
		cleanup.push(v.destroy);
		const vDoc = await v.open(doc(), tokenOf(bob));
		expect(vDoc.provider.authorizedScope).toBe("readonly");
		expect(vDoc.document.getText("body").toString()).toBe("owner text");
		vDoc.document.getText("body").insert(0, "VIEWER ");
		await sleep(1000);
		expect((await debugRows(doc()))[bob.user.id]).toBeUndefined();
		expect(aDoc.document.getText("body").toString()).toBe("owner text");
		a.destroy();
	});

	it("removal: 4401 close and ws-token answers 404", async () => {
		const v = client(relay.url, team.id);
		cleanup.push(v.destroy);
		await v.open(doc(), tokenOf(bob));
		const closes = closeCodes(v);
		expect(await del(relay.url, memberPath(bob), alice.sessionToken)).toEqual({ ok: true });
		await waitFor(() => closes.includes(CLOSE_MEMBERSHIP_CHANGED), {
			timeout: 2000,
			label: "bob's socket closed with 4401",
		});
		v.destroy();
		const res = await request(relay.url, "POST", "/api/auth/ws-token", {
			body: { workspaceId: team.id },
			token: bob.sessionToken,
		});
		expect(res.status).toBe(404);
		const members = await request(relay.url, "GET", `/api/workspaces/${team.id}/members`, {
			token: bob.sessionToken,
		});
		expect(members.status).toBe(403);
	});

	it("protects the last owner and limits changes to owners and admins", async () => {
		const demote = await request(relay.url, "PATCH", memberPath(alice), {
			body: { role: "viewer" },
			token: alice.sessionToken,
		});
		expect(demote.status).toBe(409);
		expect(errorCode(demote.body)).toBe("last_owner");
		const leave = await request(relay.url, "DELETE", memberPath(alice), {
			token: alice.sessionToken,
		});
		expect(leave.status).toBe(409);
		expect(errorCode(leave.body)).toBe("last_owner");

		const byEditor = await request(relay.url, "PATCH", memberPath(carol), {
			body: { role: "viewer" },
			token: dan.sessionToken,
		});
		expect(byEditor.status).toBe(403);
		const bad = await request(relay.url, "PATCH", memberPath(carol), {
			body: { role: "admin" },
			token: alice.sessionToken,
		});
		expect(bad.status).toBe(400);
	});

	it("disable: sessions revoked and sockets closed with 4401", async () => {
		const c = client(relay.url, team.id);
		cleanup.push(c.destroy);
		await c.open(doc(), tokenOf(carol));
		const closes = closeCodes(c);
		const byNonAdmin = await request(
			relay.url,
			"POST",
			`/api/admin/users/${carol.user.id}/disable`,
			{
				token: dan.sessionToken,
			},
		);
		expect(byNonAdmin.status).toBe(403);
		expect(
			await post(relay.url, `/api/admin/users/${carol.user.id}/disable`, {}, alice.sessionToken),
		).toEqual({ ok: true });
		await waitFor(() => closes.includes(CLOSE_MEMBERSHIP_CHANGED), {
			timeout: 2000,
			label: "carol's socket closed with 4401",
		});
		c.destroy();
		const me = await request(relay.url, "GET", "/api/auth/me", { token: carol.sessionToken });
		expect([401, 403]).toContain(me.status);
		expect(
			await post(relay.url, `/api/admin/users/${carol.user.id}/enable`, {}, alice.sessionToken),
		).toEqual({ ok: true });
		// Enabling does not resurrect revoked sessions.
		const after = await request(relay.url, "GET", "/api/auth/me", { token: carol.sessionToken });
		expect(after.status).toBe(401);
	});

	it("refuses a token minted in the revocation second, accepts one a second later", async () => {
		// Toggle dan's role until the change and the mint land in one second (a loaded machine
		// can push the mint into the next one).
		let sameSecond: string | null = null;
		for (let attempt = 0; attempt < 5 && !sameSecond; attempt++) {
			while (Date.now() % 1000 > 300) await sleep(10);
			const second = Math.floor(Date.now() / 1000);
			const role = attempt % 2 === 0 ? "viewer" : "editor";
			await patch(relay.url, memberPath(dan), { role }, alice.sessionToken);
			const token = await tokenOf(dan)();
			if (decodeJwt(token).iat === second) sameSecond = token;
			else await sleep(1100);
		}
		if (!sameSecond) throw new Error("could not mint within the revocation second");
		expect(await rawAuth(doc(), sameSecond)).toBe("permission-denied");
		await sleep(1100);
		expect(await rawAuth(doc(), await tokenOf(dan)())).toBe("authenticated");
	});

	it("records every change in the audit log, readable by admins only", async () => {
		const { entries, next } = AuditResponse.parse(
			await get(relay.url, "/api/admin/audit", alice.sessionToken),
		);
		expect(next).toBeNull();
		const byAlice = (action: string, target: string) =>
			entries.find((e) => e.action === action && e.target === target);
		expect(byAlice("member.role", bob.user.id)).toMatchObject({
			actorId: alice.user.id,
			details: { workspaceId: team.id, role: "viewer", previousRole: "editor" },
		});
		expect(byAlice("member.remove", bob.user.id)?.actorId).toBe(alice.user.id);
		expect(byAlice("user.disable", carol.user.id)?.actorId).toBe(alice.user.id);
		expect(byAlice("user.enable", carol.user.id)?.actorId).toBe(alice.user.id);
		expect(entries.find((e) => e.action === "bootstrap")).toMatchObject({
			actorId: null,
			target: team.id,
		});
		expect(entries.filter((e) => e.action === "invite.accept")).toHaveLength(4);
		// Newest first.
		const ids = entries.map((e) => e.id);
		expect(ids).toEqual([...ids].sort((x, y) => y - x));

		const page = AuditResponse.parse(
			await get(relay.url, "/api/admin/audit?limit=2", alice.sessionToken),
		);
		expect(page.entries.map((e) => e.id)).toEqual(ids.slice(0, 2));
		expect(page.next).toBe(ids[1]);
		const rest = AuditResponse.parse(
			await get(relay.url, `/api/admin/audit?before=${page.next}&limit=100`, alice.sessionToken),
		);
		expect(rest.entries.map((e) => e.id)).toEqual(ids.slice(2));

		const denied = await request(relay.url, "GET", "/api/admin/audit", {
			token: dan.sessionToken,
		});
		expect(denied.status).toBe(403);
		expect(
			(await request(relay.url, "GET", "/api/admin/audit?limit=101", { token: alice.sessionToken }))
				.status,
		).toBe(400);
	});
});
