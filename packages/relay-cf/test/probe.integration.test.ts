/**
 * R-7: the load probe's own counts match the relay's counters under `wrangler dev --env dev`,
 * so the same probe can be trusted against a real deployment (R-9).
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startRelayDev } from "../scripts/dev-server.mjs";
import { type PhaseResult, runProbe } from "../scripts/load-probe.ts";

/** This lane's port range is 21000-21999 (the inspector takes port + 10000). */
const PORT = 21_300 + Math.floor(Math.random() * 100);

type Relay = { url: string; stop: () => Promise<void> };
let relay: Relay;
let dir: string;

beforeAll(async () => {
	dir = mkdtempSync(join(tmpdir(), "relay-probe-"));
	relay = await startRelayDev({ port: PORT, persistTo: dir });
});

afterAll(async () => {
	await relay?.stop();
	rmSync(dir, { recursive: true, force: true });
});

describe("load probe", () => {
	it("counts exactly what the relay counts, per phase", async () => {
		const result = await runProbe({
			url: relay.url,
			pings: 20,
			frames: 30,
			rows: 40,
			connects: 5,
			pauseMs: 500,
		});
		const phase = (name: PhaseResult["phase"]) => {
			const p = result.phases.find((x) => x.phase === name);
			if (!p?.measured) throw new Error(`no measured ${name} phase`);
			return { ...p, measured: p.measured };
		};
		expect(result.phases.map((p) => p.phase)).toEqual(["pings", "frames", "rows", "connects"]);

		for (const p of result.phases) {
			expect(p.measured?.msgs_in, `${p.phase} msgs_in`).toBe(p.sent.binaryFrames);
			expect(p.measured?.closes, `${p.phase} closes`).toBe(p.sent.closes);
			expect(p.measured?.connects, `${p.phase} connects`).toBe(p.sent.upgrades);
			expect(p.measured?.app_rows_written, `${p.phase} rows`).toBe(p.expected.rowsWritten);
		}

		// Auto-responded pings never reach webSocketMessage.
		const pings = phase("pings");
		expect(pings.sent.pings).toBe(20);
		expect(pings.measured.msgs_in).toBe(0);
		expect(phase("frames").measured.msgs_in).toBe(31);
		// P1-8 adds a doc_clients row on a new client's first update: then this becomes 41.
		expect(phase("rows").measured.app_rows_written).toBe(40);
		expect(phase("connects").measured.connects).toBe(5);
		expect(phase("connects").measured.msgs_in).toBe(5);

		expect(pings.expected.relayDoRequests1to1).toBe(1 + 20 + 1);
		expect(phase("rows").expected.relayDoRequests20to1).toBe(1 + Math.ceil(41 / 20) + 1);
	});
});
