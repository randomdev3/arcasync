import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
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
		{ env: undefined, name: "arcasync-relay", devLogin: "0", stats: "0", secret: false },
		{ env: "production", name: "arcasync-relay", devLogin: "0", stats: "0", secret: false },
		{ env: "probe", name: "arcasync-relay-probe", devLogin: "1", stats: "1", secret: false },
		{ env: "dev", name: "arcasync-relay-dev", devLogin: "1", stats: "1", secret: true },
	];

	for (const c of cases) {
		it(`resolves env ${c.env ?? "(top level)"}`, () => {
			const config = resolved(c.env);
			const vars = config.vars as Record<string, string>;
			expect(config.name).toBe(c.name);
			expect(vars.ARCASYNC_DEV_OPEN_LOGIN).toBe(c.devLogin);
			expect(vars.ARCASYNC_DEBUG_STATS).toBe(c.stats);
			expect(Number(vars.ARCASYNC_MAX_FILE_BYTES)).toBeGreaterThan(0);
			expect("ARCASYNC_SECRET" in vars).toBe(c.secret);
			expect(vars.ARCASYNC_ALLOW_DEV_SECRET === "1").toBe(c.env === "dev");
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

	it("binds R2 CHUNKS to arcasync-chunks everywhere except probe", () => {
		for (const env of [undefined, "production", "dev"]) {
			expect(resolved(env).r2_buckets).toEqual([
				{ binding: "CHUNKS", bucket_name: "arcasync-chunks" },
			]);
		}
		expect(resolved("probe").r2_buckets).toEqual([]);
	});

	it("never binds anything remotely", () => {
		expect(readFileSync(CONFIG, "utf8")).not.toMatch(/"remote"/);
	});

	it("sets ARCASYNC_BOOTSTRAP_TOKEN in dev only", () => {
		for (const env of [undefined, "production", "probe"]) {
			expect("ARCASYNC_BOOTSTRAP_TOKEN" in (resolved(env).vars as Record<string, string>)).toBe(
				false,
			);
		}
		expect((resolved("dev").vars as Record<string, string>).ARCASYNC_BOOTSTRAP_TOKEN).toMatch(
			/^arcasync-local-dev-bootstrap-token-not-secret/,
		);
	});

	it("turns observability on in production only", () => {
		expect(resolved("production").observability?.enabled).toBe(true);
		expect(resolved(undefined).observability?.enabled).toBe(false);
	});

	it("serves the site from static assets in every env, with only /api/* and /ws on the Worker", () => {
		const site = resolve(dirname(CONFIG), "..", "site", "dist");
		for (const env of [undefined, "production", "dev", "probe"]) {
			const assets = resolved(env).assets;
			expect(assets, `env ${env}`).toBeDefined();
			expect(resolve(dirname(CONFIG), assets?.directory ?? "")).toBe(site);
			expect(assets?.run_worker_first).toEqual(["/api/*", "/ws"]);
			// Unknown paths stay on the (free) asset layer instead of falling through to the Worker.
			expect(assets?.not_found_handling).toBe("404-page");
			expect(assets?.html_handling).toBe("auto-trailing-slash");
			expect(assets?.binding).toBeUndefined();
		}
	});

	it("sets ARCASYNC_PUBLIC_URL for dev only (elsewhere the request origin is used)", () => {
		for (const env of [undefined, "production", "probe"]) {
			expect("ARCASYNC_PUBLIC_URL" in (resolved(env).vars as Record<string, string>)).toBe(false);
		}
		expect((resolved("dev").vars as Record<string, string>).ARCASYNC_PUBLIC_URL).toBe(
			"http://localhost:8789",
		);
	});

	it("serves wrangler dev on 8789", () => {
		expect(resolved("dev").dev.port).toBe(8789);
	});

	it("ships the secret that DEV_SECRET names", () => {
		expect((resolved("dev").vars as Record<string, string>).ARCASYNC_SECRET).toBe(DEV_SECRET);
	});
});

describe("configError", () => {
	const strong = "x".repeat(48);

	it("accepts a strong secret", () => {
		expect(configError({ ARCASYNC_SECRET: strong })).toBeNull();
	});

	it("rejects a missing or empty secret, even in dev", () => {
		expect(configError({})).toMatch(/not set/);
		expect(configError({ ARCASYNC_SECRET: "" })).toMatch(/not set/);
		expect(configError({ ARCASYNC_ALLOW_DEV_SECRET: "1" })).toMatch(/not set/);
	});

	it("rejects a short secret unless dev secrets are allowed", () => {
		expect(configError({ ARCASYNC_SECRET: "x".repeat(31) })).toMatch(/shorter than 32/);
		expect(configError({ ARCASYNC_SECRET: "x".repeat(32) })).toBeNull();
		expect(configError({ ARCASYNC_SECRET: "short", ARCASYNC_ALLOW_DEV_SECRET: "1" })).toBeNull();
	});

	it("rejects the public dev secret unless dev secrets are allowed", () => {
		expect(configError({ ARCASYNC_SECRET: DEV_SECRET })).toMatch(/dev secret/);
		expect(configError({ ARCASYNC_SECRET: DEV_SECRET, ARCASYNC_ALLOW_DEV_SECRET: "0" })).toMatch(
			/dev secret/,
		);
		expect(configError({ ARCASYNC_SECRET: DEV_SECRET, ARCASYNC_ALLOW_DEV_SECRET: "1" })).toBeNull();
	});
});
