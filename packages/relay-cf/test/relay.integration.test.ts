/**
 * G3: real `@hocuspocus/provider` clients against the relay under `wrangler dev` (local workerd,
 * which hibernates an idle Durable Object after ~10 s even with sockets open).
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { docName } from "@arcasync/shared";
import { SignJWT } from "jose";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startRelayDev } from "../scripts/dev-server.mjs";
import { client, login, sleep, stats, waitFor } from "./helpers";

const SECRET = "relay-integration-secret";
const PORT = 20_000 + Math.floor(Math.random() * 10_000);
/** Longer than the ~10 s local idle eviction, shorter than any provider timeout we use. */
const HIBERNATE_MS = 14_000;

type Relay = { url: string; stop: () => Promise<void> };
let relay: Relay;
let dir: string;
const cleanup: Array<() => void> = [];

async function restart(): Promise<void> {
	await relay.stop();
	relay = await startRelayDev({ port: PORT, persistTo: dir, vars: { ARCASYNC_SECRET: SECRET } });
}

beforeAll(async () => {
	dir = mkdtempSync(join(tmpdir(), "relay-it-"));
	relay = await startRelayDev({ port: PORT, persistTo: dir, vars: { ARCASYNC_SECRET: SECRET } });
});

afterAll(async () => {
	for (const fn of cleanup) fn();
	await relay?.stop();
	rmSync(dir, { recursive: true, force: true });
});

