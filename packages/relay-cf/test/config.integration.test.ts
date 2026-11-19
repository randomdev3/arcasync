/**
 * Deployment flags under `wrangler dev`: debug endpoints off, dev-login roles, response shapes.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionResponse, WorkspacesResponse } from "@arcasync/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { startRelayDev } from "../scripts/dev-server.mjs";

/** This lane's port range is 21000-21999 (the inspector takes port + 10000). */
const PORT = 21_100 + Math.floor(Math.random() * 100);

type Relay = { url: string; stop: () => Promise<void> };

async function devLogin(base: string, name: string, role?: string, workspace?: string) {
	return fetch(`${base}/api/auth/dev-login`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({
			name,
			device: { name: `${name}-device`, platform: "macos", vaultId: `${name}-vault` },
			...(role ? { role } : {}),
			...(workspace ? { workspace } : {}),
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
		const doc = encodeURIComponent("ws:x:index");
		expect((await fetch(`${relay.url}/api/debug/doc?ws=x&doc=${doc}`)).status).toBe(404);
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

	it("joins or creates the dev-login workspace slug", async () => {
		await devLogin(relay.url, "alice");
		const alice = SessionResponse.parse(
			await (await devLogin(relay.url, "alice", undefined, "second")).json(),
		);
		const bySlug = (s: SessionResponse, slug: string) => s.workspaces.find((w) => w.slug === slug);
		expect(alice.workspaces.map((w) => w.slug).sort()).toEqual(["dev", "second"]);
		// alice is the first member of `second`, so she owns it; her `dev` role is unchanged.
		expect(bySlug(alice, "second")?.role).toBe("owner");
		expect(bySlug(alice, "dev")?.role).toBe("owner");

		const erin = SessionResponse.parse(
			await (await devLogin(relay.url, "erin", undefined, "second")).json(),
		);
		expect(erin.workspaces.map((w) => [w.slug, w.role])).toEqual([["second", "editor"]]);
		expect(bySlug(erin, "second")?.id).toBe(bySlug(alice, "second")?.id);

		expect((await devLogin(relay.url, "erin", undefined, "Not A Slug")).status).toBe(400);
	});

	it("rejects an unknown role", async () => {
		expect((await devLogin(relay.url, "mallory", "admin")).status).toBe(400);
	});
});

describe("relay with TEAMSYNC_ALLOW_DEV_SECRET=0 (the dev secret is then rejected)", () => {
	let relay: Relay;
	let dir: string;

	beforeAll(async () => {
		dir = mkdtempSync(join(tmpdir(), "relay-config-"));
		relay = await startRelayDev({
			port: PORT + 100,
			persistTo: dir,
			vars: { TEAMSYNC_ALLOW_DEV_SECRET: "0" },
		});
	});

	afterAll(async () => {
		await relay?.stop();
		rmSync(dir, { recursive: true, force: true });
	});

	it("reports the problem on /api/health", async () => {
		const body = (await (await fetch(`${relay.url}/api/health`)).json()) as {
			ok: boolean;
			error?: string;
		};
		expect(body.ok).toBe(false);
		expect(body.error).toMatch(/dev secret/);
	});

	it("answers 503 misconfigured on every other route", async () => {
		const login = await devLogin(relay.url, "alice");
		expect(login.status).toBe(503);
		const body = (await login.json()) as { error: { code: string } };
		expect(body.error.code).toBe("misconfigured");
		expect((await fetch(`${relay.url}/api/server-info`)).status).toBe(503);
		expect((await fetch(`${relay.url}/api/debug/stats?ws=x`)).status).toBe(503);
		const upgradeStatus = await new Promise<number>((resolve, reject) => {
			const socket = new WebSocket(`${relay.url.replace(/^http/, "ws")}/ws?ws=x`);
			socket.on("unexpected-response", (_req, res) => {
				resolve(res.statusCode ?? 0);
				socket.terminate();
			});
			socket.on("open", () => reject(new Error("upgrade succeeded")));
			socket.on("error", () => {});
		});
		expect(upgradeStatus).toBe(503);
	});
});
