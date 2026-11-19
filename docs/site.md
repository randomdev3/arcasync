# The website (`packages/site`)

A small static site for ArcaSync: a landing page, the install guide, and the browser side of
invites and sign-in. It is hosted on **Cloudflare Pages**, apart from the relay, and calls the
relay's `/api/*` cross-origin.

| Path | Page | Relay calls |
|---|---|---|
| `/` | Landing page with the loom (three.js, lazy) | none |
| `/guide` | Install, connect, sign in, share, troubleshooting | none |
| `/join?invite=…` | Create an account from an invite, or add its workspace to the signed-in account; "Open in Obsidian" as the alternative | `accept`, or `me` + `redeem` |
| `/signin` | Sign this browser in with a device code approved in Obsidian | `device/start`, `device/poll` |
| `/approve?code=…` | Approve the code an Obsidian shows under "Sign in with another device" | `me`, `device/lookup`, `device/approve` |
| `/account` | Who am I, my workspaces, sign out | `me`, `logout` |
| (anything else) | `404.html` | none |

Static files cost no Worker requests: Pages serves them. Only the relay calls above count, a few per
human action (sign-in polls about every 5 s while waiting, at most about 120 per sign-in). Preflights
are cached for 2 hours.

## Configuration

Site, at build time:

| Variable | Meaning | Default |
|---|---|---|
| `VITE_ARCASYNC_API_URL` | The relay's base URL. It is baked into the API client, the guide's **Server URL**, the "Open in Obsidian" links and the CSP `connect-src` in `dist/_headers`. | `http://localhost:8789` (local `wrangler dev`) |
| `ARCASYNC_SITE_PROJECT` | Cloudflare Pages project name, for `deploy:site` only. | none |

The GitHub repo that BRAT installs from is the constant `GITHUB_REPO` in
`packages/site/src/lib/config.ts`. It is a placeholder (`OWNER/arcasync`) until the repo exists:
the guide and footer then show the path with a "link coming soon" badge. Change that one line.

Relay (`packages/relay-cf/wrangler.jsonc`, per environment):

| Variable | Meaning | dev | production / probe |
|---|---|---|---|
| `ARCASYNC_PUBLIC_URL` | The **site's** public URL. Invite links become `<it>/join?invite=…` and device codes' `verificationUri` `<it>/approve?code=…`. Unset, they are the plugin's `obsidian://arcasync` deep links. | `http://localhost:5173` | unset until the Pages host is decided |
| `ARCASYNC_SITE_ORIGINS` | Comma-separated site origins allowed to call `/api/*` (CORS, bearer tokens, no cookies). Obsidian's own origins and `localhost` are always allowed. | `http://localhost:5173,http://localhost:4173` | unset: no website may call the API |

## Develop

```sh
pnpm dev                       # relay on :8789, plugin watch, site (vite) on :5173
pnpm -F @arcasync/site test    # flows and lib, no DOM
pnpm -F @arcasync/site build   # dist/, with _headers for Pages
pnpm -F @arcasync/site preview:pages   # serve dist/ like Pages (wrangler pages dev, :4173)
```

`vite dev` serves `/join` etc. as clean URLs like Pages does. The CSP in `_headers` only applies to
the built site (Pages or `wrangler pages dev`), not to `vite dev`.

`pnpm -F @arcasync/relay-cf test:integration` includes `test/site.integration.test.ts`: CORS for
allowed and refused origins, the preflight, both link forms, and the browser flows over HTTP.

## Deploy (by the owner only)

1. Decide the Pages host (for example `<project>.pages.dev`) and create the Pages project.
2. In `wrangler.jsonc` `env.production.vars`, set `ARCASYNC_PUBLIC_URL` to the site URL and
   `ARCASYNC_SITE_ORIGINS` to its origin, then deploy the relay. From then on every new invite and
   device code links to the site; links already handed out keep working.
3. Build the site against the production relay and upload it:

   ```sh
   VITE_ARCASYNC_API_URL=https://<relay host> pnpm -F @arcasync/site build
   ARCASYNC_SITE_PROJECT=<pages project> pnpm -F @arcasync/site deploy:site
   ```

   `deploy:site` refuses a build made against a local relay.

## Security notes

- CSP: `default-src 'none'`, scripts, styles and fonts from `'self'` only, `connect-src` the relay,
  `frame-ancestors 'none'`. No inline scripts or `style` attributes, no third-party origins.
- The session token is kept in `localStorage["arcasync.session"]` and sent as a bearer. It can
  approve devices, so "Sign out" revokes it on the relay and `/account` names the browser device.
  An `HttpOnly` cookie would be stronger but needs cookie auth and CSRF handling in the relay
  (a follow-up).
- Invite tokens are moved from the URL to `sessionStorage` on arrival (`replaceState`), and
  `Referrer-Policy: no-referrer` keeps them out of referrers. `#invite=` also works, so links could
  later keep the token out of server logs entirely.
- The device-approval card names the requesting device and warns to approve only codes you started;
  approving always takes a click. `/signin?next=` only accepts `/approve`, `/account` or `/join`.
