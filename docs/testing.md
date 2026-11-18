# Testing

Every command runs from the repository root. There are four layers. The first three run on any
OS with a Node version that runs `.ts` files natively (22.18 or newer; the relay's scripts, such as
the budget gate, are run as `node scripts/<name>.ts`); the last needs Obsidian on macOS.

## Unit tests, lint, types, build

```sh
pnpm lint && pnpm typecheck && pnpm test && pnpm build
```

`pnpm test` runs vitest in every package. The relay's store tests use `node:sqlite` as a stand-in
for Durable Object SQLite, and the plugin's tests use the `obsidian` mock in
`packages/plugin/src/__mocks__`. `pnpm build` of the relay is `wrangler deploy --dry-run --env
production` (a local bundle, no network).

## Relay integration tests

```sh
pnpm -F @teamsync/shared build
pnpm -F @teamsync/relay-cf test:integration
```

Each file starts its own `wrangler dev --env dev` (local workerd) with a temporary state
directory, and drives it with real `@hocuspocus/provider` clients or raw frames:

| File | Covers |
|---|---|
| `relay.integration.test.ts` | Sync over one socket, late-joiner presence, real hibernation, restart, viewers |
| `config.integration.test.ts` | Debug endpoints off, dev-login roles, the 503 guard on a bad secret |
| `traffic.integration.test.ts` | Keepalive, presence renewal and `flushDelay` message and row counts |
| `probe.integration.test.ts` | The load probe's counts equal the relay's counters |
| `attribution.integration.test.ts` | Per-user rows and `doc_clients`, the awareness identity check, viewer rows |

The suite takes about 3.5 minutes (the hibernation and traffic cases idle on purpose). It is not
part of `pnpm test`. CI runs it in the `relay-integration` job.

## Free-tier budget gate

```sh
pnpm -F @teamsync/relay-cf budget
```

It measures the unit costs (messages and rows per typed key, frames per note open, renewals,
pings, compaction rows) against a local relay, multiplies them by the team model in
`packages/relay-cf/scripts/budget-model.ts`, and exits non-zero if any free-plan cap goes above
50% in either scenario. `--port` picks the relay port (default 22500).

## End-to-end tests in real Obsidian (macOS only)

```sh
pnpm --filter @teamsync/plugin build
pnpm e2e:smoke        # the harness itself
pnpm e2e:p0           # P0 counter in two vaults, including a relay restart
pnpm e2e:p1           # every scenario in scripts/e2e/p1/
pnpm e2e:p1 --only mapping,index-sync
```

The harness launches one Obsidian process per vault (`alice`, `bob`, and `carol` as a viewer
when a scenario needs her) with its own profile under `.e2e/profiles/`, and drives each window
over the Chrome DevTools Protocol. It needs the Obsidian desktop app at
`/Applications/Obsidian.app` (or `OBSIDIAN_BIN`) and a logged-in GUI session, so **e2e does not
run in CI**. It never touches your own Obsidian windows or vaults.

Environment variables:

| Variable | Default | Meaning |
|---|---|---|
| `E2E_BACKEND` | `cf` | `cf` (local `wrangler dev`), `node` (the Node server), or `remote` |
| `E2E_REMOTE_URL` | | Base URL for `E2E_BACKEND=remote`; restart steps print SKIP |
| `E2E_PORT` | `8788` | Port of the local backend |
| `E2E_CDP_PORT` | `9333` | DevTools port of the first vault; vault *n* uses this plus *n* |
| `E2E_SERVER_LOG` | | Set to show backend logs |
| `OBSIDIAN_BIN` | `/Applications/Obsidian.app/Contents/MacOS/Obsidian` | Obsidian binary |

On a failure every window is screenshotted. Screenshots and other artifacts go to
`.e2e/artifacts/<suite>/<scenario>/`. `.e2e/` is git-ignored and local to each checkout.

### Mobile: what emulation covers, and what needs a real device

`scripts/e2e/p1/mobile-emulation.mjs` switches bob's window to Obsidian's mobile layout with
`app.emulateMobile(true)`. The page reloads once, and the plugin restarts with
`Platform.isMobile` and the mobile limits from `packages/plugin/src/platform.ts`:

