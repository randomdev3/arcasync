import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { sql } from "drizzle-orm";
import { drizzle as drizzlePg } from "drizzle-orm/node-postgres";
import { migrate as migratePg } from "drizzle-orm/node-postgres/migrator";
import type { PgDatabase } from "drizzle-orm/pg-core";
import { drizzle as drizzlePglite } from "drizzle-orm/pglite";
import { migrate as migratePglite } from "drizzle-orm/pglite/migrator";
import pg from "pg";
import type { Config } from "../config.js";
import * as schema from "./schema.js";

export * as schema from "./schema.js";

/**
 * Common query surface of both drivers. `PgDatabase` is the shared base class of
 * `NodePgDatabase` and `PgliteDatabase`; the query-result HKT is left open so the
 * two are interchangeable at the call sites.
 */
// biome-ignore lint/suspicious/noExplicitAny: query-result HKT differs per driver
export type Db = PgDatabase<any, typeof schema, any>;

/** Absolute path to the committed `drizzle/` migrations folder. */
export const MIGRATIONS_FOLDER = fileURLToPath(new URL("../../drizzle", import.meta.url));

export interface DbHandle {
	db: Db;
	kind: "pglite" | "pg";
	migrate(): Promise<void>;
	close(): Promise<void>;
}

/**
 * NOTE: never construct more than one PGlite instance concurrently in a single
 * process — concurrent WASM initialisation can SIGSEGV V8 (nodejs/node#64500).
 */
export function createDb(config: Pick<Config, "dbUrl" | "pgliteDir">): DbHandle {
	if (!config.dbUrl) {
		const client = new PGlite(config.pgliteDir);
		const db = drizzlePglite(client, { schema }) as unknown as Db;
		return {
			db,
			kind: "pglite",
			async migrate() {
				await migratePglite(drizzlePglite(client, { schema }), {
					migrationsFolder: MIGRATIONS_FOLDER,
				});
			},
			async close() {
				await client.close();
			},
		};
	}

	const pool = new pg.Pool({ connectionString: config.dbUrl });
	const db = drizzlePg(pool, { schema }) as unknown as Db;
	return {
		db,
		kind: "pg",
		async migrate() {
			await migratePg(drizzlePg(pool, { schema }), { migrationsFolder: MIGRATIONS_FOLDER });
		},
		async close() {
			await pool.end();
		},
	};
}

export async function pingDb(db: Db): Promise<void> {
	await db.execute(sql`select 1`);
}
