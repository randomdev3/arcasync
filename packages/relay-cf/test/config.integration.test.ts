/**
 * Deployment flags under `wrangler dev`: debug endpoints off, dev-login roles, response shapes.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionResponse, WorkspacesResponse } from "@teamsync/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startRelayDev } from "../scripts/dev-server.mjs";

/** This lane's port range is 21000-21999 (the inspector takes port + 10000). */
const PORT = 21_100 + Math.floor(Math.random() * 100);

type Relay = { url: string; stop: () => Promise<void> };

async function devLogin(base: string, name: string, role?: string) {
	return fetch(`${base}/api/auth/dev-login`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({
			name,
			device: { name: `${name}-device`, platform: "macos", vaultId: `${name}-vault` },
			...(role ? { role } : {}),
		}),
	});
}

describe("relay with TEAMSYNC_DEBUG_STATS=0", () => {
	let relay: Relay;
	let dir: string;

	beforeAll(async () => {
		dir = mkdtempSync(join(tmpdir(), "relay-config-"));
		relay = await startRelayDev({
			port: PORT,
			persistTo: dir,
			vars: { TEAMSYNC_DEBUG_STATS: "0" },
		});
	});

	afterAll(async () => {
		await relay?.stop();
		rmSync(dir, { recursive: true, force: true });
	});

	it("hides the debug endpoints", async () => {
		expect((await fetch(`${relay.url}/api/debug/stats?ws=x`)).status).toBe(404);
		expect((await fetch(`${relay.url}/api/debug/reset?ws=x`, { method: "POST" })).status).toBe(404);
	});

	it("gives a new member the requested role and keeps existing roles", async () => {
		const owner = SessionResponse.parse(await (await devLogin(relay.url, "alice")).json());
		expect(owner.workspaces[0]?.role).toBe("owner");

		const carol = SessionResponse.parse(
			await (await devLogin(relay.url, "carol", "viewer")).json(),
		);
		expect(carol.workspaces[0]?.role).toBe("viewer");

		// The role only applies when the membership is created.
		const again = SessionResponse.parse(await (await devLogin(relay.url, "carol", "owner")).json());
		expect(again.workspaces[0]?.role).toBe("viewer");
		const bob = SessionResponse.parse(await (await devLogin(relay.url, "bob")).json());
		expect(bob.workspaces[0]?.role).toBe("editor");

		const res = await fetch(`${relay.url}/api/workspaces`, {
			headers: { Authorization: `Bearer ${carol.sessionToken}` },
		});
		expect(res.status).toBe(200);
		const { workspaces } = WorkspacesResponse.parse(await res.json());
		expect(workspaces).toHaveLength(1);
		expect(workspaces[0]?.role).toBe("viewer");
	});

	it("rejects an unknown role", async () => {
		expect((await devLogin(relay.url, "mallory", "admin")).status).toBe(400);
	});
});
