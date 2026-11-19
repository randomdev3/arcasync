import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { PNG } from "pngjs";
import { defineConfig, loadEnv, type Plugin } from "vite";
import { GITHUB_REPO, REPO_IS_PLACEHOLDER, REPO_URL } from "./src/lib/config";
import { MARK, MARK_SMALL, PICTOS, wordRows } from "./src/matrix/glyphs";
import { dotsSvg, sceneSvg } from "./src/matrix/svg";

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

const INK = "#f0f0ec";
const SIGNAL = "#ff3b2f";
const WORDMARK = wordRows("ARCASYNC", MARK);

/** The favicon: the 5×5 mark as 2px squares on a 3px pitch, so it is sharp at 16px. */
function faviconSvg(): string {
	const squares = { "#": "", R: "" };
	MARK_SMALL.forEach((row, y) => {
		[...row].forEach((ch, x) => {
			if (ch === "#" || ch === "R") squares[ch] += `M${1 + x * 3} ${1 + y * 3}h2v2h-2z`;
		});
	});
	return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><title>ArcaSync</title><rect width="16" height="16" fill="#000"/><path fill="${INK}" d="${squares["#"]}"/><path fill="${SIGNAL}" d="${squares.R}"/></svg>`;
}

/**
 * The favicon as a PNG, for browsers and iOS home screens that don't take the SVG: the same 5×5
 * mark on the same 16-unit grid, scaled into `size` pixels less `pad` on each side, with square
 * edges snapped to whole pixels.
 */
function faviconPng(size: number, pad = 0): Buffer {
	const png = new PNG({ width: size, height: size });
	const hex = (c: string) => [1, 3, 5].map((i) => Number.parseInt(c.slice(i, i + 2), 16));
	const fill = (x0: number, y0: number, x1: number, y1: number, [r, g, b]: number[]) => {
		for (let y = y0; y < y1; y++) {
			for (let x = x0; x < x1; x++) {
				const i = (y * size + x) * 4;
				png.data[i] = r ?? 0;
				png.data[i + 1] = g ?? 0;
				png.data[i + 2] = b ?? 0;
				png.data[i + 3] = 255;
			}
		}
	};
	fill(0, 0, size, size, [0, 0, 0]);
	const px = (unit: number) => pad + Math.round((unit * (size - 2 * pad)) / 16);
	MARK_SMALL.forEach((row, y) => {
		[...row].forEach((ch, x) => {
			if (ch !== "#" && ch !== "R") return;
			const color = hex(ch === "R" ? SIGNAL : INK);
			fill(px(1 + x * 3), px(1 + y * 3), px(3 + x * 3), px(3 + y * 3), color);
		});
	});
	return PNG.sync.write(png);
}

/** Brand files served from the root, drawn from the same glyphs as the page. */
const BRAND_FILES: Record<string, () => string | Buffer> = {
	"favicon.svg": faviconSvg,
	"favicon-32.png": () => faviconPng(32),
	// iOS rounds the corners of home-screen icons, so the mark keeps a margin there.
	"apple-touch-icon.png": () => faviconPng(180, 30),
	"logo.svg": () => dotsSvg(WORDMARK, { colors: { on: INK, red: SIGNAL }, title: "ArcaSync" }),
	"mark.svg": () => dotsSvg(MARK, { colors: { on: INK, red: SIGNAL }, title: "ArcaSync" }),
};

function brandFiles(): Plugin {
	return {
		name: "arcasync-brand-files",
		configureServer(server) {
			server.middlewares.use((req, res, next) => {
				const name = (req.url ?? "").split("?")[0]?.slice(1) ?? "";
				const make = BRAND_FILES[name];
				if (!make) return next();
				res.setHeader("Content-Type", name.endsWith(".png") ? "image/png" : "image/svg+xml");
				res.end(make());
			});
		},
		generateBundle() {
			for (const [fileName, make] of Object.entries(BRAND_FILES)) {
				this.emitFile({ type: "asset", fileName, source: make() });
			}
		},
	};
}

/** Markup drawn at build time: the logo, the pictograms and the display's still frame. */
function generated(name: string): string | null {
	if (name === "logo") return dotsSvg(WORDMARK, { className: "brand__logo" });
	if (name === "mark") return dotsSvg(MARK, { className: "mark" });
	if (name === "wordmark") {
		return dotsSvg(WORDMARK, { className: "site-footer__wordmark", lattice: true });
	}
	if (name === "caret") return dotsSvg(Array<string>(8).fill("R"), { className: "caret" });
	if (name === "display-still") {
		return sceneSvg(240, 51, false, "wide") + sceneSvg(160, 51, true, "narrow");
	}
	const picto = PICTOS[name.replace(/^picto-/, "")];
	if (name.startsWith("picto-") && picto)
		return dotsSvg(picto, { className: "picto", lattice: true });
	return null;
}

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
 * Shared markup: `<!--@name-->` is replaced with generated markup (logo, pictograms, the display's
 * still frame) or with `src/partials/name.html` (header, footer); then the repo and relay tokens.
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
				const fill = (text: string) =>
					text.replace(
						/<!--@([a-z-]+)-->/g,
						(_, name: string) =>
							generated(name) ?? readFileSync(here(`./src/partials/${name}.html`), "utf8").trim(),
					);
				out = fill(out);
				for (const [token, markup] of Object.entries(REPO_MARKUP))
					out = out.replaceAll(token, markup);
				// Again: a partial (the header) may hold a generated token (the logo).
				out = fill(out);
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
		plugins: [partials(relay), cleanUrls(), brandFiles(), pagesHeaders(relay)],
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