| Limit | Desktop | Mobile |
|---|---|---|
| `warmDocs` (released note docs kept attached) | 20 | 5 |
| `bgConcurrency` (closed notes caught up at once) | 3 | 1 |
| `maxMdBytes` (larger notes are not synced) | unlimited | 2 MiB |

A note over `maxMdBytes` is skipped and a Notice is shown once per note. The plugin checks the
file's size before it attaches the note, so the note costs no traffic. A doc that was synced in
and turned out too large is checked again after each attach. In both cases nothing is enrolled
or written to disk, and the editor on that note is a plain, unsynced editor. The path still
syncs, so other devices get the file, but it is empty there until the note is edited somewhere
that can sync it.

The scenario proves the following under emulation:
- The reload keeps the session token, so the plugin reconnects on its own.
- Typing syncs both ways, to the other editor and to its disk.
- Presence avatars show in the mobile view header.
- Opening 30 notes in a row keeps at most `warmDocs + 1` docs attached.
- An IME composition (`Input.imeSetComposition`, then `Input.insertText`) fires
  `compositionstart`/`compositionend` and commits its text exactly once.
- A 2.5 MiB note is skipped and never uploaded.
- The relay counts no inbound messages and writes no rows while the client sits idle.

`bundle.test.ts` checks that `dist/main.js` loads only `obsidian` and `@codemirror/*`. A Node
built-in, `electron`, or a dynamic `require` would throw at load time on iOS and Android. The
one `process.env` read comes from lib0 and sits behind its `typeof process` check. The plugin
has no polling loop. Its only periodic timers are:
- the provider's local connection check;
- the presence policy's 30 s local check, which sends a renewal every 120 s while active and
  every 900 s while idle;
- on relay-cf, the 90 s keepalive ping, which the relay answers without waking the Durable
  Object.

The emulated window is still desktop Chromium/Electron on macOS (`is-tablet is-mobile` layout,
Node available, desktop user agent). These checks need a real iPhone/iPad and an Android
phone, run by hand before a mobile release:

- [ ] **Background and foreground.** Background the app for 1 min and for 10+ min, then bring it
  back. The socket reconnects once, with no reconnect storm in the relay's `connects` counter,
  and edits made meanwhile on desktop appear.
- [ ] **Network switch.** Move between Wi-Fi and cellular, and toggle flight mode, while typing.
  Nothing is lost or duplicated, and the reconnect happens without a restart.
- [ ] **CORS from `capacitor://localhost`** (iOS) and `http://localhost` (Android). `requestUrl`
  calls (`/api/server-info`, `/api/auth/*`, `/api/workspaces`) and the WebSocket upgrade
  succeed against a deployed relay.
- [ ] **iOS IndexedDB eviction.** Leave the app unused for several days, or under storage
  pressure. Notes still open correctly and reconcile from the relay, with no "local copy" files
  created for notes that were not edited.
- [ ] **`app.secretStorage` on mobile.** The session token survives an app kill and relaunch,
  and is not written to `data.json`.
- [ ] **On-screen keyboard and IME in CM6 mobile.** Test Japanese kana-kanji, Chinese pinyin,
  Korean, swipe typing, autocorrect and dictation. Each commit appears once on desktop with no
  preedit residue, and remote carets do not break the composition.
- [ ] **Battery and memory with 5 warm docs.** Run a 30-minute session with a desktop peer
  typing. Watch the OS battery and memory views; the app is not killed in the background.
- [ ] **Timers while suspended.** After iOS suspends the WebView, the keepalive and presence
  timers resume without a burst of messages, and peers expire the phone's presence (≤ 41 min
  idle bound) rather than showing it forever.
- [ ] **A note over 2 MiB** shows the Notice once, stays editable locally, and is not synced.

### Parallel worktrees

Several checkouts (git worktrees) can run e2e and integration tests at the same time if each one
uses its own ports. The convention is one port range per lane:

| Lane | `E2E_CDP_PORT` | `E2E_PORT` |
|---|---|---|
| L1 | 9333 | 8788 |
| L2 | 9343 | 8798 |
| L3 | 9353 | 8808 |

`wrangler dev` also opens an inspector on its port plus 10000. The integration tests pick their
own ports in the 20000-30000 range.
