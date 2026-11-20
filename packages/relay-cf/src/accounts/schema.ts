/**
 * Tables added after AccountsDO shipped (PIN invites and passwords). Purely additive: new tables
 * and indexes only, each `IF NOT EXISTS`, so it is safe to run on every wake of a live object.
 * One statement per `exec`, so `node:sqlite` (unit tests) runs it too.
 */
export interface SqlExec {
	exec(query: string, ...bindings: unknown[]): unknown;
}

export const PIN_AND_PASSWORD_TABLES = [
	// One row per user who has set a password; `rounds × iterations` PBKDF2 (accounts/passwords.ts).
	`CREATE TABLE IF NOT EXISTS user_passwords (
		user_id TEXT PRIMARY KEY, hash TEXT NOT NULL, salt TEXT NOT NULL,
		iterations INTEGER NOT NULL, rounds INTEGER NOT NULL, updated_at INTEGER NOT NULL)`,
	// PIN invites: single-use, kept in plaintext (4 digits gain nothing from hashing) so creators
	// can list them; pruned a week after they stop being usable.
	`CREATE TABLE IF NOT EXISTS invite_pins (
		id TEXT PRIMARY KEY, pin TEXT NOT NULL, workspace_id TEXT NOT NULL, role TEXT NOT NULL,
		admin INTEGER NOT NULL DEFAULT 0, expires_at INTEGER NOT NULL, created_by TEXT NOT NULL,
		created_at INTEGER NOT NULL, used_at INTEGER, used_by TEXT, revoked_at INTEGER)`,
	"CREATE INDEX IF NOT EXISTS invite_pins_pin ON invite_pins (pin)",
	// Wrong PINs: `ip` is a peppered hash of the client IP. Pruned past 24 h.
	`CREATE TABLE IF NOT EXISTS pin_failures (
		id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, ip TEXT NOT NULL)`,
	// Failed (or in-flight) sign-ins by name key and IP hash. Pruned past 15 min, capped.
	`CREATE TABLE IF NOT EXISTS login_failures (
		id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, name_key TEXT NOT NULL,
		ip TEXT NOT NULL)`,
	"CREATE INDEX IF NOT EXISTS login_failures_at ON login_failures (at)",
	// Admin-issued, single-use password reset PINs, bound to one user (forgot password).
	`CREATE TABLE IF NOT EXISTS password_resets (
		id TEXT PRIMARY KEY, pin TEXT NOT NULL, user_id TEXT NOT NULL, expires_at INTEGER NOT NULL,
		created_by TEXT NOT NULL, created_at INTEGER NOT NULL, used_at INTEGER, revoked_at INTEGER)`,
];

export function migratePinsAndPasswords(sql: SqlExec): void {
	for (const statement of PIN_AND_PASSWORD_TABLES) sql.exec(statement);
}

/** What `migrateTeams` needs: statements plus `SELECT … toArray()` (DO `SqlStorage` or node:sqlite). */
export interface SqlQuery {
	exec(query: string, ...bindings: unknown[]): { toArray(): Record<string, unknown>[] };
}

/** Teams, OAuth identities and the OAuth state/handoff rows; additive, `IF NOT EXISTS`. */
export const TEAM_TABLES = [
	// A team owns shared folders (workspaces with `team_id`); its members' roles fan out to them.
	`CREATE TABLE IF NOT EXISTS teams (
		id TEXT PRIMARY KEY, slug TEXT NOT NULL UNIQUE, name TEXT NOT NULL, created_by TEXT,
		created_at INTEGER NOT NULL, deleted_at INTEGER)`,
	`CREATE TABLE IF NOT EXISTS team_members (
		team_id TEXT NOT NULL, user_id TEXT NOT NULL, role TEXT NOT NULL,
		PRIMARY KEY (team_id, user_id))`,
	"CREATE INDEX IF NOT EXISTS team_members_user ON team_members (user_id)",
	// Google / GitHub accounts; never linked by email, at most one per provider per user.
	`CREATE TABLE IF NOT EXISTS identities (
		provider TEXT NOT NULL, subject TEXT NOT NULL, user_id TEXT NOT NULL, email TEXT,
		linked_at INTEGER NOT NULL, PRIMARY KEY (provider, subject), UNIQUE (user_id, provider))`,
	// One row per started OAuth flow (keyed by the state's hash), deleted when the callback uses it.
	`CREATE TABLE IF NOT EXISTS oauth_states (
		id TEXT PRIMARY KEY, provider TEXT NOT NULL, intent TEXT NOT NULL, user_id TEXT, next TEXT,
		verifier_hash TEXT NOT NULL, code_verifier TEXT NOT NULL, expires_at INTEGER NOT NULL)`,
	// One-time codes the website exchanges for a session (keyed by hash), deleted on first use.
	`CREATE TABLE IF NOT EXISTS oauth_handoffs (
		id TEXT PRIMARY KEY, user_id TEXT NOT NULL, verifier_hash TEXT NOT NULL,
		created INTEGER NOT NULL, expires_at INTEGER NOT NULL)`,
];

