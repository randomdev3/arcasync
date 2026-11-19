/**
 * P1-8: every stored row and Yjs client is attributed to the authenticated user, a socket cannot
 * publish awareness under another user's id, and viewers write nothing.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { docName, SessionResponse, WsTokenResponse } from "@arcasync/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startRelayDev } from "../scripts/dev-server.mjs";
import { client, login, post, sleep, stats, waitFor } from "./helpers";

/** This lane's port range is 24000-24999 (the inspector takes port + 10000). */
const PORT = 24_100 + Math.floor(Math.random() * 100);

type Relay = { url: string; stop: () => Promise<void> };
let relay: Relay;
let dir: string;
const cleanup: Array<() => void> = [];

interface DocDebug {
	rowsByUser: Record<string, number>;
	clients: { clientId: number; userId: string }[];
	tailRows: number;
	stateBytes: number;
}

async function debugDoc(ws: string, doc: string): Promise<DocDebug> {
	const res = await fetch(
		`${relay.url}/api/debug/doc?ws=${encodeURIComponent(ws)}&doc=${encodeURIComponent(doc)}`,
	);
	if (!res.ok) throw new Error(`debug doc -> ${res.status} ${await res.text()}`);
	return (await res.json()) as DocDebug;
}

/** Dev-login with a role for a new membership (R-1), like `login()` otherwise. */
async function loginAs(name: string, role: "viewer") {
	const session = SessionResponse.parse(
		await post(relay.url, "/api/auth/dev-login", {
			name,
			device: { name: `${name}-device`, platform: "macos", vaultId: `${name}-vault` },
			role,
		}),
	);
	const workspace = session.workspaces[0];
	if (!workspace) throw new Error("no workspace");
	expect(workspace.role).toBe(role);
	const token = async () =>
		WsTokenResponse.parse(
			await post(
				relay.url,
				"/api/auth/ws-token",
				{ workspaceId: workspace.id },
				session.sessionToken,
			),
		).token;
	return { session, workspaceId: workspace.id, token };
}

beforeAll(async () => {
	dir = mkdtempSync(join(tmpdir(), "relay-attribution-"));
	relay = await startRelayDev({ port: PORT, persistTo: dir });
});

afterAll(async () => {
	for (const fn of cleanup) fn();
	await relay?.stop();
	rmSync(dir, { recursive: true, force: true });
});

