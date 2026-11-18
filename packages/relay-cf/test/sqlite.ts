import { DatabaseSync } from "node:sqlite";
import type { SqlLike } from "../src/store";

/** node:sqlite stand-in for Durable Object `SqlStorage` (rowsWritten = rows changed). */
export function memorySql(): { sql: SqlLike; transaction: <T>(fn: () => T) => T } {
	const db = new DatabaseSync(":memory:");
	const sql: SqlLike = {
		exec(query, ...bindings) {
			const stmt = db.prepare(query);
			const params = bindings as Parameters<typeof stmt.all>;
			if (/^\s*SELECT/i.test(query)) {
				const rows = stmt.all(...params) as Record<string, unknown>[];
				return { toArray: () => rows, rowsWritten: 0 };
			}
			const { changes } = stmt.run(...params);
			return { toArray: () => [], rowsWritten: Number(changes) };
		},
	};
	const transaction = <T>(fn: () => T): T => {
		db.exec("BEGIN");
		try {
			const result = fn();
			db.exec("COMMIT");
			return result;
		} catch (err) {
			db.exec("ROLLBACK");
			throw err;
		}
	};
	return { sql, transaction };
}
