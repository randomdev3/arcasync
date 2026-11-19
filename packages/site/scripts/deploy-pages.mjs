// `pnpm -F @arcasync/site deploy:site`: uploads the built `dist/` to Cloudflare Pages project
// ARCASYNC_SITE_PROJECT (default `arca-sync`, served at https://arca-sync.pages.dev). The site must
// be built with VITE_ARCASYNC_API_URL set to the production relay. Run by the user only.
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dist = join(root, "dist");
const project = process.env.ARCASYNC_SITE_PROJECT?.trim() || "arca-sync";
if (!existsSync(join(dist, "index.html")) || !existsSync(join(dist, "_headers"))) {
	console.error("No build in dist/. Run: VITE_ARCASYNC_API_URL=https://<relay> pnpm build");
	process.exit(1);
}
if (/connect-src 'self' http:\/\/localhost/.test(readFileSync(join(dist, "_headers"), "utf8"))) {
	console.error("dist/ was built against a local relay. Rebuild with VITE_ARCASYNC_API_URL set.");
	process.exit(1);
}
const result = spawnSync(
	"wrangler",
	["pages", "deploy", dist, "--project-name", project, "--branch", "main"],
	{ cwd: root, stdio: "inherit", shell: process.platform === "win32" },
);
process.exit(result.status ?? 1);
