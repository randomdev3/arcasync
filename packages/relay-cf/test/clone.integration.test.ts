/**
 * P2-5 against `wrangler dev --env dev`: bulk clone (`POST /api/workspaces/:id/docs`, binary,
 * no rows written, rate-limited) and the lazy files projection (`GET /api/workspaces/:id/files`).
 */
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	CLONE_MAX_DOCS,
	decodeClone,
	docName,
	type FileMeta,
	FilesResponse,
	INDEX_FILES,
	ServerInfo,
} from "@arcasync/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as Y from "yjs";
import { startRelayDev } from "../scripts/dev-server.mjs";
import { client, errorCode, get, loginTo, patch, resetStats, stats, waitFor } from "./helpers";

const PORT = 28_000 + Math.floor(Math.random() * 400);
const MiB = 1024 * 1024;

type Relay = { url: string; stop: () => Promise<void> };
type Login = Awaited<ReturnType<typeof loginTo>>;
let relay: Relay;
let dir: string;
let alice: Login;
let other: Login;
let jwt: string;
const cleanup: Array<() => void> = [];

const md = (id: string, ws = alice.workspaceId) =>
	docName({ workspaceId: ws, kind: "md", fileId: id });
const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64");

async function clone(
	token: string,
	docs: { doc: string; sv?: string }[],
	workspaceId = alice.workspaceId,
) {
	const res = await fetch(`${relay.url}/api/workspaces/${workspaceId}/docs`, {
		method: "POST",
		headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
		body: JSON.stringify({ docs }),
	});
	const bytes = new Uint8Array(await res.arrayBuffer());
	return { status: res.status, headers: res.headers, bytes };
}

async function files(token: string, workspaceId = alice.workspaceId) {
	const res = await fetch(`${relay.url}/api/workspaces/${workspaceId}/files`, {
		headers: { authorization: `Bearer ${token}` },
	});
	return { status: res.status, body: (await res.json()) as unknown };
}

const textOf = (update: Uint8Array) => {
	const doc = new Y.Doc();
	Y.applyUpdate(doc, update);
	return doc.getText("body").toString();
};

/** The texts written by providers, by doc name. */
const written = new Map<string, string>();
const fileMetas = new Map<string, FileMeta>();

beforeAll(async () => {
	dir = mkdtempSync(join(tmpdir(), "relay-clone-"));
	relay = await startRelayDev({ port: PORT, persistTo: dir });
	alice = await loginTo(relay.url, "alice", "clone");
	other = await loginTo(relay.url, "alice", "clone-other");
	jwt = await alice.token();

	const c = client(relay.url, alice.workspaceId);
	cleanup.push(c.destroy);
	const index = await c.open(
		docName({ workspaceId: alice.workspaceId, kind: "index" }),
		alice.token,
	);
	const filesMap = index.document.getMap<FileMeta>(INDEX_FILES);
	for (let i = 1; i <= 30; i++) {
		const id = `n${String(i).padStart(2, "0")}`;
		const { document, provider } = await c.open(md(id), alice.token);
		const text = `note ${i}\n${"x".repeat(i * 10)}`;
		document.getText("body").insert(0, text);
		written.set(md(id), text);
		const meta: FileMeta = {
			id,
			kind: "md",
			updatedBy: alice.session.user.id,
			updatedAt: 1000 + i,
		};
		filesMap.set(`Shared/${id}.md`, meta);
		fileMetas.set(`Shared/${id}.md`, meta);
		await waitFor(() => !provider.hasUnsyncedChanges, { label: `${id} acked` });
	}
	await waitFor(() => !index.provider.hasUnsyncedChanges, { label: "index acked" });
	c.destroy();
});

afterAll(async () => {
	for (const fn of cleanup) fn();
	await relay?.stop();
	rmSync(dir, { recursive: true, force: true });
});

