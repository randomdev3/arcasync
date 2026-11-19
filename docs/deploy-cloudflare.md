# Deploying the relay to Cloudflare

The relay (`packages/relay-cf`) runs on Cloudflare Workers and SQLite-backed Durable Objects and
is sized for the **free plan**. Every command below runs from the repository root.

## Environments

`packages/relay-cf/wrangler.jsonc` defines four configurations:

| Env | Worker name | Dev login | Debug stats | Secret | Use |
|---|---|---|---|---|---|
| (top level) | `arcasync-relay` | off | off | none | Safe default: a bare `wrangler deploy` serves nothing until a secret is set. |
| `production` | `arcasync-relay` | off | off | `wrangler secret put` | The real deployment. Observability on. R2 bucket `arcasync-chunks`. |
| `dev` | `arcasync-relay-dev` | on | on | public dev secret in `vars` | Local `wrangler dev --env dev` only (`pnpm dev`, tests). Local R2 emulation. Never deploy it. |
| `probe` | `arcasync-relay-probe` | on | on | `wrangler secret put --env probe` | Throwaway free-tier measurement. No R2. Delete it afterwards. |

The probe has **no R2 binding** on purpose: it measures Durable Object and WebSocket billing, it
should not be able to leave objects in a bucket, and without the binding `/api/server-info`
reports `features.chunks: false`, so a plugin pointed at it syncs notes only. Every binding stays
local or account-bound by name; none sets `"remote": true`.

The worker checks `ARCASYNC_SECRET` on every request. If it is missing, shorter than 32
characters, or equal to the public dev secret (outside `env.dev`), every route answers
`503 {"error":{"code":"misconfigured"}}`, WebSocket upgrades included, and `/api/health` answers
`{"ok":false,"error":"…"}`.

## Production deploy

1. Log in (opens a browser):
   ```sh
   pnpm -F @arcasync/relay-cf exec wrangler login
   ```
2. Create the R2 bucket for attachments (once per account; R2 must be enabled on the account):
   ```sh
   pnpm -F @arcasync/relay-cf exec wrangler r2 bucket create arcasync-chunks
   ```
3. Set the secrets. They are read from stdin and never stored in the repository.
   `ARCASYNC_SECRET` signs WebSocket JWTs and peppers session, invite and device-code hashes, so
   rotating it signs everyone out. `ARCASYNC_BOOTSTRAP_TOKEN` (at least 32 characters) is needed
   only for the one-time bootstrap below:
   ```sh
   openssl rand -base64 48 | pnpm -F @arcasync/relay-cf exec wrangler secret put ARCASYNC_SECRET --env production
   BOOTSTRAP_TOKEN=$(openssl rand -base64 48)
   printf %s "$BOOTSTRAP_TOKEN" | pnpm -F @arcasync/relay-cf exec wrangler secret put ARCASYNC_BOOTSTRAP_TOKEN --env production
   ```
   Keep the shell open: the bootstrap below reads `$BOOTSTRAP_TOKEN`.
4. Deploy:
   ```sh
   pnpm -F @arcasync/relay-cf deploy:production
   ```
5. Check: `curl https://arcasync-relay.<subdomain>.workers.dev/api/health` returns `"ok":true`.
   `"ok":false` names the configuration problem. `/api/server-info` lists
   `features: {accounts: true, chunks: true, bulkClone: true}` once the bucket binding resolves.

## Accounts: bootstrap, invites and sign-in

Production has dev login off. Every user signs in through an invite or a device code.

**Bootstrap (once).** The first call creates the first workspace and a single-use invite that
makes whoever accepts it the workspace owner **and** server admin. The invite is valid for 24 hours.
```sh
curl -s -X POST https://arcasync-relay.<subdomain>.workers.dev/api/auth/bootstrap \
  -H "Authorization: Bearer $BOOTSTRAP_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"workspaceName":"Team"}' | jq -r .invite.url
```
It prints the invite link (`invite.url`, an `obsidian://arcasync?…` link carrying the server URL
and the invite token). A second bootstrap answers `409 already_bootstrapped`; a missing or wrong
token answers `401`, and a server without `ARCASYNC_BOOTSTRAP_TOKEN` answers `404`. Delete the
secret afterwards if you like (`wrangler secret delete ARCASYNC_BOOTSTRAP_TOKEN --env production`);
it is never needed again.

**First sign-in.** On the admin's machine, open the printed link (Obsidian with the plugin
installed handles `obsidian://arcasync`), or paste it into Settings → ArcaSync → "Join with an
invite", pick a display name, and Join. The plugin accepts the invite, stores the session token
in Obsidian's secret storage, and connects.

**More people.** An owner or admin runs "Create an invite link" (command palette) and sends the
link. A new user joins as above; someone already signed in pastes it into "Join another
workspace" and is added to that workspace. Members and roles are managed with "Manage workspace
members".

