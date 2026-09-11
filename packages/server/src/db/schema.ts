import { sql } from "drizzle-orm";
import {
	bigint,
	bigserial,
	boolean,
	customType,
	index,
	integer,
	jsonb,
	pgTable,
	primaryKey,
	text,
	timestamp,
	uniqueIndex,
	uuid,
} from "drizzle-orm/pg-core";

/** Postgres `bytea` <-> `Uint8Array`. */
export const bytea = customType<{ data: Uint8Array; driverData: Buffer }>({
	dataType() {
		return "bytea";
	},
	toDriver(value) {
		return Buffer.from(value);
	},
	fromDriver(value) {
		return new Uint8Array(value);
	},
});

const ts = (name: string) => timestamp(name, { withTimezone: true, mode: "date" });
const seq = (name: string) => bigint(name, { mode: "number" });

export const users = pgTable("users", {
	id: uuid("id").primaryKey().defaultRandom(),
	email: text("email").unique(),
	name: text("name").notNull(),
	color: text("color").notNull(),
	avatarUrl: text("avatar_url"),
	isAdmin: boolean("is_admin").notNull().default(false),
	createdAt: ts("created_at").notNull().defaultNow(),
	disabledAt: ts("disabled_at"),
});

export const devices = pgTable(
	"devices",
	{
		id: uuid("id").primaryKey().defaultRandom(),
		userId: uuid("user_id")
			.notNull()
			.references(() => users.id, { onDelete: "cascade" }),
		name: text("name").notNull(),
		platform: text("platform").notNull(),
		vaultId: text("vault_id").notNull(),
		createdAt: ts("created_at").notNull().defaultNow(),
		lastSeenAt: ts("last_seen_at").notNull().defaultNow(),
	},
	(t) => [index("devices_user_idx").on(t.userId)],
);

export const sessions = pgTable(
	"sessions",
	{
		id: uuid("id").primaryKey().defaultRandom(),
		userId: uuid("user_id")
			.notNull()
			.references(() => users.id, { onDelete: "cascade" }),
		deviceId: uuid("device_id")
			.notNull()
			.references(() => devices.id, { onDelete: "cascade" }),
		tokenHash: text("token_hash").notNull().unique(),
		createdAt: ts("created_at").notNull().defaultNow(),
		lastSeenAt: ts("last_seen_at").notNull().defaultNow(),
		expiresAt: ts("expires_at").notNull(),
		revokedAt: ts("revoked_at"),
	},
	(t) => [index("sessions_user_idx").on(t.userId)],
);

export const workspaces = pgTable("workspaces", {
	id: uuid("id").primaryKey().defaultRandom(),
	slug: text("slug").notNull().unique(),
	name: text("name").notNull(),
	createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
	createdAt: ts("created_at").notNull().defaultNow(),
	deletedAt: ts("deleted_at"),
	settings: jsonb("settings").notNull().default({}),
});

export const invites = pgTable(
	"invites",
	{
		id: uuid("id").primaryKey().defaultRandom(),
		workspaceId: uuid("workspace_id").references(() => workspaces.id, { onDelete: "cascade" }),
		role: text("role").notNull(),
		email: text("email"),
		tokenHash: text("token_hash").notNull().unique(),
		createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
		createdAt: ts("created_at").notNull().defaultNow(),
		expiresAt: ts("expires_at").notNull(),
		maxUses: integer("max_uses").notNull().default(1),
		uses: integer("uses").notNull().default(0),
		revokedAt: ts("revoked_at"),
	},
	(t) => [index("invites_workspace_idx").on(t.workspaceId)],
);

export const deviceCodes = pgTable("device_codes", {
	id: uuid("id").primaryKey().defaultRandom(),
	deviceCodeHash: text("device_code_hash").notNull().unique(),
	userCode: text("user_code").notNull().unique(),
	status: text("status").notNull().default("pending"),
	deviceName: text("device_name").notNull(),
	platform: text("platform").notNull(),
	vaultId: text("vault_id").notNull(),
	userId: uuid("user_id").references(() => users.id, { onDelete: "cascade" }),
	sessionId: uuid("session_id").references(() => sessions.id, { onDelete: "set null" }),
	createdAt: ts("created_at").notNull().defaultNow(),
	expiresAt: ts("expires_at").notNull(),
	approvedAt: ts("approved_at"),
	lastPolledAt: ts("last_polled_at"),
});

export const memberships = pgTable(
	"memberships",
	{
		workspaceId: uuid("workspace_id")
			.notNull()
			.references(() => workspaces.id, { onDelete: "cascade" }),
		userId: uuid("user_id")
			.notNull()
			.references(() => users.id, { onDelete: "cascade" }),
		role: text("role").notNull(),
		addedBy: uuid("added_by").references(() => users.id, { onDelete: "set null" }),
		createdAt: ts("created_at").notNull().defaultNow(),
	},
	(t) => [
		primaryKey({ columns: [t.workspaceId, t.userId] }),
		index("memberships_user_idx").on(t.userId),
	],
);