describe("bulk clone", () => {
	it("advertises features.bulkClone", async () => {
		expect(ServerInfo.parse(await get(relay.url, "/api/server-info")).features.bulkClone).toBe(
			true,
		);
	});

	it("returns the merged state of 30 docs in one request, without WS traffic", async () => {
		await resetStats(relay.url, alice.workspaceId);
		const before = await stats(relay.url, alice.workspaceId);
		const docs = [...written.keys()].map((doc) => ({ doc }));
		const res = await clone(jwt, docs);
		expect(res.status).toBe(200);
		expect(res.headers.get("content-type")).toBe("application/octet-stream");
		const { entries, remaining } = decodeClone(res.bytes);
		expect(remaining).toEqual([]);
		expect(entries.map((e) => e.doc)).toEqual([...written.keys()]);
		for (const e of entries) expect(textOf(e.update)).toBe(written.get(e.doc));
		const after = await stats(relay.url, alice.workspaceId);
		expect(after.clone_requests - before.clone_requests).toBe(1);
		expect(after.clone_docs - before.clone_docs).toBe(30);
		expect(after.msgs_in - before.msgs_in).toBe(0);
		expect(after.app_rows_written - before.app_rows_written).toBe(0);
	});

	it("answers with a diff against a state vector", async () => {
		const c = client(relay.url, alice.workspaceId);
		cleanup.push(c.destroy);
		const { document, provider } = await c.open(md("half"), alice.token);
		document.getText("body").insert(0, `first half ${"a".repeat(2000)}`);
		await waitFor(() => !provider.hasUnsyncedChanges, { label: "first half acked" });
		const local = new Y.Doc();
		Y.applyUpdate(local, Y.encodeStateAsUpdate(document));
		document
			.getText("body")
			.insert(document.getText("body").length, ` second half ${"b".repeat(50)}`);
		await waitFor(() => !provider.hasUnsyncedChanges, { label: "second half acked" });
		const full = document.getText("body").toString();
		c.destroy();

		const sv = b64(Y.encodeStateVector(local));
		const diff = await clone(jwt, [{ doc: md("half"), sv }]);
		const whole = await clone(jwt, [{ doc: md("half") }]);
		const [d] = decodeClone(diff.bytes).entries;
		const [w] = decodeClone(whole.bytes).entries;
		if (!d || !w) throw new Error("missing entry");
		Y.applyUpdate(local, d.update);
		expect(local.getText("body").toString()).toBe(full);
		expect(d.update.length).toBeLessThan(w.update.length);
	});

	it("refuses other workspaces' docs, index docs, bad bodies and too many docs", async () => {
		const foreign = await clone(jwt, [{ doc: md("n01", other.workspaceId) }]);
		expect(foreign.status).toBe(400);
		const index = await clone(jwt, [
			{ doc: docName({ workspaceId: alice.workspaceId, kind: "index" }) },
		]);
		expect(index.status).toBe(400);
		const tooMany = Array.from({ length: CLONE_MAX_DOCS + 1 }, (_, i) => ({ doc: md(`m${i}`) }));
		expect((await clone(jwt, tooMany)).status).toBe(400);
		// A JWT for another workspace is not valid here.
		expect((await clone(await other.token(), [{ doc: md("n01") }])).status).toBe(401);
		expect((await clone("", [{ doc: md("n01") }])).status).toBe(401);
	});

	it("serves viewers", async () => {
		const vic = await loginTo(relay.url, "vic", "clone", "viewer");
		const res = await clone(await vic.token(), [{ doc: md("n01") }]);
		expect(res.status).toBe(200);
		expect(textOf(decodeClone(res.bytes).entries[0]?.update ?? new Uint8Array())).toBe(
			written.get(md("n01")),
		);
		expect((await files(await vic.token())).status).toBe(200);
	});

	it("caps a response at CLONE_MAX_BYTES: 3 docs of 3 MiB → 2 entries + 1 remaining", async () => {
		const c = client(relay.url, alice.workspaceId);
		cleanup.push(c.destroy);
		const big = ["big1", "big2", "big3"];
		for (const id of big) {
			const { document, provider } = await c.open(md(id), alice.token);
			// Sub-MiB transactions: one WS message and one tail row each.
			for (let part = 0; part < 6; part++) {
				const text = randomBytes(384 * 1024).toString("base64");
				document.getText("body").insert(document.getText("body").length, text);
				await waitFor(() => !provider.hasUnsyncedChanges, { label: `${id} part ${part}` });
			}
			expect(document.getText("body").length).toBe(6 * 512 * 1024);
		}
		c.destroy();
		const res = await clone(
			jwt,
			big.map((id) => ({ doc: md(id) })),
		);
		expect(res.status).toBe(200);
		const { entries, remaining } = decodeClone(res.bytes);
		expect(entries.map((e) => e.doc)).toEqual([md("big1"), md("big2")]);
		expect(remaining).toEqual([md("big3")]);
		for (const e of entries) expect(e.update.length).toBeGreaterThan(3 * MiB);
	});

	it("rate-limits per user: 11 rapid calls give at least one 429 with Retry-After", async () => {
		const rita = await loginTo(relay.url, "rita", "clone");
		const token = await rita.token();
		const results = await Promise.all(
			Array.from({ length: 11 }, () => clone(token, [{ doc: md("n01") }])),
		);
		const limited = results.filter((r) => r.status === 429);
		expect(limited.length).toBeGreaterThanOrEqual(1);
		expect(Number(limited[0]?.headers.get("retry-after"))).toBeGreaterThanOrEqual(1);
		expect(results.filter((r) => r.status === 200).length).toBe(10);
	});
});

