import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { defineConfig, loadEnv, type Plugin } from "vite";
import { GITHUB_REPO, REPO_IS_PLACEHOLDER, REPO_URL } from "./src/lib/config";

const here = (path: string) => fileURLToPath(new URL(path, import.meta.url));

/** Every page, built to a flat `<name>.html`: Pages serves it at `/join` (and 404.html for misses). */
const PAGES = ["index", "join", "signin", "approve", "guide", "account", "404"] as const;
const CLEAN = new Set<string>(PAGES.filter((p) => p !== "index" && p !== "404"));

/** `wrangler dev --env dev` (packages/relay-cf): the relay a build talks to unless told otherwise. */
const DEV_RELAY = "http://localhost:8789";

/**
 * The relay's base URL, fixed at build time from `VITE_ARCASYNC_API_URL` (env or `.env*`). The site
 * (Cloudflare Pages) calls it cross-origin; the relay's `ARCASYNC_SITE_ORIGINS` must list the site.
 */
function relayUrl(mode: string): string {
	const raw = loadEnv(mode, here("."), "VITE_").VITE_ARCASYNC_API_URL?.trim() || DEV_RELAY;
	const url = new URL(raw);
	if (url.protocol !== "https:" && url.protocol !== "http:") {
		throw new Error(`VITE_ARCASYNC_API_URL must be an http(s) URL, got ${raw}`);
	}
	if (url.search || url.hash || url.username) {
		throw new Error(`VITE_ARCASYNC_API_URL must be a plain base URL, got ${raw}`);
	}
	return `${url.origin}${url.pathname.replace(/\/+$/, "")}`;
}

/** Security headers for Cloudflare Pages (`dist/_headers`); `connect-src` names the relay. */
function headersFile(relay: string): string {
	const csp = [
		"default-src 'none'",
		"script-src 'self'",
		"style-src 'self'",
		"img-src 'self' data: blob:",
		"font-src 'self'",
		`connect-src 'self' ${new URL(relay).origin}`,
		"manifest-src 'self'",
		"base-uri 'none'",
		"form-action 'self'",
		"frame-ancestors 'none'",
	].join("; ");
	return [
		"/*",
		`  Content-Security-Policy: ${csp}`,
		"  Referrer-Policy: no-referrer",
		"  X-Content-Type-Options: nosniff",
		"  Permissions-Policy: camera=(), microphone=(), geolocation=(), payment=(), usb=()",
		"  Cross-Origin-Opener-Policy: same-origin",
		"/assets/*",
		"  Cache-Control: public, max-age=31536000, immutable",
		"",
	].join("\n");
}

function pagesHeaders(relay: string): Plugin {
	return {
		name: "arcasync-pages-headers",
		apply: "build",
		generateBundle() {
			this.emitFile({ type: "asset", fileName: "_headers", source: headersFile(relay) });
		},
	};
}

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

const escapeHtml = (text: string) => text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/**
 * Shared markup: `<!--@name-->` is replaced with `src/partials/name.html` (header, footer, the
 * thread motif), so the pages keep one copy; then the repo and relay tokens.
 */
function partials(relay: string): Plugin {
	return {
		name: "arcasync-partials",
		transformIndexHtml: {
			order: "pre",
			handler: (html) => {
				let out = html;
				for (const [token, markup] of Object.entries(REPO_MARKUP))
					out = out.replaceAll(token, markup);
				out = out.replace(/<!--@([a-z-]+)-->/g, (_, name: string) =>
					readFileSync(here(`./src/partials/${name}.html`), "utf8").trim(),
				);
				for (const [token, markup] of Object.entries(REPO_MARKUP))
					out = out.replaceAll(token, markup);
				return out.replaceAll("{{relay}}", escapeHtml(relay));
			},
		},
	};
}

/** Dev only: `/join?x` → `/join.html?x`, the way Cloudflare Pages serves the build. */
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

export default defineConfig(({ mode }) => {
	const relay = relayUrl(mode);
	return {
		plugins: [partials(relay), cleanUrls(), pagesHeaders(relay)],
		define: { __ARCASYNC_API_URL__: JSON.stringify(relay) },
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
		// `vite dev` and `wrangler pages dev` origins are in env.dev's ARCASYNC_SITE_ORIGINS.
		server: { port: 5173, strictPort: true },
		preview: { port: 4173, strictPort: true },
	};
});