describe("WorkspaceRelay", () => {
	it("syncs two docs over one socket per client", async () => {
		const alice = await login(relay.url, "alice");
		const bob = await login(relay.url, "bob");
		const ws = alice.workspaceId;
		expect(bob.workspaceId).toBe(ws);
		const index = docName({ workspaceId: ws, kind: "index" });
		const note = docName({ workspaceId: ws, kind: "md", fileId: "note1" });

		const a = client(relay.url, ws);
		const b = client(relay.url, ws);
		cleanup.push(a.destroy, b.destroy);
		const [aIndex, aNote] = [await a.open(index, alice.token), await a.open(note, alice.token)];
		const [bIndex, bNote] = [await b.open(index, bob.token), await b.open(note, bob.token)];

		aIndex.document.getMap("debug").set("counter", 1);
		aNote.document.getText("body").insert(0, "hello from alice");
		bNote.document.getText("body").insert(0, ">> ");
		await waitFor(() => bIndex.document.getMap("debug").get("counter") === 1, { label: "index" });
		await waitFor(
			() => aNote.document.getText("body").toString() === bNote.document.getText("body").toString(),
			{ label: "note converges" },
		);
		expect(aNote.document.getText("body").toString()).toContain("hello from alice");
		await waitFor(() => !aNote.provider.hasUnsyncedChanges && !bNote.provider.hasUnsyncedChanges, {
			label: "SyncStatus acks drain unsyncedChanges",
		});
		const s = await stats(relay.url, ws);
		expect(s.sockets).toBe(2);
		a.destroy();
		b.destroy();
	});

	it("gives a late joiner the presence of an existing client (cached path)", async () => {
		const alice = await login(relay.url, "alice");
		const carol = await login(relay.url, "carol");
		const doc = docName({ workspaceId: alice.workspaceId, kind: "md", fileId: "presence1" });
		const a = client(relay.url, alice.workspaceId, { awareness: true });
		cleanup.push(a.destroy);
		const aDoc = await a.open(doc, alice.token);
		aDoc.awareness?.setLocalStateField("user", { name: "alice" });
		await sleep(300);

		const c = client(relay.url, carol.workspaceId, { awareness: true });
		cleanup.push(c.destroy);
		const cDoc = await c.open(doc, carol.token);
		await waitFor(
			() => cDoc.awareness?.getStates().get(aDoc.document.clientID)?.user?.name === "alice",
			{ label: "carol sees alice" },
		);

		// Leaving removes the presence right away (not after the 30 s awareness timeout).
		a.destroy();
		await waitFor(() => !cDoc.awareness?.getStates().has(aDoc.document.clientID), {
			label: "alice's presence removed",
		});
		c.destroy();
	});

	it("keeps syncing after the object hibernated with sockets open", async () => {
		const alice = await login(relay.url, "alice");
		const bob = await login(relay.url, "bob");
		const dave = await login(relay.url, "dave");
		const ws = alice.workspaceId;
		const doc = docName({ workspaceId: ws, kind: "md", fileId: "hibernate1" });
		// No renewals and a long receive timeout, so nothing wakes the object while idle.
		const quiet = { awareness: true, renewAwareness: false, messageReconnectTimeout: 600_000 };
		const a = client(relay.url, ws, quiet);
		const b = client(relay.url, ws, quiet);
		cleanup.push(a.destroy, b.destroy);
		const aDoc = await a.open(doc, alice.token);
		const bDoc = await b.open(doc, bob.token);
		aDoc.awareness?.setLocalStateField("user", { name: "alice" });
		aDoc.document.getText("body").insert(0, "before ");
		await waitFor(() => bDoc.document.getText("body").toString() === "before ", { label: "pre" });

		const before = await stats(relay.url, ws);
		await sleep(HIBERNATE_MS);
		const woke = await stats(relay.url, ws);
		// The stats request itself woke a fresh instance: the object had been evicted from memory.
		expect(woke.wakes).toBeGreaterThan(before.wakes);
		expect(woke.sockets).toBe(2);
		expect(woke.connects).toBe(before.connects);

		// Late joiner right after a wake: the awareness cache is empty, so presence must come
		// from the relay's QueryAwareness to alice's provider.
		const d = client(relay.url, ws, { awareness: true });
		cleanup.push(d.destroy);
		const dDoc = await d.open(doc, dave.token);
		await waitFor(
			() => dDoc.awareness?.getStates().get(aDoc.document.clientID)?.user?.name === "alice",
			{ label: "dave sees alice after hibernation" },
		);
		d.destroy();

		await sleep(HIBERNATE_MS);
		// An edit sent to the hibernated object, on the same sockets (no reconnect), is what wakes
		// it, and it still syncs. Stats are read only afterwards so no HTTP request wakes it first.
		aDoc.document.getText("body").insert(7, "after");
		await waitFor(() => bDoc.document.getText("body").toString() === "before after", {
			label: "edit after hibernation reaches bob",
		});
		await waitFor(() => !aDoc.provider.hasUnsyncedChanges, { label: "ack after hibernation" });
		const after = await stats(relay.url, ws);
		expect(after.wakes).toBeGreaterThan(woke.wakes);
		expect(after.connects).toBe(before.connects + 1);
		expect(a.opens).toBe(1);
		expect(b.opens).toBe(1);
		a.destroy();
		b.destroy();
	});

	it("survives a dev-server restart and uploads edits made while it was down", async () => {
		const alice = await login(relay.url, "alice");
		const bob = await login(relay.url, "bob");
		const ws = alice.workspaceId;
		const doc = docName({ workspaceId: ws, kind: "md", fileId: "restart1" });
		const a = client(relay.url, ws);
		const b = client(relay.url, ws);
		cleanup.push(a.destroy, b.destroy);
		const aDoc = await a.open(doc, alice.token);
		const bDoc = await b.open(doc, bob.token);
		aDoc.document.getText("body").insert(0, "one ");
		await waitFor(() => bDoc.document.getText("body").toString() === "one ", { label: "one" });

		await relay.stop();
		aDoc.document.getText("body").insert(4, "offline ");
		await restart();
		await waitFor(() => bDoc.document.getText("body").toString() === "one offline ", {
			timeout: 30_000,
			label: "offline edit reaches bob after restart",
		});
		a.destroy();
		b.destroy();

		const fresh = client(relay.url, ws);
		cleanup.push(fresh.destroy);
		const fDoc = await fresh.open(doc, (await login(relay.url, "erin")).token);
		expect(fDoc.document.getText("body").toString()).toBe("one offline ");
		fresh.destroy();
	});

	it("enforces read-only viewers and workspace binding", async () => {
		const alice = await login(relay.url, "alice");
		const ws = alice.workspaceId;
		const doc = docName({ workspaceId: ws, kind: "md", fileId: "viewer1" });
		const mint = (claims: { ws: string; role: string }) => async () =>
			new SignJWT({ ws: claims.ws, role: claims.role, dev: "dev-x" })
				.setProtectedHeader({ alg: "HS256" })
				.setSubject("viewer-user")
				.setIssuer("arcasync")
				.setAudience("arcasync-ws")
				.setIssuedAt()
				.setExpirationTime("10m")
				.sign(new TextEncoder().encode(SECRET));

		const a = client(relay.url, ws);
		const v = client(relay.url, ws);
		cleanup.push(a.destroy, v.destroy);
		const aDoc = await a.open(doc, alice.token);
		aDoc.document.getText("body").insert(0, "owner text");
		const vDoc = await v.open(doc, mint({ ws, role: "viewer" }));
		await waitFor(() => vDoc.document.getText("body").toString() === "owner text", {
			label: "viewer reads",
		});
		expect(vDoc.provider.authorizedScope).toBe("readonly");
		vDoc.document.getText("body").insert(0, "VIEWER ");
		await sleep(500);
		expect(aDoc.document.getText("body").toString()).toBe("owner text");
		expect(vDoc.provider.hasUnsyncedChanges).toBe(true);

		const other = client(relay.url, ws);
		cleanup.push(other.destroy);
		await expect(
			other.open(doc, mint({ ws: "some-other-workspace", role: "owner" })),
		).rejects.toThrow(/auth failed: permission-denied/);
		a.destroy();
		v.destroy();
		other.destroy();
	});
});
