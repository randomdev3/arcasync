/** The PIN/password migration on an AccountsDO database as it exists in production. */
import { describe, expect, it } from "vitest";
import {
	backfillTeams,
	migratePinsAndPasswords,
	migrateTeams,
	PIN_AND_PASSWORD_TABLES,
	TEAM_TABLES,
} from "../src/accounts/schema";
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

describe("migrateTeams + backfillTeams", () => {
	/** The schema as deployed before teams (with PINs and passwords), plus live data. */
	function preTeams() {
		const { sql } = memorySql();
		for (const statement of SHIPPED_SCHEMA) sql.exec(statement);
		migratePinsAndPasswords(sql);
		sql.exec("INSERT INTO users (id, name, color, is_admin) VALUES ('u1', 'dave', '#fff', 1)");
		sql.exec("INSERT INTO users (id, name, color) VALUES ('u2', 'erin', '#fff')");
		sql.exec("INSERT INTO workspaces (id, slug, name) VALUES ('w1', 'friends', 'Friends')");
		sql.exec("INSERT INTO workspaces (id, slug, name) VALUES ('w2', 'work', 'Work')");
		sql.exec("INSERT INTO workspaces (id, slug, name, deleted_at) VALUES ('w3', 'old', 'Old', 5)");
		sql.exec("INSERT INTO memberships VALUES ('w1', 'u1', 'owner')");
		sql.exec("INSERT INTO memberships VALUES ('w1', 'u2', 'editor')");
		sql.exec("INSERT INTO memberships VALUES ('w2', 'u2', 'owner')");
		sql.exec(`INSERT INTO invites (id, token_hash, workspace_id, role, max_uses, expires_at, created_at)
			VALUES ('i1', 'th', 'w2', 'viewer', 1, 9, 1)`);
		sql.exec(`INSERT INTO invites (id, token_hash, workspace_id, role, max_uses, expires_at, created_at,
			user_id) VALUES ('i2', 'th2', '', 'viewer', 1, 9, 1, 'u2')`);
		sql.exec(`INSERT INTO invite_pins (id, pin, workspace_id, role, expires_at, created_by, created_at)
			VALUES ('p1', '0420', 'w1', 'editor', 9, 'u1', 1)`);
		return sql;
	}

	const migrate = (sql: ReturnType<typeof memorySql>["sql"]) => {
		migrateTeams(sql);
		backfillTeams(sql, 1000);
	};

	it("only creates tables and indexes in its table list", () => {
		for (const statement of TEAM_TABLES) {
			expect(statement).toMatch(/^CREATE (TABLE|INDEX) IF NOT EXISTS /);
		}
	});

	it("gives each live workspace its own team with the members copied, once", () => {
		const sql = preTeams();
		const before = dump(sql);
		migrate(sql);
		migrate(sql);

		const teams = sql.exec("SELECT * FROM teams ORDER BY slug").toArray();
		expect(teams).toEqual([
			expect.objectContaining({ slug: "friends", name: "Friends", created_by: "u1" }),
			expect.objectContaining({ slug: "work", name: "Work", created_by: "u2" }),
		]);
		const teamOf = (ws: string) =>
			sql.exec("SELECT team_id FROM workspaces WHERE id = ?", ws).toArray()[0]?.team_id;
		const friends = teams[0]?.id;
		expect(teamOf("w1")).toBe(friends);
		expect(teamOf("w2")).toBe(teams[1]?.id);
		expect(teamOf("w3")).toBeNull();
		expect(
			sql
				.exec("SELECT team_id, user_id, role FROM team_members ORDER BY team_id, user_id")
				.toArray(),
		).toEqual(
			[
				{ team_id: friends, user_id: "u1", role: "owner" },
				{ team_id: friends, user_id: "u2", role: "editor" },
				{ team_id: teams[1]?.id, user_id: "u2", role: "owner" },
			].sort((a, b) => String(a.team_id).localeCompare(String(b.team_id))),
		);
		expect(sql.exec("SELECT id, team_id FROM invites ORDER BY id").toArray()).toEqual([
			{ id: "i1", team_id: teams[1]?.id },
			{ id: "i2", team_id: null },
		]);
		expect(sql.exec("SELECT team_id FROM invite_pins").toArray()).toEqual([{ team_id: friends }]);

		// Nothing that existed before changed, apart from the new columns.
		const after = dump(sql);
		for (const table of Object.keys(before)) {
			const strip = (rows: Record<string, unknown>[]) =>
				rows.map(({ team_id: _, ...rest }) => rest);
			expect(strip(after[table] as Record<string, unknown>[]), table).toEqual(
				strip(before[table] as Record<string, unknown>[]),
			);
		}
	});

	it("dedupes team slugs", () => {
		const sql = preTeams();
		migrateTeams(sql);
		sql.exec("INSERT INTO teams (id, slug, name, created_at) VALUES ('t0', 'friends', 'Taken', 1)");
		backfillTeams(sql, 1000);
		expect(sql.exec("SELECT slug FROM teams WHERE id != 't0' ORDER BY slug").toArray()).toEqual([
			{ slug: "friends-2" },
			{ slug: "work" },
		]);
	});

	it("rebuilds teams after the strip the integration test applies to a migrated database", () => {
		const sql = preTeams();
		migrate(sql);
		// The same statements as teams.integration.test.ts ("pre-team migration").
		sql.exec("DROP INDEX IF EXISTS workspaces_team");
		for (const table of ["workspaces", "invites", "invite_pins"]) {
			sql.exec(`ALTER TABLE ${table} DROP COLUMN team_id`);
		}
		sql.exec("DROP TABLE teams");
		sql.exec("DROP TABLE team_members");
		migrate(sql);
		expect(sql.exec("SELECT COUNT(*) AS n FROM teams").toArray()).toEqual([{ n: 2 }]);
		expect(
			sql.exec("SELECT COUNT(*) AS n FROM workspaces WHERE team_id IS NOT NULL").toArray(),
		).toEqual([{ n: 2 }]);
		expect(sql.exec("SELECT COUNT(*) AS n FROM team_members").toArray()).toEqual([{ n: 3 }]);
	});
});