export const files = pgTable(
	"files",
	{
		id: uuid("id").primaryKey(),
		workspaceId: uuid("workspace_id")
			.notNull()
			.references(() => workspaces.id, { onDelete: "cascade" }),
		path: text("path").notNull(),
		kind: text("kind").notNull(),
		docId: text("doc_id"),
		hash: text("hash"),
		size: seq("size"),
		mtime: seq("mtime"),
		chunks: text("chunks").array(),
		mime: text("mime"),
		version: seq("version").notNull().default(1),
		updatedBy: uuid("updated_by").references(() => users.id, { onDelete: "set null" }),
		updatedAt: ts("updated_at").notNull().defaultNow(),
		deletedAt: ts("deleted_at"),
	},
	(t) => [
		uniqueIndex("files_workspace_path_uq")
			.on(t.workspaceId, t.path)
			.where(sql`${t.deletedAt} is null`),
		index("files_workspace_idx").on(t.workspaceId),
	],
);

export const docs = pgTable(
	"docs",
	{
		id: text("id").primaryKey(),
		workspaceId: uuid("workspace_id")
			.notNull()
			.references(() => workspaces.id, { onDelete: "cascade" }),
		kind: text("kind").notNull(),
		fileId: uuid("file_id").references(() => files.id, { onDelete: "set null" }),
		lastSeq: seq("last_seq").notNull().default(0),
		createdAt: ts("created_at").notNull().defaultNow(),
		deletedAt: ts("deleted_at"),
	},
	(t) => [index("docs_workspace_idx").on(t.workspaceId)],
);

export const docUpdates = pgTable(
	"doc_updates",
	{
		docId: text("doc_id")
			.notNull()
			.references(() => docs.id, { onDelete: "cascade" }),
		seq: seq("seq").notNull(),
		updateV2: bytea("update_v2").notNull(),
		clientId: seq("client_id").notNull(),
		userId: uuid("user_id").references(() => users.id, { onDelete: "set null" }),
		receivedAt: ts("received_at").notNull().defaultNow(),
	},
	(t) => [primaryKey({ columns: [t.docId, t.seq] })],
);

export const docClients = pgTable(
	"doc_clients",
	{
		docId: text("doc_id")
			.notNull()
			.references(() => docs.id, { onDelete: "cascade" }),
		clientId: seq("client_id").notNull(),
		userId: uuid("user_id").references(() => users.id, { onDelete: "set null" }),
		firstSeen: ts("first_seen").notNull().defaultNow(),
	},
	(t) => [primaryKey({ columns: [t.docId, t.clientId] })],
);

export const docCheckpoints = pgTable(
	"doc_checkpoints",
	{
		docId: text("doc_id")
			.notNull()
			.references(() => docs.id, { onDelete: "cascade" }),
		uptoSeq: seq("upto_seq").notNull(),
		gcState: bytea("gc_state").notNull(),
		fullState: bytea("full_state"),
		stateVector: bytea("state_vector").notNull(),
		createdAt: ts("created_at").notNull().defaultNow(),
	},
	(t) => [primaryKey({ columns: [t.docId, t.uptoSeq] })],
);

export const docVersions = pgTable(
	"doc_versions",
	{
		id: uuid("id").primaryKey().defaultRandom(),
		docId: text("doc_id")
			.notNull()
			.references(() => docs.id, { onDelete: "cascade" }),
		name: text("name"),
		trigger: text("trigger").notNull(),
		createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
		atSeq: seq("at_seq").notNull(),
		snapshotV2: bytea("snapshot_v2").notNull(),
		fullState: bytea("full_state"),
		textHash: text("text_hash"),
		contributors: uuid("contributors").array().notNull().default(sql`'{}'::uuid[]`),
		createdAt: ts("created_at").notNull().defaultNow(),
	},
	(t) => [index("doc_versions_doc_created_idx").on(t.docId, t.createdAt.desc())],
);

export const fileVersions = pgTable(
	"file_versions",
	{
		id: uuid("id").primaryKey().defaultRandom(),
		fileId: uuid("file_id")
			.notNull()
			.references(() => files.id, { onDelete: "cascade" }),
		hash: text("hash").notNull(),
		size: seq("size").notNull(),
		chunks: text("chunks").array().notNull(),
		mtime: seq("mtime").notNull(),
		createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
		createdAt: ts("created_at").notNull().defaultNow(),
		reason: text("reason").notNull(),
	},
	(t) => [index("file_versions_file_idx").on(t.fileId, t.createdAt.desc())],
);

export const chunks = pgTable("chunks", {
	sha256: text("sha256").primaryKey(),
	size: integer("size").notNull(),
	createdAt: ts("created_at").notNull().defaultNow(),
	lastReferencedAt: ts("last_referenced_at").notNull().defaultNow(),
});

export const auditLog = pgTable(
	"audit_log",
	{
		id: bigserial("id", { mode: "number" }).primaryKey(),
		at: ts("at").notNull().defaultNow(),
		actorUserId: uuid("actor_user_id").references(() => users.id, { onDelete: "set null" }),
		workspaceId: uuid("workspace_id").references(() => workspaces.id, { onDelete: "set null" }),
		action: text("action").notNull(),
		targetType: text("target_type"),
		targetId: text("target_id"),
		details: jsonb("details"),
		ip: text("ip"),
		userAgent: text("user_agent"),
	},
	(t) => [index("audit_log_at_idx").on(t.at.desc())],
);

export const serverSettings = pgTable("server_settings", {
	key: text("key").primaryKey(),
	value: jsonb("value").notNull(),
});

export type UserRow = typeof users.$inferSelect;
export type DeviceRow = typeof devices.$inferSelect;
export type SessionRow = typeof sessions.$inferSelect;
export type WorkspaceRow = typeof workspaces.$inferSelect;
export type DocRow = typeof docs.$inferSelect;