describe("attribution", () => {
	it("records both authors' rows and maps each Yjs client to its user", async () => {
		const alice = await login(relay.url, "alice");
		const bob = await login(relay.url, "bob");
		const ws = alice.workspaceId;
		const doc = docName({ workspaceId: ws, kind: "md", fileId: "attrib1" });
		const a = client(relay.url, ws);
		const b = client(relay.url, ws);
		cleanup.push(a.destroy, b.destroy);
		const aDoc = await a.open(doc, alice.token);
		const bDoc = await b.open(doc, bob.token);

		aDoc.document.getText("body").insert(0, "alice wrote this. ");
		await waitFor(() => !aDoc.provider.hasUnsyncedChanges, { label: "alice acked" });
		bDoc.document.getText("body").insert(0, "bob too. ");
		bDoc.document.getText("body").insert(0, ">> ");
		await waitFor(() => !bDoc.provider.hasUnsyncedChanges, { label: "bob acked" });
		await waitFor(
			() => aDoc.document.getText("body").toString() === bDoc.document.getText("body").toString(),
			{ label: "converged" },
		);

		const debug = await debugDoc(ws, doc);
		const aliceId = alice.session.user.id;
		const bobId = bob.session.user.id;
		expect(Object.keys(debug.rowsByUser).sort()).toEqual([aliceId, bobId].sort());
		expect(debug.rowsByUser[aliceId]).toBeGreaterThan(0);
		expect(debug.rowsByUser[bobId]).toBeGreaterThan(0);
		expect(debug.tailRows).toBe((debug.rowsByUser[aliceId] ?? 0) + (debug.rowsByUser[bobId] ?? 0));
		expect(new Map(debug.clients.map((c) => [c.clientId, c.userId]))).toEqual(
			new Map([
				[aDoc.document.clientID, aliceId],
				[bDoc.document.clientID, bobId],
			]),
		);
		expect(debug.stateBytes).toBeGreaterThan(0);
		a.destroy();
		b.destroy();
	});

	it("rejects a debug doc of another workspace", async () => {
		const res = await fetch(
			`${relay.url}/api/debug/doc?ws=dev&doc=${encodeURIComponent("ws:other:md:x")}`,
		);
		expect(res.status).toBe(400);
	});

	it("closes a socket that publishes awareness under another user's id with 4403", async () => {
		const alice = await login(relay.url, "alice");
		const bob = await login(relay.url, "bob");
		const ws = alice.workspaceId;
		const doc = docName({ workspaceId: ws, kind: "md", fileId: "spoof1" });
		const a = client(relay.url, ws, { awareness: true });
		const b = client(relay.url, ws, { awareness: true });
		cleanup.push(a.destroy, b.destroy);
		const aDoc = await a.open(doc, alice.token);
		const bDoc = await b.open(doc, bob.token);
		const aliceId = alice.session.user.id;
		aDoc.awareness?.setLocalStateField("user", { id: aliceId, name: "alice" });

		// Bob's own identity is accepted and relayed.
		bDoc.awareness?.setLocalStateField("user", { id: bob.session.user.id, name: "bob" });
		await waitFor(
			() => aDoc.awareness?.getStates().get(bDoc.document.clientID)?.user?.name === "bob",
			{ label: "alice sees bob" },
		);

		// Every state alice ever holds for bob's client, so a relayed forgery cannot hide.
		const seen: unknown[] = [];
		aDoc.awareness?.on("change", () => {
			seen.push(aDoc.awareness?.getStates().get(bDoc.document.clientID)?.user);
		});
		const raw = b.rawSockets[b.rawSockets.length - 1];
		if (!raw) throw new Error("no raw socket");
		const closed = new Promise<{ code: number; reason: string }>((resolve) =>
			raw.once("close", (code, reason) => resolve({ code, reason: reason.toString() })),
		);
		bDoc.awareness?.setLocalStateField("user", { id: aliceId, name: "not alice" });
		const close = await closed;
		b.destroy();
		expect(close).toEqual({ code: 4403, reason: "awareness-identity" });

		// The forged state never reached alice, and bob's presence is gone.
		await waitFor(() => !aDoc.awareness?.getStates().has(bDoc.document.clientID), {
			label: "bob's presence removed",
		});
		await sleep(300);
		expect(seen.length).toBeGreaterThan(0);
		expect(seen).not.toContainEqual({ id: aliceId, name: "not alice" });
		for (const user of seen) {
			if (user !== undefined) expect(user).toEqual({ id: bob.session.user.id, name: "bob" });
		}
		a.destroy();
	});

	it("binds a socket to its first user: another user's token is denied on it", async () => {
		const alice = await login(relay.url, "alice");
		const bob = await login(relay.url, "bob");
		const ws = alice.workspaceId;
		const mine = docName({ workspaceId: ws, kind: "md", fileId: "bound1" });
		const theirs = docName({ workspaceId: ws, kind: "md", fileId: "bound2" });
		const a = client(relay.url, ws);
		const peer = client(relay.url, ws);
		cleanup.push(a.destroy, peer.destroy);
		const aDoc = await a.open(mine, alice.token);
		await expect(a.open(theirs, bob.token)).rejects.toThrow(/auth failed: permission-denied/);

		// The socket's own doc keeps syncing.
		const pDoc = await peer.open(mine, bob.token);
		aDoc.document.getText("body").insert(0, "still alice");
		await waitFor(() => pDoc.document.getText("body").toString() === "still alice", {
			label: "alice's doc still syncs",
		});
		await waitFor(() => !aDoc.provider.hasUnsyncedChanges, { label: "alice acked" });
		const debug = await debugDoc(ws, mine);
		expect(debug.rowsByUser).toEqual({ [alice.session.user.id]: 1 });
		a.destroy();
		peer.destroy();
	});

	it("relays a viewer's awareness and stores none of the viewer's updates", async () => {
		const alice = await login(relay.url, "alice");
		const carol = await loginAs("carol", "viewer");
		const ws = alice.workspaceId;
		const doc = docName({ workspaceId: ws, kind: "md", fileId: "viewer-rows1" });
		const a = client(relay.url, ws, { awareness: true });
		const v = client(relay.url, ws, { awareness: true });
		cleanup.push(a.destroy, v.destroy);
		const aDoc = await a.open(doc, alice.token);
		aDoc.document.getText("body").insert(0, "owner text");
		await waitFor(() => !aDoc.provider.hasUnsyncedChanges, { label: "alice acked" });
		const vDoc = await v.open(doc, carol.token);
		expect(vDoc.provider.authorizedScope).toBe("readonly");

		const carolId = carol.session.user.id;
		vDoc.awareness?.setLocalStateField("user", { id: carolId, name: "carol" });
		await waitFor(
			() => aDoc.awareness?.getStates().get(vDoc.document.clientID)?.user?.name === "carol",
			{ label: "alice sees the viewer" },
		);

		const before = await stats(relay.url, ws);
		vDoc.document.getText("body").insert(0, "VIEWER ");
		await sleep(1000);
		const after = await stats(relay.url, ws);
		expect(after.msgs_in).toBeGreaterThan(before.msgs_in);
		expect(after.app_rows_written - before.app_rows_written).toBe(0);
		expect(aDoc.document.getText("body").toString()).toBe("owner text");

		const debug = await debugDoc(ws, doc);
		expect(debug.rowsByUser[carolId]).toBeUndefined();
		expect(debug.clients.map((c) => c.userId)).not.toContain(carolId);
		a.destroy();
		v.destroy();
	});
});
