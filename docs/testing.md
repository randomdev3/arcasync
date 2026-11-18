# Testing

Every command runs from the repository root. There are four layers. The first three run on any
OS with Node 22.13 or newer; the last needs Obsidian on macOS.

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
