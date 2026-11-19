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
];

export function migratePinsAndPasswords(sql: SqlExec): void {
	for (const statement of PIN_AND_PASSWORD_TABLES) sql.exec(statement);
}
