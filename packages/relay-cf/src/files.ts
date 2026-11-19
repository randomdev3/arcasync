/**
 * Lazy `files` projection of the index doc (D11): built on demand (files listing, chunk GC) from
 * the merged index state, writing only the rows that differ. Never run per update.
 */
import { FileMeta, type FilesResponse, INDEX_FILES } from "@teamsync/shared";
import * as Y from "yjs";
import type { SqlLike } from "./store";

export const FILES_TABLE = `CREATE TABLE IF NOT EXISTS files (
	path TEXT PRIMARY KEY, file_id TEXT NOT NULL, kind TEXT NOT NULL, hash TEXT, size INTEGER,
	mime TEXT, chunks TEXT, updated_by TEXT, updated_at INTEGER) WITHOUT ROWID`;

interface FileRow {
	path: string;
	file_id: string;
	kind: string;
	hash: string | null;
	size: number | null;
	mime: string | null;
	/** JSON array of chunk shas. */
	chunks: string | null;
	updated_by: string | null;
	updated_at: number | null;
}

const COLUMNS = [
	"path",
	"file_id",
	"kind",
	"hash",
	"size",
	"mime",
	"chunks",
	"updated_by",
	"updated_at",
] as const;

function toRow(path: string, meta: FileMeta): FileRow {
	return {
		path,
		file_id: meta.id,
		kind: meta.kind,
		hash: meta.hash ?? null,
		size: meta.size ?? null,
		mime: meta.mime ?? null,
		chunks: meta.chunks ? JSON.stringify(meta.chunks) : null,
		updated_by: meta.updatedBy,
		updated_at: meta.updatedAt,
	};
}

/** SQLite hands back numbers (or null) for INTEGER columns; compare values, not types. */
const sameValue = (a: unknown, b: unknown) =>
	a === b || (a !== null && b !== null && typeof a !== "string" && Number(a) === Number(b));

function readRows(sql: SqlLike): Map<string, FileRow> {
	const rows = sql.exec("SELECT * FROM files").toArray() as unknown as FileRow[];
	return new Map(rows.map((r) => [r.path, r]));
}

export interface Projection {
	upserts: number;
	deletes: number;
	/** Rows written by this projection, from the SQL cursors. */
	rowsWritten: number;
}

/**
 * Brings the `files` table in line with the index doc's `files` map: upserts changed or new
 * entries and deletes vanished ones, in one transaction. Invalid entries are skipped.
 */
export function projectFiles(
	sql: SqlLike,
	transaction: <T>(fn: () => T) => T,
	indexState: Uint8Array,
): Projection {
	const doc = new Y.Doc();
	Y.applyUpdate(doc, indexState);
	const wanted = new Map<string, FileRow>();
	for (const [path, value] of doc.getMap(INDEX_FILES).entries()) {
		const meta = FileMeta.safeParse(value);
		if (meta.success) wanted.set(path, toRow(path, meta.data));
	}
	doc.destroy();
	const existing = readRows(sql);
	const upserts = [...wanted.values()].filter((row) => {
		const old = existing.get(row.path);
		return !old || COLUMNS.some((col) => !sameValue(old[col], row[col]));
	});
	const deletes = [...existing.keys()].filter((path) => !wanted.has(path));
	let rowsWritten = 0;
	if (upserts.length > 0 || deletes.length > 0) {
		transaction(() => {
			for (const row of upserts) {
				const cursor = sql.exec(
					`INSERT OR REPLACE INTO files (${COLUMNS.join(", ")}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
					...COLUMNS.map((col) => row[col]),
				);
				cursor.toArray();
				rowsWritten += cursor.rowsWritten;
			}
			for (const path of deletes) {
				const cursor = sql.exec("DELETE FROM files WHERE path = ?", path);
				cursor.toArray();
				rowsWritten += cursor.rowsWritten;
			}
		});
	}
	return { upserts: upserts.length, deletes: deletes.length, rowsWritten };
}

/** The projected rows as `FilesResponse.files` (SQL NULLs become omitted fields). */
export function listFiles(sql: SqlLike): FilesResponse["files"] {
	return [...readRows(sql).values()].map((r) => ({
		path: r.path,
		id: r.file_id,
		kind: r.kind as FileMeta["kind"],
		...(r.hash === null ? {} : { hash: r.hash }),
		...(r.size === null ? {} : { size: Number(r.size) }),
		...(r.mime === null ? {} : { mime: r.mime }),
		...(r.chunks === null ? {} : { chunks: JSON.parse(r.chunks) as string[] }),
		updatedBy: r.updated_by ?? "",
		updatedAt: Number(r.updated_at ?? 0),
	}));
}

/** Every chunk sha any projected file references. */
export function referencedChunks(sql: SqlLike): Set<string> {
	const shas = new Set<string>();
	for (const row of sql.exec("SELECT chunks FROM files WHERE chunks IS NOT NULL").toArray()) {
		for (const sha of JSON.parse(String(row.chunks)) as string[]) shas.add(sha);
	}
	return shas;
}
