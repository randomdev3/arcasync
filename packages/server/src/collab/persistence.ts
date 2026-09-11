import type {
	Extension,
	onChangePayload,
	onLoadDocumentPayload,
	onStoreDocumentPayload,
} from "@hocuspocus/server";
import { parseDocName } from "@teamsync/shared";
import { and, asc, desc, eq, gt, sql } from "drizzle-orm";
import * as Y from "yjs";
import type { Db } from "../db/index.js";
import { docCheckpoints, docClients, docUpdates, docs } from "../db/schema.js";
import { docCheckpointsWritten, docUpdatesAppended } from "../metrics.js";
import type { Deps } from "../types.js";
import type { CollabContext } from "./auth.js";

/** Transaction origin used while replaying persisted history into a fresh doc. */
export const LOAD_ORIGIN = "teamsync:load";

/** Rows are fetched in pages so a long update log never buffers unboundedly. */
const UPDATE_PAGE_SIZE = 500;

function clientIdOf(updateV1: Uint8Array): number | null {
	try {
		const decoded = Y.decodeUpdate(updateV1) as { structs: Array<{ id?: { client: number } }> };
		return decoded.structs[0]?.id?.client ?? null;
	} catch {
		return null;
	}
}

export async function ensureDocRow(db: Db, documentName: string): Promise<void> {
	const ref = parseDocName(documentName);
	if (!ref) throw new Error(`Unknown document name: ${documentName}`);
	await db
		.insert(docs)
		.values({ id: documentName, workspaceId: ref.workspaceId, kind: ref.kind })
		.onConflictDoNothing({ target: docs.id });
}

/** Rebuilds a document from its newest checkpoint plus every update logged after it. */
export async function loadDocumentState(db: Db, documentName: string, doc: Y.Doc): Promise<number> {
	const [checkpoint] = await db
		.select({ uptoSeq: docCheckpoints.uptoSeq, gcState: docCheckpoints.gcState })
		.from(docCheckpoints)
		.where(eq(docCheckpoints.docId, documentName))
		.orderBy(desc(docCheckpoints.uptoSeq))
		.limit(1);

	let since = 0;
	if (checkpoint) {
		Y.applyUpdateV2(doc, checkpoint.gcState, LOAD_ORIGIN);
		since = checkpoint.uptoSeq;
	}

	for (;;) {
		const rows = await db
			.select({ seq: docUpdates.seq, updateV2: docUpdates.updateV2 })
			.from(docUpdates)
			.where(and(eq(docUpdates.docId, documentName), gt(docUpdates.seq, since)))
			.orderBy(asc(docUpdates.seq))
			.limit(UPDATE_PAGE_SIZE);
		if (rows.length === 0) break;
		doc.transact(() => {
			for (const row of rows) Y.applyUpdateV2(doc, row.updateV2, LOAD_ORIGIN);
		}, LOAD_ORIGIN);
		const last = rows[rows.length - 1];
		if (!last) break;
		since = last.seq;
		if (rows.length < UPDATE_PAGE_SIZE) break;
	}

	return since;
}

/** Appends one Yjs update (V1 on the wire, stored as V2) to the log and returns its seq. */
export async function appendUpdate(
	db: Db,
	documentName: string,
	updateV1: Uint8Array,
	userId: string | null,
	fallbackClientId: number,
): Promise<number | null> {
	const updateV2 = Y.convertUpdateFormatV1ToV2(updateV1);
	const clientId = clientIdOf(updateV1) ?? fallbackClientId;

	const [bumped] = await db
		.update(docs)
		.set({ lastSeq: sql`${docs.lastSeq} + 1` })
		.where(eq(docs.id, documentName))
		.returning({ seq: docs.lastSeq });
	if (!bumped) return null;

	await db.insert(docUpdates).values({
		docId: documentName,
		seq: bumped.seq,
		updateV2,
		clientId,
		userId,
	});
	await db
		.insert(docClients)
		.values({ docId: documentName, clientId, userId })
		.onConflictDoNothing({ target: [docClients.docId, docClients.clientId] });

	docUpdatesAppended.inc();
	return bumped.seq;
}

/** Writes a garbage-collected checkpoint covering everything logged so far. */
export async function writeCheckpoint(db: Db, documentName: string, doc: Y.Doc): Promise<void> {
	const [row] = await db
		.select({ lastSeq: docs.lastSeq })
		.from(docs)
		.where(eq(docs.id, documentName))
		.limit(1);
	if (!row) return;

	const gcState = Y.encodeStateAsUpdateV2(doc);
	const stateVector = Y.encodeStateVector(doc);
	await db
		.insert(docCheckpoints)
		.values({ docId: documentName, uptoSeq: row.lastSeq, gcState, stateVector })
		.onConflictDoUpdate({
			target: [docCheckpoints.docId, docCheckpoints.uptoSeq],
			set: { gcState, stateVector, createdAt: new Date() },
		});
	docCheckpointsWritten.inc();
}

/**
 * Hocuspocus extension backing every document with an append-only update log plus
 * periodic checkpoints, so a server restart loses nothing.
 */
export function createPersistence(deps: Deps): Extension {
	return {
		extensionName: "teamsync-persistence",

		async onLoadDocument({ document, documentName }: onLoadDocumentPayload) {
			await ensureDocRow(deps.db, documentName);
			const upto = await loadDocumentState(deps.db, documentName, document);
			deps.log.debug({ documentName, upto }, "document loaded");
		},

		async onChange({ document, documentName, update, context, transactionOrigin }: onChangePayload) {
			if (transactionOrigin === LOAD_ORIGIN) return;
			const userId = (context as Partial<CollabContext> | undefined)?.userId ?? null;
			try {
				await appendUpdate(deps.db, documentName, update, userId, document.clientID);
			} catch (err) {
				deps.log.error({ err, documentName }, "failed to append doc update");
				throw err;
			}
		},

		async onStoreDocument({ document, documentName }: onStoreDocumentPayload) {
			try {
				await writeCheckpoint(deps.db, documentName, document);
			} catch (err) {
				deps.log.error({ err, documentName }, "failed to write checkpoint");
				throw err;
			}
		},
	};
}
