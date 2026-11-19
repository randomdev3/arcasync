/**
 * P2-6 chunk GC against `wrangler dev --env dev` with local R2 and the GC delay shortened to 3 s:
 * only index writes arm the alarm, it fires once without re-arming, the grace keeps young
 * chunks, and an explicit run with grace 0 deletes exactly the unreferenced chunk.
 */
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { docName, type FileMeta, INDEX_FILES } from "@arcasync/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startRelayDev } from "../scripts/dev-server.mjs";
import {
	client,
	debugChunks,
	get,
	loginTo,
	post,
	putChunk,
	sha256Hex,
	sleep,
	waitFor,
} from "./helpers";

const PORT = 29_000 + Math.floor(Math.random() * 400);

type Relay = { url: string; stop: () => Promise<void> };
let relay: Relay;
let dir: string;
const cleanup: Array<() => void> = [];

interface AlarmState {
	alarmAt: number | null;
	gcLast: { at: number; listed: number; deleted: number; kept: number; capped: boolean } | null;
}
const alarm = async (ws: string) =>
	(await get(relay.url, `/api/debug/alarm?ws=${ws}`)) as AlarmState;

beforeAll(async () => {
	dir = mkdtempSync(join(tmpdir(), "relay-gc-"));
	relay = await startRelayDev({
		port: PORT,
		persistTo: dir,
		vars: { ARCASYNC_CHUNK_GC_DELAY_MS: "3000" },
	});
});

afterAll(async () => {
	for (const fn of cleanup) fn();
	await relay?.stop();
	rmSync(dir, { recursive: true, force: true });
});

describe("chunk GC", () => {
	it("an index write arms one alarm; it fires once, keeps young chunks and never re-arms", async () => {
		const alice = await loginTo(relay.url, "alice", "gc");
		const ws = alice.workspaceId;
		const jwt = await alice.token();
		const blobs = [0, 1, 2].map(() => randomBytes(64 * 1024));
		const shas = blobs.map(sha256Hex);
		for (const [i, blob] of blobs.entries()) {
			expect((await putChunk(relay.url, jwt, shas[i] as string, blob)).status).toBe(200);
		}
		expect(await alarm(ws)).toEqual({ alarmAt: null, gcLast: null });

		const c = client(relay.url, ws);
		cleanup.push(c.destroy);
		const index = await c.open(docName({ workspaceId: ws, kind: "index" }), alice.token);
		const meta: FileMeta = {
			id: "bin1",
			kind: "binary",
			hash: "h",
			size: 2,
			chunks: [shas[0] as string, shas[1] as string],
			updatedBy: alice.session.user.id,
			updatedAt: Date.now(),
		};
		index.document.getMap<FileMeta>(INDEX_FILES).set("Shared/a.bin", meta);
		await waitFor(() => !index.provider.hasUnsyncedChanges, { label: "index acked" });
		const armed = await waitFor(async () => (await alarm(ws)).alarmAt, {
			timeout: 2000,
			label: "alarm armed",
		});
		expect(armed).toBeGreaterThan(Date.now());

		// More index writes in the same wake do not move or add an alarm.
		index.document.getMap<FileMeta>(INDEX_FILES).set("Shared/b.bin", { ...meta, id: "bin2" });
		await waitFor(() => !index.provider.hasUnsyncedChanges, { label: "index acked" });
		expect((await alarm(ws)).alarmAt).toBe(armed);

		const fired = await waitFor(
			async () => {
				const state = await alarm(ws);
				return state.alarmAt === null && state.gcLast ? state.gcLast : null;
			},
			{ timeout: 10_000, interval: 200, label: "alarm fired" },
		);
		// The default 24 h grace keeps every young chunk.
		expect(fired).toMatchObject({ listed: 3, deleted: 0, kept: 3, capped: false });
		expect(await debugChunks(relay.url, ws)).toHaveLength(3);
		// No self re-arm.
		await sleep(1000);
		expect((await alarm(ws)).alarmAt).toBeNull();

		const run = await post(relay.url, `/api/debug/gc?ws=${ws}&graceMs=0`, {});
		expect(run).toEqual({ listed: 3, deleted: 1, kept: 2, capped: false });
		const left = (await debugChunks(relay.url, ws)).map((o) => o.key).sort();
		expect(left).toEqual([`ws/${ws}/${shas[0]}`, `ws/${ws}/${shas[1]}`].sort());
		expect((await alarm(ws)).alarmAt).toBeNull();
		c.destroy();
	});

	it("never arms in a workspace that only sees md writes and pings", async () => {
		const bob = await loginTo(relay.url, "bob", "gc-idle");
		const ws = bob.workspaceId;
		const c = client(relay.url, ws, { keepaliveMs: 500 });
		cleanup.push(c.destroy);
		const note = await c.open(docName({ workspaceId: ws, kind: "md", fileId: "n1" }), bob.token);
		for (let i = 0; i < 5; i++) {
			note.document.getText("body").insert(0, `edit ${i}\n`);
			await waitFor(() => !note.provider.hasUnsyncedChanges, { label: "md acked" });
			await sleep(1000);
		}
		expect(c.pings).toBeGreaterThan(0);
		expect(await alarm(ws)).toEqual({ alarmAt: null, gcLast: null });
		c.destroy();
	});
});
