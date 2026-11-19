/** The PIN/password migration on an AccountsDO database as it exists in production. */
import { describe, expect, it } from "vitest";
import { migratePinsAndPasswords, PIN_AND_PASSWORD_TABLES } from "../src/accounts/schema";
import { memorySql } from "./sqlite";

/** AccountsDO's schema before PINs and passwords (main at d894c66), one statement each. */
const SHIPPED_SCHEMA = [
	`CREATE TABLE users (id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, email TEXT, color TEXT NOT NULL,
		avatar_url TEXT, is_admin INTEGER NOT NULL DEFAULT 0, disabled_at INTEGER)`,
	`CREATE TABLE devices (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, name TEXT NOT NULL,
		platform TEXT NOT NULL, vault_id TEXT NOT NULL, UNIQUE (user_id, vault_id))`,
	`CREATE TABLE sessions (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, device_id TEXT NOT NULL,
		token_hash TEXT NOT NULL UNIQUE, expires_at INTEGER NOT NULL, revoked_at INTEGER)`,
	`CREATE TABLE workspaces (id TEXT PRIMARY KEY, slug TEXT NOT NULL UNIQUE, name TEXT NOT NULL,
		deleted_at INTEGER)`,
	`CREATE TABLE memberships (workspace_id TEXT NOT NULL, user_id TEXT NOT NULL, role TEXT NOT NULL,
		PRIMARY KEY (workspace_id, user_id))`,
	"CREATE TABLE server_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)",
	`CREATE TABLE audit_log (id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, actor_id TEXT,
		action TEXT NOT NULL, target TEXT NOT NULL, details TEXT NOT NULL DEFAULT '{}')`,
	`CREATE TABLE invites (id TEXT PRIMARY KEY, token_hash TEXT NOT NULL UNIQUE,
		workspace_id TEXT NOT NULL, role TEXT NOT NULL, admin INTEGER NOT NULL DEFAULT 0,
		max_uses INTEGER NOT NULL, uses INTEGER NOT NULL DEFAULT 0, expires_at INTEGER NOT NULL,
		revoked_at INTEGER, created_by TEXT, created_at INTEGER NOT NULL, user_id TEXT)`,
	`CREATE TABLE device_codes (id TEXT PRIMARY KEY, code_hash TEXT NOT NULL UNIQUE,
		user_code TEXT NOT NULL UNIQUE, device TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending',
		user_id TEXT, expires_at INTEGER NOT NULL, created_at INTEGER NOT NULL)`,
];

const TABLES = [
	"users",
	"devices",
	"sessions",
	"workspaces",
	"memberships",
	"server_settings",
	"audit_log",
	"invites",
	"device_codes",
];

function dump(sql: ReturnType<typeof memorySql>["sql"]) {
	return Object.fromEntries(
		TABLES.map((t) => [t, sql.exec(`SELECT * FROM ${t} ORDER BY rowid`).toArray()]),
	);
}

describe("migratePinsAndPasswords", () => {
	it("only creates tables and indexes", () => {
		for (const statement of PIN_AND_PASSWORD_TABLES) {
			expect(statement).toMatch(/^CREATE (TABLE|INDEX) IF NOT EXISTS /);
		}
	});

	it("keeps every existing row and is idempotent", () => {
		const { sql } = memorySql();
		for (const statement of SHIPPED_SCHEMA) sql.exec(statement);
		sql.exec("INSERT INTO users (id, name, color, is_admin) VALUES ('u1', 'dave', '#fff', 1)");
		sql.exec("INSERT INTO workspaces (id, slug, name) VALUES ('w1', 'friends', 'Friends')");
		sql.exec("INSERT INTO memberships VALUES ('w1', 'u1', 'owner')");
		sql.exec("INSERT INTO devices VALUES ('d1', 'u1', 'mac', 'macos', 'v1')");
		sql.exec(
			"INSERT INTO sessions (id, user_id, device_id, token_hash, expires_at) VALUES ('s1', 'u1', 'd1', 'h', 9)",
		);
		sql.exec("INSERT INTO server_settings VALUES ('bootstrapped_at', '1')");
		sql.exec("INSERT INTO audit_log (at, action, target) VALUES (1, 'bootstrap', 'w1')");
		sql.exec(`INSERT INTO invites (id, token_hash, workspace_id, role, max_uses, expires_at, created_at)
			VALUES ('i1', 'th', 'w1', 'owner', 1, 9, 1)`);
		const before = dump(sql);

		migratePinsAndPasswords(sql);
		migratePinsAndPasswords(sql);

		expect(dump(sql)).toEqual(before);
		const tables = sql
			.exec("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
			.toArray()
			.map((r) => r.name);
		expect(tables).toEqual(
			expect.arrayContaining(["user_passwords", "invite_pins", "pin_failures", "login_failures"]),
		);
		sql.exec(`INSERT INTO user_passwords VALUES ('u1', 'h', 's', 100000, 6, 1)`);
		sql.exec(`INSERT INTO invite_pins (id, pin, workspace_id, role, expires_at, created_by, created_at)
			VALUES ('p1', '0420', 'w1', 'editor', 9, 'u1', 1)`);
		migratePinsAndPasswords(sql);
		expect(sql.exec("SELECT COUNT(*) AS n FROM user_passwords").toArray()).toEqual([{ n: 1 }]);
		expect(sql.exec("SELECT COUNT(*) AS n FROM invite_pins").toArray()).toEqual([{ n: 1 }]);
	});
});
