/**
 * R-3: the free-tier traffic levers (keepalive auto-response, presence policy, flushDelay) against
 * `wrangler dev`, measured as `/api/debug/stats` deltas.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { docName } from "@teamsync/shared";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { startRelayDev } from "../scripts/dev-server.mjs";
import { type ClientOptions, client, login, resetStats, sleep, stats, waitFor } from "./helpers";

const SECRET = "relay-traffic-secret";
/** Lane r/plugin-traffic owns 22000–22999. */
const PORT = 22_000 + Math.floor(Math.random() * 400);
const IDLE_MS = 40_000;
const KEEPALIVE: ClientOptions = { keepaliveMs: 5000, messageReconnectTimeout: 12_000 };

let relay: { url: string; stop: () => Promise<void> };
let dir: string;
let session: { alice: Awaited<ReturnType<typeof login>>; bob: Awaited<ReturnType<typeof login>> };
let ws: string;
const clients: Array<ReturnType<typeof client>> = [];

function track(c: ReturnType<typeof client>) {
	clients.push(c);
	return c;
}

/** Let in-flight handshake frames land, then zero the counters. */
async function reset() {
	await sleep(500);
	await resetStats(relay.url, ws);
}

beforeAll(async () => {
	dir = mkdtempSync(join(tmpdir(), "relay-traffic-"));
	relay = await startRelayDev({ port: PORT, persistTo: dir, vars: { TEAMSYNC_SECRET: SECRET } });
	session = { alice: await login(relay.url, "alice"), bob: await login(relay.url, "bob") };
	ws = session.alice.workspaceId;
});

afterEach(() => {
	for (const c of clients.splice(0)) c.destroy();
});

afterAll(async () => {
	await relay?.stop();
	rmSync(dir, { recursive: true, force: true });
});

describe("free-tier traffic levers", () => {
	it("keepalive: an idle awareness-less socket stays open without reaching the object", async () => {
		const c = track(client(relay.url, ws, KEEPALIVE));
		await c.open(docName({ workspaceId: ws, kind: "index" }), session.alice.token);
		await reset();

		await sleep(IDLE_MS);
		const s = await stats(relay.url, ws);

		expect(c.opens).toBe(1);
		expect(c.pings).toBeGreaterThanOrEqual(IDLE_MS / 5000 - 1);
		expect(s.connects).toBe(0);
		expect(s.msgs_in).toBe(0);
		expect(s.wakes).toBeLessThanOrEqual(1);
	});

	it("control: the same socket without keepalive reconnects", async () => {
		const c = track(client(relay.url, ws, { messageReconnectTimeout: 12_000 }));
		await c.open(docName({ workspaceId: ws, kind: "index" }), session.alice.token);

		await sleep(IDLE_MS);

		expect(c.opens).toBeGreaterThanOrEqual(2);
	});

	it("presence policy: peers stay visible on 10 s renewals with few messages", async () => {
		const options: ClientOptions = {
			...KEEPALIVE,
			awareness: true,
			flushDelay: 1000,
			presenceRenewalMs: 10_000,
		};
		const doc = docName({ workspaceId: ws, kind: "md", fileId: "presence-policy" });
		const a = await track(client(relay.url, ws, options)).open(doc, session.alice.token);
		const b = await track(client(relay.url, ws, options)).open(doc, session.bob.token);
		a.awareness?.setLocalStateField("user", { name: "alice" });
		b.awareness?.setLocalStateField("user", { name: "bob" });
		const aId = a.document.clientID;
		const bId = b.document.clientID;
		await waitFor(() => a.awareness?.getStates().has(bId) && b.awareness?.getStates().has(aId), {
			label: "mutual presence",
		});
		await reset();

		for (let t = 0; t < IDLE_MS; t += 2000) {
			await sleep(2000);
			expect(a.awareness?.getStates().has(bId), `alice sees bob at ${t + 2000} ms`).toBe(true);
			expect(b.awareness?.getStates().has(aId), `bob sees alice at ${t + 2000} ms`).toBe(true);
		}
		const s = await stats(relay.url, ws);

		expect(s.msgs_in).toBeLessThanOrEqual(10);
	});

	async function typing(cursor: boolean) {
		const options: ClientOptions = { ...KEEPALIVE, awareness: cursor, flushDelay: 1000 };
		const doc = docName({ workspaceId: ws, kind: "md", fileId: `typing-${cursor}` });
		const writer = await track(client(relay.url, ws, options)).open(doc, session.alice.token);
		const reader = await track(client(relay.url, ws, { ...KEEPALIVE, flushDelay: 1000 })).open(
			doc,
			session.bob.token,
		);
		await reset();

		const text = writer.document.getText("body");
		for (let i = 0; i < 200; i++) {
			text.insert(text.length, String.fromCharCode(97 + (i % 26)));
			if (cursor) {
				writer.awareness?.setLocalStateField("cursor", { anchor: text.length, head: text.length });
			}
			await sleep(100);
		}
		await waitFor(
			() =>
				!writer.provider.hasUnsyncedChanges &&
				reader.document.getText("body").toString() === text.toString(),
			{ label: "reader converges", timeout: 10_000 },
		);
		const s = await stats(relay.url, ws);
		expect(text.length).toBe(200);
		return s;
	}

	it("flushDelay: 200 keystrokes at 10/s become ≤ 25 messages and rows", async () => {
		const s = await typing(false);
		expect(s.msgs_in).toBeLessThanOrEqual(25);
		expect(s.app_rows_written).toBeLessThanOrEqual(25);
	});

	it("flushDelay: with cursor awareness, ≤ 48 messages", async () => {
		const s = await typing(true);
		expect(s.msgs_in).toBeLessThanOrEqual(48);
		expect(s.app_rows_written).toBeLessThanOrEqual(25);
	});

	it("a hard socket drop removes the peer's presence within 3 s", async () => {
		const options: ClientOptions = {
			...KEEPALIVE,
			awareness: true,
			flushDelay: 1000,
			presenceRenewalMs: 120_000,
		};
		const doc = docName({ workspaceId: ws, kind: "md", fileId: "hard-drop" });
		const aliceClient = track(client(relay.url, ws, options));
		const a = await aliceClient.open(doc, session.alice.token);
		const b = await track(client(relay.url, ws, options)).open(doc, session.bob.token);
		a.awareness?.setLocalStateField("user", { name: "alice" });
		const aId = a.document.clientID;
		await waitFor(() => b.awareness?.getStates().has(aId), { label: "bob sees alice" });

		// No reconnect: it would re-publish alice's state and mask the removal.
		aliceClient.socket.shouldConnect = false;
		aliceClient.rawSockets.at(-1)?.terminate();
		const dropped = Date.now();
		await waitFor(() => !b.awareness?.getStates().has(aId), {
			label: "alice removed from bob's awareness",
			timeout: 3000,
		});
		expect(Date.now() - dropped).toBeLessThanOrEqual(3000);
	});
});
