# The website (`packages/site`)

A small static site for ArcaSync: a landing page, the install guide, and the browser side of
invites and sign-in. It is hosted on **Cloudflare Pages** at **https://arca-sync.pages.dev**
(project `arca-sync`), apart from the relay, and calls the relay's `/api/*` cross-origin.

| Path | Page | Relay calls |
|---|---|---|
| `/` | Landing page with the display (a 2D canvas, lazy) | none |
| `/guide` | Install, connect, sign in, share, troubleshooting | none |
| `/join?invite=…` | Create an account from an invite, or add its workspace to the signed-in account; "Open in Obsidian" as the alternative. "Join with a PIN": 4 digits + name + password (new account), or the PIN alone when signed in | `accept`, or `me` + `redeem`; `pin/accept` or `redeem-pin` |
| `/signin` | Name + password first; below it, a device code approved in Obsidian | `auth/login`; `device/start`, `device/poll` |
| `/approve?code=…` | Approve the code an Obsidian shows under "Sign in with another device" | `me`, `device/lookup`, `device/approve` |
| `/account` | Who am I, my workspaces, set or change the password, invite PINs (owners/admins: create, list, revoke; admins: unlock PIN entry), sign out | `me`, `auth/password`, `workspaces/:id/pins`, `admin/pins/unlock`, `logout` |
| (anything else) | `404.html` | none |

Static files cost no Worker requests: Pages serves them. Only the relay calls above count, a few per
human action (sign-in polls about every 5 s while waiting, at most about 120 per sign-in). Preflights
are cached for 2 hours.

### PIN and password endpoints

All JSON; errors are `{error: {code, message, details?}}`. 429 and 423 carry `details.retryAfter`
(seconds) and a `Retry-After` header (CORS-exposed). Deploy the relay before a site that uses them.

| Call | Auth | Success | Errors |
|---|---|---|---|
| `POST /api/auth/login {name, password, device}` | none | 200 `SessionResponse` | 400 `bad_request`; 401 `invalid_credentials` (unknown name, no password, wrong password, disabled: all the same); 429 `rate_limited` |
| `POST /api/auth/password {current?, new}` | bearer | 200 `{ok}`; other sessions revoked | 400 `bad_request`/`weak_password`; 401 session; 403 `invalid_credentials` (missing or wrong `current`; not 401, so clients keep the session); 409 `conflict`; 429 `rate_limited` |
| `GET /api/auth/me` | bearer | `MeResponse` + `hasPassword` | 401 |
| `POST /api/auth/pin/accept {pin, name, password, device}` | none | 200 `SessionResponse` | 400 `bad_request`/`weak_password`; 404 `invalid_pin` (wrong, used, revoked, expired: all the same); 409 `name_taken`; 423 `pins_locked`; 429 `rate_limited` |
| `POST /api/invites/redeem-pin {pin}` | bearer | 200 `WorkspacesResponse` | 401; 404 `invalid_pin`; 423; 429 |
| `GET /api/workspaces/:id/pins` | owner/admin | 200 `{pins: PinSummary[], locked, lockedUntil}` | 401; 403 |
| `POST /api/workspaces/:id/pins {role, admin?, expiresInSec?}` | owner/admin (`admin` only for server admins) | 200 `PinSummary` | 400; 401; 403; 409 `too_many_pins` |
| `DELETE /api/workspaces/:id/pins/:pinId` | owner/admin | 200 `{ok}` | 401; 403; 404 |
| `POST /api/admin/pins/unlock` | server admin | 200 `{ok}` | 401; 403 |

`/server-info` advertises `features.passwords` and `features.pins`.

## Look

Monochrome with one red signal, set in dots. Tokens are in `src/styles/tokens.css` (dark is the
primary theme). Fonts are self-hosted through `@fontsource`: Doto for display type, Geist for text,
Geist Mono for labels and codes.

- **Logo.** A 5×7 dot-matrix A whose crossbar is a single red dot, and `ARCASYNC` in the same
  glyphs. The glyph table is `src/matrix/glyphs.ts`; `vite.config.ts` draws the header logo, the
  pictograms, `/favicon.svg`, `/logo.svg` and `/mark.svg` from it, so there are no image files.