const TEAM_COLUMNS = [
	["workspaces", "team_id"],
	["invites", "team_id"],
	["invite_pins", "team_id"],
] as const;

/** `base`, else `base-2`, `base-3`… (≤ 40 characters) that no row of `table` has as `slug`. */
export function uniqueSlug(sql: SqlQuery, table: "teams" | "workspaces", base: string): string {
	const taken = (slug: string) =>
		sql.exec(`SELECT 1 FROM ${table} WHERE slug = ?`, slug).toArray().length > 0;
	let slug = base;
	for (let n = 2; taken(slug); n++) slug = `${base.slice(0, 40 - `-${n}`.length)}-${n}`;
	return slug;
}

/**
 * Gives every live workspace without a team its own team (same name, slug from the
 * workspace's), with the workspace's members copied in their roles, and points outstanding
 * invites and PINs at that team. Rows already migrated are left alone, so it is idempotent.
 */
export function backfillTeams(sql: SqlQuery, now = Date.now()): void {
	const orphans = sql
		.exec(
			"SELECT id, slug, name FROM workspaces WHERE team_id IS NULL AND deleted_at IS NULL ORDER BY rowid",
		)
		.toArray() as { id: string; slug: string; name: string }[];
	for (const w of orphans) {
		const teamId = crypto.randomUUID();
		const owner = sql
			.exec(
				"SELECT user_id FROM memberships WHERE workspace_id = ? AND role = 'owner' ORDER BY rowid LIMIT 1",
				w.id,
			)
			.toArray()[0] as { user_id: string } | undefined;
		sql.exec(
			"INSERT INTO teams (id, slug, name, created_by, created_at) VALUES (?, ?, ?, ?, ?)",
			teamId,
			uniqueSlug(sql, "teams", w.slug),
			w.name,
			owner?.user_id ?? null,
			now,
		);
		sql.exec("UPDATE workspaces SET team_id = ? WHERE id = ?", teamId, w.id);
		sql.exec(
			`INSERT INTO team_members (team_id, user_id, role)
			 SELECT ?, user_id, role FROM memberships WHERE workspace_id = ?`,
			teamId,
			w.id,
		);
	}
	for (const table of ["invites", "invite_pins"]) {
		sql.exec(
			`UPDATE ${table} SET team_id =
			 (SELECT w.team_id FROM workspaces w WHERE w.id = ${table}.workspace_id)
			 WHERE team_id IS NULL AND workspace_id != ''`,
		);
	}
}

/**
 * Teams and OAuth tables plus the `team_id` columns. Runs after `migratePinsAndPasswords` on
 * every wake; `backfillTeams` follows, in a transaction of its own.
 */
export function migrateTeams(sql: SqlQuery): void {
	for (const statement of TEAM_TABLES) sql.exec(statement);
	for (const [table, column] of TEAM_COLUMNS) {
		try {
			sql.exec(`ALTER TABLE ${table} ADD COLUMN ${column} TEXT`);
		} catch (err) {
			if (!String(err).includes("duplicate column")) throw err;
		}
	}
	sql.exec("CREATE INDEX IF NOT EXISTS workspaces_team ON workspaces (team_id)");
}