**More devices (device code).** On the new device, Settings → ArcaSync → "Sign in with another
device" shows a short user code. On a device that is already signed in, run "Approve a device
sign-in" (or open the `obsidian://arcasync?approve=<code>` link), check the device name and
platform it shows, and approve. The new device polls every 5 s at most (faster polls get
`slow_down`) and signs in as the approver; the code expires after 10 minutes.

**Revocation.** A role change or removal closes that user's sockets with `4401
membership-changed`, and the relay refuses any workspace JWT issued up to that second. The
client mints a new token, which carries the new role or answers `404` when the user was removed
(the plugin then stops that workspace and keeps its files). Disabling a user revokes all their
sessions and closes their sockets in every workspace. Residual: chunk `GET`/`PUT` is checked in
the Worker against the workspace JWT only, so a removed member can still read or upload that
workspace's chunks with an already-minted JWT for up to its 15-minute lifetime.
`GET /api/auth/me` is cached per isolate for 60 s, so another isolate may show a role or
membership that changed less than a minute ago; authorisation never reads that cache.

## Attachments (R2) and chunk GC

Binary files go to R2 as 4 MiB chunks under `ws/<workspaceId>/<sha256>`, one namespace per
workspace (no cross-workspace dedup). The Worker streams each PUT to R2 with the `sha256` and
`onlyIf` checks left to R2 and never hashes the body. The relay reports `limits.maxFileBytes`
(`ARCASYNC_MAX_FILE_BYTES`, 200 MiB); mobile clients stop at 50 MiB.

Unreferenced chunks are deleted by an alarm on the workspace's Durable Object:
- Only a write to the workspace's index doc arms it, at +24 h, and only if none is pending. A
  workspace with no writes never wakes for GC.
- A run takes a projection of the index's `files`, lists the workspace's objects (≤ 20 pages),
  takes a second projection, and deletes only objects older than 24 hours that neither
  projection references.
- A run never re-arms itself, except +1 h to continue a run that hit its page cap.
- So a deleted attachment's chunks disappear between 24 and 48 hours after the last index write
  following the delete. The uploader re-checks `missing` after its index entry is acked, so a
  chunk collected during an upload is uploaded again.

## Free-tier probe

The probe measures how Cloudflare actually counts the relay's traffic (WebSocket messages 1:1
or 20:1, whether auto-responded pings and close events bill, and whether compaction deletes count
as rows written). It runs only on the `probe` environment, and the worker is deleted afterwards.

1. Deploy, then confirm the guard: health reports `ok:false` before the secret exists.
   ```sh
   pnpm -F @arcasync/relay-cf deploy:probe
   curl https://arcasync-relay-probe.<subdomain>.workers.dev/api/health
   openssl rand -base64 48 | pnpm -F @arcasync/relay-cf exec wrangler secret put ARCASYNC_SECRET --env probe
   curl https://arcasync-relay-probe.<subdomain>.workers.dev/api/health   # now "ok":true
   ```
2. Run the load probe. Its phases are 2 minutes apart, and it prints each phase's UTC window and
   the expected DO requests (1:1 and 20:1), rows written and Worker requests, next to the deltas
   it measured through `/api/debug/stats`:
   ```sh
   node packages/relay-cf/scripts/load-probe.ts --url https://arcasync-relay-probe.<subdomain>.workers.dev \
     --pings 500 --frames 500 --rows 300 --connects 50 --json .e2e/probe-$(date +%F).json
   ```
3. Delete the probe right away (step 5). Cloudflare keeps its analytics after the worker is
   gone, so there is no reason to leave an open-login worker running while you wait.
4. Wait at least 10 minutes for analytics to settle, then read the counters for each printed UTC
   window. The GraphQL Analytics API answers with the token `wrangler login` stores (account
   analytics are readable with it), grouped by `datetimeMinute`:
   - `workersInvocationsAdaptive`: `sum { requests }` (Worker requests).
   - `durableObjectsInvocationsAdaptiveGroups`: `sum { requests }` (billed DO requests).
   - `durableObjectsPeriodicGroups`: `sum { duration rowsWritten rowsRead activeTime }`;
     `duration` is the billed GB-s.
   The probe env has debug stats on, which writes one extra stats row per message; subtract it
   when reading rows written. Compare each window with the probe's expected numbers: `pings`
   shows whether auto-responses bill, `frames` the inbound message ratio, `rows` the rows written
   per update, and `connects` whether close events count as requests.
5. **Teardown (always, also after a failure):**
   ```sh
   pnpm -F @arcasync/relay-cf exec wrangler delete --env probe
   curl -s -o /dev/null -w '%{http_code}\n' https://arcasync-relay-probe.<subdomain>.workers.dev/api/health   # not 200
   ```
   Follow any CLI prompt about removing the Durable Object namespaces. Run `wrangler logout` when
   you no longer need the session.

### Results (2026-11-19, free plan)

These are the counts the analytics report; the free-tier limits are assumed to use the same counters.

| Question | Answer | Evidence |
|---|---|---|
| Inbound WebSocket messages per DO request | 1:1 | 501 frames → 505 requests; 301 updates → 305 |
| Auto-responded keepalive pings counted? | No | ~140 pings in one minute → 2 requests (stats reads) |
| Close events counted? | Yes | 50 × (connect + Auth + close) → 152 requests |
| Rows written per update | 1 | 301 updates → 605 rows, of which 301 are debug-stats rows |
| Duration | ≈1.8 ms active per request | 10 clients × 10 min → 0.25 GB-s (the model would say ≈75) |

`budget-model.ts` uses these (`PINGS_BILLED: false`). Its gbSeconds gate uses the measured duration
with a 10× margin (18 ms per billed request); the awake-window model is printed only as a bound. The whole probe (functional smoke, `budget --live`, load probe) used under 4% of the
daily DO request cap and 7% of rows written. No CPU or memory limit was hit.

## Local R2 emulation

`wrangler dev --env dev` (and every relay integration test) runs R2 in miniflare with state under
the persist directory. Locally, a PUT with the wrong `sha256` is refused (the relay answers
`400 checksum_mismatch`), a second PUT of an existing key is a no-op through `onlyIf`, and a
streamed `request.body` of known length is accepted. Whether real R2 behaves the same, including
the wording of its checksum error that the Worker maps to `checksum_mismatch`, is unproven until
the real-Cloudflare P2 probe below.

## Requires the owner of the Cloudflare account

Nothing below has been done; each needs its own go-ahead.

1. Create the bucket: `wrangler r2 bucket create arcasync-chunks`.
2. Set the production secrets `ARCASYNC_SECRET` and `ARCASYNC_BOOTSTRAP_TOKEN` (the bootstrap
   token can be deleted after step 4).
3. Deploy production: `pnpm -F @arcasync/relay-cf deploy:production`.
4. Bootstrap with the `curl` above and open the printed link on the admin's machine.
5. A real-Cloudflare P2 probe (local emulation cannot prove these):
   - A 4 MiB chunk PUT/GET stays under the free plan's 10 ms Worker CPU (`wrangler tail`: no
     `exceededCpu`).
   - Real R2 rejects a wrong `sha256` (and with which error message, which the Worker maps to
     `400 checksum_mismatch`) and honours `onlyIf`.
   - R2 Class A/B counts per operation.
   - Whether `setAlarm`, alarm runs and Durable Object to Durable Object RPC count as the budget
     models them (pessimistically: a row written, a request, a request).
   - R2 binding calls count toward the 50-subrequest limit (Cloudflare's limits page says they
     do; `CHUNKS_MISSING_MAX` = 40 heads per `missing` call stays under it).
6. Real devices: iOS and Android binary download memory under the 50 MiB cap,
   `obsidian://arcasync` invite and approve links on mobile, device-code approval between phone
   and desktop, and a `requestUrl` binary PUT with Content-Length from `capacitor://localhost`
   (plus the mobile checklist in [testing.md](testing.md)).
