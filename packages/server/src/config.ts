import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";

const envSchema = z.object({
	NODE_ENV: z.string().default("development"),
	TEAMSYNC_PORT: z.coerce.number().int().positive().default(8787),
	TEAMSYNC_PUBLIC_URL: z.string().default(""),
	TEAMSYNC_DB_URL: z.string().default(""),
	TEAMSYNC_DATA_DIR: z.string().default(".data"),
	TEAMSYNC_BLOB_BACKEND: z.enum(["fs", "s3"]).default("fs"),
	TEAMSYNC_SECRET: z.string().default(""),
	TEAMSYNC_DEV_OPEN_LOGIN: z.string().default(""),
	TEAMSYNC_ADMIN_BOOTSTRAP_TOKEN: z.string().default(""),
	TEAMSYNC_MAX_FILE_BYTES: z.coerce
		.number()
		.int()
		.positive()
		.default(200 * 1024 * 1024),
	BLOB_PRESIGN: z.string().default("0"),
	S3_ENDPOINT: z.string().default(""),
	S3_BUCKET: z.string().default(""),
	S3_REGION: z.string().default("us-east-1"),
	S3_ACCESS_KEY_ID: z.string().default(""),
	S3_SECRET_ACCESS_KEY: z.string().default(""),
	S3_FORCE_PATH_STYLE: z.string().default("1"),
	LOG_LEVEL: z.string().default("info"),
	LOG_FORMAT: z.enum(["json", "pretty"]).default("pretty"),
});

export interface S3Config {
	endpoint: string;
	bucket: string;
	region: string;
	accessKeyId: string;
	secretAccessKey: string;
	forcePathStyle: boolean;
}

export interface Config {
	env: string;
	isProduction: boolean;
	port: number;
	publicUrl: string;
	/** Postgres connection string; empty means PGlite. */
	dbUrl: string;
	/** PGlite data directory, or `memory://` for an ephemeral in-memory database. */
	pgliteDir: string;
	dataDir: string;
	blobBackend: "fs" | "s3";
	blobDir: string;
	s3: S3Config;
	secret: string;
	devOpenLogin: boolean;
	adminBootstrapToken: string;
	presign: boolean;
	maxFileBytes: number;
	logLevel: string;
	logFormat: "json" | "pretty";
	version: string;
}

export const SERVER_VERSION = "0.0.1";

function truthy(v: string): boolean {
	return v === "1" || v.toLowerCase() === "true" || v.toLowerCase() === "yes";
}

/**
 * Read (or create) the dev JWT/pepper secret at `<dataDir>/secret`.
 * Never used in production: there `TEAMSYNC_SECRET` is required.
 */
function loadOrCreateSecret(dataDir: string): string {
	const file = path.join(dataDir, "secret");
	if (existsSync(file)) {
		const existing = readFileSync(file, "utf8").trim();
		if (existing.length > 0) return existing;
	}
	const secret = randomBytes(32).toString("hex");
	mkdirSync(dataDir, { recursive: true });
	writeFileSync(file, `${secret}\n`, { mode: 0o600 });
	return secret;
}

export interface LoadConfigOverrides {
	/** Bypass the filesystem entirely (tests). */
	pgliteDir?: string;
	dataDir?: string;
	secret?: string;
	devOpenLogin?: boolean;
}

export function loadConfig(
	env: NodeJS.ProcessEnv = process.env,
	overrides: LoadConfigOverrides = {},
): Config {
	const parsed = envSchema.parse(env);
	const isProduction = parsed.NODE_ENV === "production";
	const dataDir = path.resolve(overrides.dataDir ?? parsed.TEAMSYNC_DATA_DIR);
	const dbUrl = parsed.TEAMSYNC_DB_URL.trim();

	let secret = overrides.secret ?? parsed.TEAMSYNC_SECRET.trim();
	if (!secret) {
		if (isProduction) {
			throw new Error(
				"TEAMSYNC_SECRET is required in production (it signs WebSocket JWTs and peppers session tokens)",
			);
		}
		secret = loadOrCreateSecret(dataDir);
	}

	// Dev-open-login defaults on only for a zero-config (PGlite) setup.
	const devOpenLoginRaw = parsed.TEAMSYNC_DEV_OPEN_LOGIN.trim();
	const devOpenLogin =
		overrides.devOpenLogin ?? (devOpenLoginRaw === "" ? dbUrl === "" : truthy(devOpenLoginRaw));

	const port = parsed.TEAMSYNC_PORT;

	return {
		env: parsed.NODE_ENV,
		isProduction,
		port,
		publicUrl: parsed.TEAMSYNC_PUBLIC_URL || `http://localhost:${port}`,
		dbUrl,
		pgliteDir: overrides.pgliteDir ?? path.join(dataDir, "pglite"),
		dataDir,
		blobBackend: parsed.TEAMSYNC_BLOB_BACKEND,
		blobDir: path.join(dataDir, "blobs"),
		s3: {
			endpoint: parsed.S3_ENDPOINT,
			bucket: parsed.S3_BUCKET,
			region: parsed.S3_REGION,
			accessKeyId: parsed.S3_ACCESS_KEY_ID,
			secretAccessKey: parsed.S3_SECRET_ACCESS_KEY,
			forcePathStyle: truthy(parsed.S3_FORCE_PATH_STYLE),
		},
		secret,
		devOpenLogin,
		adminBootstrapToken: parsed.TEAMSYNC_ADMIN_BOOTSTRAP_TOKEN,
		presign: truthy(parsed.BLOB_PRESIGN),
		maxFileBytes: parsed.TEAMSYNC_MAX_FILE_BYTES,
		logLevel: parsed.LOG_LEVEL,
		logFormat: parsed.LOG_FORMAT,
		version: SERVER_VERSION,
	};
}
