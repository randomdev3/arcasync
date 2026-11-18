import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { unstable_readConfig } from "wrangler";
import { configError, DEV_SECRET } from "../src/config";

const CONFIG = join(dirname(fileURLToPath(import.meta.url)), "..", "wrangler.jsonc");

function resolved(env: string | undefined) {
	return unstable_readConfig({ config: CONFIG, env }, { hideWarnings: true });
}

describe("wrangler.jsonc", () => {
	const cases = [
		{ env: undefined, name: "teamsync-relay", devLogin: "0", stats: "0", secret: false },
		{ env: "production", name: "teamsync-relay", devLogin: "0", stats: "0", secret: false },
		{ env: "probe", name: "teamsync-relay-probe", devLogin: "1", stats: "1", secret: false },
		{ env: "dev", name: "teamsync-relay-dev", devLogin: "1", stats: "1", secret: true },
	];

	for (const c of cases) {
		it(`resolves env ${c.env ?? "(top level)"}`, () => {
			const config = resolved(c.env);
			const vars = config.vars as Record<string, string>;
			expect(config.name).toBe(c.name);
			expect(vars.TEAMSYNC_DEV_OPEN_LOGIN).toBe(c.devLogin);
			expect(vars.TEAMSYNC_DEBUG_STATS).toBe(c.stats);
			expect(Number(vars.TEAMSYNC_MAX_FILE_BYTES)).toBeGreaterThan(0);
			expect("TEAMSYNC_SECRET" in vars).toBe(c.secret);
			expect(vars.TEAMSYNC_ALLOW_DEV_SECRET === "1").toBe(c.env === "dev");
			expect(
				config.durable_objects.bindings
					.map((b: { name: string; class_name: string }) => [b.name, b.class_name])
					.sort(),
			).toEqual([
				["ACCOUNTS", "AccountsDO"],
				["RELAY", "WorkspaceRelay"],
			]);
			// `--dry-run` does not catch a missing migration, so check it resolves in every env.
			expect(config.migrations).toEqual([
				{ tag: "v1", new_sqlite_classes: ["AccountsDO", "WorkspaceRelay"] },
			]);
		});
	}

	it("turns observability on in production only", () => {
		expect(resolved("production").observability?.enabled).toBe(true);
		expect(resolved(undefined).observability?.enabled).toBe(false);
	});

	it("serves wrangler dev on 8789", () => {
		expect(resolved("dev").dev.port).toBe(8789);
	});

	it("ships the secret that DEV_SECRET names", () => {
		expect((resolved("dev").vars as Record<string, string>).TEAMSYNC_SECRET).toBe(DEV_SECRET);
	});
});

describe("configError", () => {
	const strong = "x".repeat(48);

	it("accepts a strong secret", () => {
		expect(configError({ TEAMSYNC_SECRET: strong })).toBeNull();
	});

	it("rejects a missing or empty secret, even in dev", () => {
		expect(configError({})).toMatch(/not set/);
		expect(configError({ TEAMSYNC_SECRET: "" })).toMatch(/not set/);
		expect(configError({ TEAMSYNC_ALLOW_DEV_SECRET: "1" })).toMatch(/not set/);
	});

	it("rejects a short secret unless dev secrets are allowed", () => {
		expect(configError({ TEAMSYNC_SECRET: "x".repeat(31) })).toMatch(/shorter than 32/);
		expect(configError({ TEAMSYNC_SECRET: "x".repeat(32) })).toBeNull();
		expect(configError({ TEAMSYNC_SECRET: "short", TEAMSYNC_ALLOW_DEV_SECRET: "1" })).toBeNull();
	});

	it("rejects the public dev secret unless dev secrets are allowed", () => {
		expect(configError({ TEAMSYNC_SECRET: DEV_SECRET })).toMatch(/dev secret/);
		expect(configError({ TEAMSYNC_SECRET: DEV_SECRET, TEAMSYNC_ALLOW_DEV_SECRET: "0" })).toMatch(
			/dev secret/,
		);
		expect(configError({ TEAMSYNC_SECRET: DEV_SECRET, TEAMSYNC_ALLOW_DEV_SECRET: "1" })).toBeNull();
	});
});