describe("files listing", () => {
	it("equals the index map and writes no rows when nothing changed", async () => {
		const first = await files(jwt);
		expect(first.status).toBe(200);
		const listed = FilesResponse.parse(first.body).files;
		expect(listed.map((f) => [f.path, f.id, f.kind]).sort()).toEqual(
			[...fileMetas].map(([path, m]) => [path, m.id, m.kind]).sort(),
		);
		expect(listed.find((f) => f.path === "Shared/n05.md")).toEqual({
			path: "Shared/n05.md",
			...fileMetas.get("Shared/n05.md"),
		});

		await resetStats(relay.url, alice.workspaceId);
		const again = await files(jwt);
		expect(again.body).toEqual(first.body);
		expect((await stats(relay.url, alice.workspaceId)).app_rows_written).toBe(0);
	});

	it("counts projection writes for changed entries only", async () => {
		const c = client(relay.url, alice.workspaceId);
		cleanup.push(c.destroy);
		const index = await c.open(
			docName({ workspaceId: alice.workspaceId, kind: "index" }),
			alice.token,
		);
		const map = index.document.getMap<FileMeta>(INDEX_FILES);
		map.delete("Shared/n01.md");
		map.set("Shared/renamed.md", fileMetas.get("Shared/n01.md") as FileMeta);
		await waitFor(() => !index.provider.hasUnsyncedChanges, { label: "index acked" });
		c.destroy();
		await resetStats(relay.url, alice.workspaceId);
		const listed = FilesResponse.parse((await files(jwt)).body).files;
		expect(listed.some((f) => f.path === "Shared/renamed.md")).toBe(true);
		expect(listed.some((f) => f.path === "Shared/n01.md")).toBe(false);
		expect((await stats(relay.url, alice.workspaceId)).app_rows_written).toBe(2);
	});

	it("refuses a revoked user's JWT with 401", async () => {
		const sam = await loginTo(relay.url, "sam", "clone");
		const stale = await sam.token();
		expect((await files(stale)).status).toBe(200);
		await patch(
			relay.url,
			`/api/workspaces/${alice.workspaceId}/members/${sam.session.user.id}`,
			{ role: "viewer" },
			alice.session.sessionToken,
		);
		expect((await files(stale)).status).toBe(401);
		const res = await clone(stale, [{ doc: md("n01") }]);
		expect(res.status).toBe(401);
		expect(errorCode(JSON.parse(Buffer.from(res.bytes).toString()))).toBe("unauthorized");
	});

	it("rejects a malformed workspace id in the Worker", async () => {
		expect((await files(jwt, "bad%20id")).status).toBe(400);
	});
});
