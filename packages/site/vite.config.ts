import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { defineConfig, type Plugin } from "vite";
import { GITHUB_REPO, REPO_IS_PLACEHOLDER, REPO_URL } from "./src/lib/config";

const here = (path: string) => fileURLToPath(new URL(path, import.meta.url));

/** Every page, built to a flat `<name>.html` so `/join` answers 200 (no 307 to `/join/`). */
const PAGES = ["index", "join", "signin", "approve", "guide", "account", "404"] as const;
const CLEAN = new Set<string>(PAGES.filter((p) => p !== "index" && p !== "404"));

/** The relay that `vite dev` proxies `/api` and `/ws` to (`wrangler dev --env dev`). */
const RELAY = process.env.ARCASYNC_SITE_RELAY ?? "http://localhost:8789";

const SOON = '<span class="badge badge--soon">link coming soon</span>';

/** Build-time markup for the repo links; a placeholder repo renders as text plus a badge. */
const REPO_MARKUP: Record<string, string> = {
	"<!--@repo-link-->": REPO_IS_PLACEHOLDER
		? `<span class="muted">Source ${SOON}</span>`
		: `<a href="${REPO_URL}">Source</a>`,
	"<!--@repo-releases-->": REPO_IS_PLACEHOLDER
		? `<code>github.com/${GITHUB_REPO}/releases</code> ${SOON}`
		: `<a href="${REPO_URL}/releases">github.com/${GITHUB_REPO}/releases</a>`,
	"<!--@repo-soon-->": REPO_IS_PLACEHOLDER ? SOON : "",
	"{{repo}}": GITHUB_REPO,
};

/**
 * Shared markup: `<!--@header-->` and `<!--@footer-->` in a page are replaced with
 * `src/partials/*.html`, so the seven pages keep one copy of the chrome; then the repo tokens.
 */
function partials(): Plugin {
	const read = (name: string) => readFileSync(here(`./src/partials/${name}.html`), "utf8").trim();
	return {
		name: "arcasync-partials",
		transformIndexHtml: {
			order: "pre",
			handler: (html) => {
				let out = html
					.replace("<!--@header-->", read("header"))
					.replace("<!--@footer-->", read("footer"));
				for (const [token, markup] of Object.entries(REPO_MARKUP))
					out = out.replaceAll(token, markup);
				return out;
			},
		},
	};
}

/** Dev only: `/join?x` → `/join.html?x`, the way Workers static assets serve the build. */
function cleanUrls(): Plugin {
	return {
		name: "arcasync-clean-urls",
		configureServer(server) {
			server.middlewares.use((req, _res, next) => {
				const [path = "", query] = (req.url ?? "").split("?", 2);
				const name = path.replace(/^\/+|\/+$/g, "");
				if (CLEAN.has(name)) req.url = `/${name}.html${query === undefined ? "" : `?${query}`}`;
				next();
			});
		},
	};
}

export default defineConfig({
	plugins: [partials(), cleanUrls()],
	build: {
		outDir: "dist",
		emptyOutDir: true,
		// No `data:` URLs (fonts stay files) and no injected inline code: the CSP is `'self'` only.
		assetsInlineLimit: 0,
		modulePreload: { polyfill: false },
		rollupOptions: {
			input: Object.fromEntries(PAGES.map((p) => [p, here(`./${p}.html`)])),
		},
	},
	server: {
		proxy: {
			"/api": RELAY,
			"/ws": { target: RELAY.replace(/^http/, "ws"), ws: true },
		},
	},
});
