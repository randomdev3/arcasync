import { docName } from "@arcasync/shared";
import type {
	Extension,
	onChangePayload,
	onLoadDocumentPayload,
	onStoreDocumentPayload,
} from "@hocuspocus/server";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as Y from "yjs";
import { createPersistence, loadDocumentState } from "../collab/persistence.js";
import type { DbHandle } from "../db/index.js";
import { docCheckpoints, docClients, docs, docUpdates, users, workspaces } from "../db/schema.js";
import type { Deps } from "../types.js";
import { createTestDeps } from "./helpers.js";

let deps: Deps;
let handle: DbHandle;
let ext: Extension;
let workspaceId: string;
let userId: string;
let name: string;

/** Collect the raw V1 updates a doc emits, the way Hocuspocus hands them to `onChange`. */
function recordUpdates(doc: Y.Doc): Uint8Array[] {
	const updates: Uint8Array[] = [];
	doc.on("update", (update: Uint8Array) => updates.push(update));
	return updates;
}

async function feed(doc: Y.Doc, updates: Uint8Array[]): Promise<void> {
	for (const update of updates) {
		await ext.onChange?.({
			document: doc,
			documentName: name,
			update,
			context: { userId },
			transactionOrigin: null,
		} as unknown as onChangePayload);
	}
	updates.length = 0;
}

beforeAll(async () => {
	({ deps, handle } = await createTestDeps());
	const [ws] = await deps.db
		.insert(workspaces)
		.values({ slug: "dev", name: "Dev" })
		.returning({ id: workspaces.id });
	if (!ws) throw new Error("no workspace");
	workspaceId = ws.id;
	const [u] = await deps.db
		.insert(users)
		.values({ name: "alice", color: "#2f90d0" })
		.returning({ id: users.id });
	if (!u) throw new Error("no user");
	userId = u.id;
	name = docName({ workspaceId, kind: "index" });
	ext = createPersistence(deps);
});

afterAll(async () => {
	await handle.close();
});

describe("document persistence", () => {
	it("replays the update log into a fresh document", async () => {
		const doc = new Y.Doc();
		await ext.onLoadDocument?.({
			document: doc,
			documentName: name,
		} as unknown as onLoadDocumentPayload);

		const updates = recordUpdates(doc);
		const files = doc.getMap<Record<string, unknown>>("files");
		files.set("a.md", { id: "a", kind: "md" });
		files.set("b.md", { id: "b", kind: "md" });
		doc.getMap("meta").set("schema", 1);
		expect(updates).toHaveLength(3);
		await feed(doc, updates);

		const logged = await deps.db.select().from(docUpdates).where(eq(docUpdates.docId, name));
		expect(logged).toHaveLength(3);
		expect(logged.map((r) => r.seq).sort((a, b) => a - b)).toEqual([1, 2, 3]);
		expect(new Set(logged.map((r) => r.userId))).toEqual(new Set([userId]));

		const [docRow] = await deps.db.select().from(docs).where(eq(docs.id, name));
		expect(docRow?.lastSeq).toBe(3);
		expect(docRow?.workspaceId).toBe(workspaceId);

		const clients = await deps.db.select().from(docClients).where(eq(docClients.docId, name));
		expect(clients).toHaveLength(1);
		expect(clients[0]?.clientId).toBe(doc.clientID);

		const reloaded = new Y.Doc();
		await loadDocumentState(deps.db, name, reloaded);
		expect(Y.encodeStateVector(reloaded)).toEqual(Y.encodeStateVector(doc));
		expect(reloaded.getMap("files").toJSON()).toEqual(doc.getMap("files").toJSON());
		expect(reloaded.getMap("meta").get("schema")).toBe(1);
	});

	it("checkpoints and keeps converging on later updates", async () => {
		const doc = new Y.Doc();
		await ext.onLoadDocument?.({
			document: doc,
			documentName: name,
		} as unknown as onLoadDocumentPayload);
		expect(doc.getMap("files").toJSON()).toHaveProperty("a.md");

		await ext.onStoreDocument?.({
			document: doc,
			documentName: name,
		} as unknown as onStoreDocumentPayload);

		const checkpoints = await deps.db
			.select()
			.from(docCheckpoints)
			.where(eq(docCheckpoints.docId, name));
		expect(checkpoints).toHaveLength(1);
		expect(checkpoints[0]?.uptoSeq).toBe(3);
		expect(checkpoints[0]?.gcState.byteLength).toBeGreaterThan(0);

		const updates = recordUpdates(doc);
		doc.getMap("files").set("c.md", { id: "c", kind: "md" });
		await feed(doc, updates);

		const reloaded = new Y.Doc();
		await loadDocumentState(deps.db, name, reloaded);
		expect(Y.encodeStateVector(reloaded)).toEqual(Y.encodeStateVector(doc));
		expect(Object.keys(reloaded.getMap("files").toJSON()).sort()).toEqual(["a.md", "b.md", "c.md"]);
	});

	it("ignores updates produced while replaying history", async () => {
		const before = (await deps.db.select().from(docUpdates).where(eq(docUpdates.docId, name)))
			.length;
		const doc = new Y.Doc();
		await ext.onLoadDocument?.({
			document: doc,
			documentName: name,
		} as unknown as onLoadDocumentPayload);
		const after = (await deps.db.select().from(docUpdates).where(eq(docUpdates.docId, name)))
			.length;
		expect(after).toBe(before);
	});

	it("rejects document names outside the `ws:` namespace", async () => {
		await expect(
			ext.onLoadDocument?.({
				document: new Y.Doc(),
				documentName: "totally-bogus",
			} as unknown as onLoadDocumentPayload),
		).rejects.toThrow(/Unknown document name/);
	});
});