7. Decision: keep the per-workspace chunk namespace (no cross-workspace dedup) or move to a
   global content-addressed store with cross-workspace reference counting.
8. Decision: confirm gating `gbSeconds` on the calibrated duration model (billed DO requests ×
   18 ms × 128 MB, from the R-9 probe) instead of the awake-window model. The gate already does
   this; under the awake model scenario B is at about 48% and scenario C (two workspaces per user)
   at about 70%.

## Known limitations

- The plugin has no admin UI to disable or enable a user. The API exists
  (`POST /api/admin/users/:id/disable|enable`); enable returns a re-entry invite bound to that
  user. It works only through the signed-out "Join with an invite" path (accept); a signed-in
  "Join another workspace" (redeem) refuses it with 404.
- Redeeming a re-entry invite through the signed-out "Join with an invite" path still asks for a
  display name (the relay ignores it). This path has no e2e test.
- A disabled user's next ws-token mint answers 401. The plugin retries once and then shows an
  error status; it does not sign the device out locally.
- After a removal, a manual Connect within 60 s can reopen the removed workspace once, because
  `GET /api/auth/me` may still list it (per-isolate cache); the ws-token 404 then stops it again.

## Rollback

Every deploy creates a version. To go back to the previous one:
```sh
pnpm -F @arcasync/relay-cf exec wrangler deployments list --env production
pnpm -F @arcasync/relay-cf exec wrangler rollback --env production            # previous version
pnpm -F @arcasync/relay-cf exec wrangler rollback <version-id> --env production
```
A rollback changes code only. Durable Object storage and secrets stay as they are, so a rollback
across a storage schema change needs care.
