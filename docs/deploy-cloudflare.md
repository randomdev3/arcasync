# Deploying the relay to Cloudflare

The relay (`packages/relay-cf`) runs on Cloudflare Workers and SQLite-backed Durable Objects and
is sized for the **free plan**. Every command below runs from the repository root.

## Environments

`packages/relay-cf/wrangler.jsonc` defines four configurations:

| Env | Worker name | Dev login | Debug stats | Secret | Use |
|---|---|---|---|---|---|
| (top level) | `teamsync-relay` | off | off | none | Safe default: a bare `wrangler deploy` serves nothing until a secret is set. |
| `production` | `teamsync-relay` | off | off | `wrangler secret put` | The real deployment. Observability on. |
| `dev` | `teamsync-relay-dev` | on | on | public dev secret in `vars` | Local `wrangler dev --env dev` only (`pnpm dev`, tests). Never deploy it. |
| `probe` | `teamsync-relay-probe` | on | on | `wrangler secret put --env probe` | Throwaway free-tier measurement. Delete it afterwards. |

The worker checks `TEAMSYNC_SECRET` on every request. If it is missing, shorter than 32
characters, or equal to the public dev secret (outside `env.dev`), every route answers
`503 {"error":{"code":"misconfigured"}}`, WebSocket upgrades included, and `/api/health` answers
`{"ok":false,"error":"…"}`.

## Production deploy

1. Log in (opens a browser):
   ```sh
   pnpm -F @teamsync/relay-cf exec wrangler login
   ```
2. Set the secret. It signs WebSocket JWTs and peppers session tokens, so rotating it signs
   everyone out. It is read from stdin and never stored in the repository:
   ```sh
   openssl rand -base64 48 | pnpm -F @teamsync/relay-cf exec wrangler secret put TEAMSYNC_SECRET --env production
   ```
3. Deploy:
   ```sh
   pnpm -F @teamsync/relay-cf deploy:production
   ```
4. Check: `curl https://teamsync-relay.<subdomain>.workers.dev/api/health` returns `"ok":true`.
   `"ok":false` names the configuration problem.

**Accounts.** Production has dev login off, so nobody can sign in yet. The admin bootstrap
(`POST /api/auth/bootstrap` with a `TEAMSYNC_BOOTSTRAP_TOKEN` secret) and invites arrive in P2.

## Free-tier probe

The probe measures how Cloudflare actually counts the relay's traffic (WebSocket messages 1:1
or 20:1, whether auto-responded pings and close events bill, and whether compaction deletes count
as rows written). It runs only on the `probe` environment, and the worker is deleted afterwards.

1. Deploy, then confirm the guard: health reports `ok:false` before the secret exists.
   ```sh
   pnpm -F @teamsync/relay-cf deploy:probe
   curl https://teamsync-relay-probe.<subdomain>.workers.dev/api/health
   openssl rand -base64 48 | pnpm -F @teamsync/relay-cf exec wrangler secret put TEAMSYNC_SECRET --env probe
   curl https://teamsync-relay-probe.<subdomain>.workers.dev/api/health   # now "ok":true
   ```
2. Run the load probe. Its phases are 2 minutes apart, and it prints each phase's UTC window and
   the expected DO requests (1:1 and 20:1), rows written and Worker requests, next to the deltas
   it measured through `/api/debug/stats`:
   ```sh
   node packages/relay-cf/scripts/load-probe.ts --url https://teamsync-relay-probe.<subdomain>.workers.dev \
     --pings 500 --frames 500 --rows 300 --connects 50 --json .e2e/probe-$(date +%F).json
   ```
3. Close open login right away by redeploying with it off:
   ```sh
   pnpm -F @teamsync/relay-cf exec wrangler deploy --env probe --var TEAMSYNC_DEV_OPEN_LOGIN:0
   ```
4. Wait at least 10 minutes for analytics to settle, then read the counters for each printed UTC
   window in the dashboard:
   - **Workers & Pages → teamsync-relay-probe → Metrics**: Worker requests.
   - **Workers & Pages → teamsync-relay-probe → Durable Objects** (or **Storage & Databases →
     Durable Objects**), per namespace: requests, rows written, rows read, duration.
   - Compare each window with the probe's expected numbers: the `pings` window shows whether
     auto-responses bill, `frames` gives the inbound message ratio, `rows` the rows written per
     update, and `connects` whether close events count as requests.
5. **Teardown (always, also after a failure):**
   ```sh
   pnpm -F @teamsync/relay-cf exec wrangler delete --env probe
   curl -s -o /dev/null -w '%{http_code}\n' https://teamsync-relay-probe.<subdomain>.workers.dev/api/health   # not 200
   ```
   Follow any CLI prompt about removing the Durable Object namespaces. Run `wrangler logout` when
   you no longer need the session.

## Rollback

Every deploy creates a version. To go back to the previous one:
```sh
pnpm -F @teamsync/relay-cf exec wrangler deployments list --env production
pnpm -F @teamsync/relay-cf exec wrangler rollback --env production            # previous version
pnpm -F @teamsync/relay-cf exec wrangler rollback <version-id> --env production
```
A rollback changes code only. Durable Object storage and secrets stay as they are, so a rollback
across a storage schema change needs care.