- **The display.** The landing page's centrepiece: three people co-writing a note on a dot lattice.
  `src/matrix/scene.ts` is the scene (no DOM, deterministic, unit-tested); `src/matrix/display.ts`
  draws it on a 2D canvas, on a pitch of whole device pixels (`--pitch` in `home.css`), redrawing only the dots that changed.
  It stops when off-screen or in a hidden tab. With reduced motion it shows one still frame, and
  without JavaScript (or with data saver on) the page keeps the same frame as an SVG that the build
  renders from the scene. Moving the mouse over it adds the visitor's own caret.

## Configuration

Site, at build time:

| Variable | Meaning | Default |
|---|---|---|
| `VITE_ARCASYNC_API_URL` | The relay's base URL. It is baked into the API client, the guide's **Server URL**, the "Open in Obsidian" links and the CSP `connect-src` in `dist/_headers`. | `http://localhost:8789` (local `wrangler dev`) |
| `ARCASYNC_SITE_PROJECT` | Cloudflare Pages project name, for `deploy:site` only. | `arca-sync` |

The GitHub repo that BRAT installs from is the constant `GITHUB_REPO` in
`packages/site/src/lib/config.ts`. It is a placeholder (`OWNER/arcasync`) until the repo exists:
the guide and footer then show the path with a "link coming soon" badge. Change that one line.

Relay (`packages/relay-cf/wrangler.jsonc`, per environment):

| Variable | Meaning | dev | production / probe |
|---|---|---|---|
| `ARCASYNC_PUBLIC_URL` | The **site's** public URL. Invite links become `<it>/join?invite=…` and device codes' `verificationUri` `<it>/approve?code=…`. Unset, they are the plugin's `obsidian://arcasync` deep links. | `http://localhost:5173` | production `https://arca-sync.pages.dev`; probe unset |
| `ARCASYNC_SITE_ORIGINS` | Comma-separated site origins allowed to call `/api/*` (CORS, bearer tokens, no cookies). Obsidian's own origins and `localhost` are always allowed. | `http://localhost:5173,http://localhost:4173` | production `https://arca-sync.pages.dev`; probe unset (no website may call it) |

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

1. Create the Pages project `arca-sync` (it serves `https://arca-sync.pages.dev`).
2. `wrangler.jsonc` `env.production.vars` already sets `ARCASYNC_PUBLIC_URL` and
   `ARCASYNC_SITE_ORIGINS` to `https://arca-sync.pages.dev`; change both there if the host changes.
   Deploy the relay: from then on every new invite and device code links to the site. Links already
   handed out keep working, but links to the site stop working if its host later changes.
3. Build the site against the production relay and upload it:

   ```sh
   VITE_ARCASYNC_API_URL=https://<relay host> pnpm -F @arcasync/site build
   pnpm -F @arcasync/site deploy:site   # ARCASYNC_SITE_PROJECT overrides the project (arca-sync)
   ```

   `deploy:site` refuses a build made against a local relay.

Deploy the site before (or together with) the relay change in step 2, so new invite links never
point at a site that isn't there yet.

## Security notes

- CSP: `default-src 'none'`, scripts, styles and fonts from `'self'` only, `connect-src` the relay,
  `frame-ancestors 'none'`. No inline scripts or `style` attributes, no third-party origins. The
  generated SVG is coloured by classes, or by attributes in the standalone files.
- The session token is kept in `localStorage["arcasync.session"]` and sent as a bearer. It can
  approve devices, so "Sign out" revokes it on the relay and `/account` names the browser device.
  An `HttpOnly` cookie would be stronger but needs cookie auth and CSRF handling in the relay
  (a follow-up).
- Invite tokens are moved from the URL to `sessionStorage` on arrival (`replaceState`), and
  `Referrer-Policy: no-referrer` keeps them out of referrers. `#invite=` also works, so links could
  later keep the token out of server logs entirely.
- The device-approval card names the requesting device and warns to approve only codes you started;
  approving always takes a click. `/signin?next=` only accepts `/approve`, `/account` or `/join`.
