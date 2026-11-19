# Development setup

Requirements: Node 22.13 or newer and pnpm (the version pinned in the root `package.json`).
Every command runs from the repository root.

```sh
pnpm install
pnpm dev
```

`pnpm dev` runs two things through turbo, after building `@arcasync/shared`:

- **The Cloudflare relay** (`@arcasync/relay-cf`): `wrangler dev --env dev` on
  `http://localhost:8789`. It uses the public dev secret, open dev login and the debug endpoints
  (`/api/debug/stats`, `/api/debug/doc`), so it is for local use only. Local Durable Object state
  lives in `packages/relay-cf/.wrangler/state`.
- **The plugin in watch mode** (`@arcasync/plugin`): rebuilds into `packages/plugin/dist` on
  every change.

`pnpm dev:node` runs the Node server on `http://localhost:8787` instead of the relay. It is the
conformance oracle and self-host option; new relay features (attribution, keepalive, presence
renewal) exist only on the relay.

## Dev vaults

```sh
bash scripts/dev-vault.sh
```

This creates `dev-vault-a/` and `dev-vault-b/`, each with the built plugin symlinked into
`.obsidian/plugins/arcasync` and a `Shared/` folder. Then:

1. In Obsidian, use "Open folder as vault" for `dev-vault-a`, and again for `dev-vault-b` (a
   second window).
2. Settings → Community plugins: enable "ArcaSync" (trust the plugin).
3. Settings → ArcaSync: server URL `http://localhost:8789`, then dev login as `alice` in one
   vault and `bob` in the other. Map the `Shared` folder.

After a plugin rebuild, reload it in Obsidian (disable and enable it, or run "Reload app without
saving").

## Real sign-in against the dev relay

Dev login is the quick path, but `env.dev` also runs the production sign-in flow. Its bootstrap
token is public (`ARCASYNC_BOOTSTRAP_TOKEN` in `packages/relay-cf/wrangler.jsonc`):
```sh
curl -s -X POST http://localhost:8789/api/auth/bootstrap \
  -H "Authorization: Bearer arcasync-local-dev-bootstrap-token-not-secret-0" \
  -H "Content-Type: application/json" -d '{"workspaceName":"Team"}'
```
The response's `invite.url` makes its redeemer owner of `Team` and server admin. Paste it into
Settings → ArcaSync → "Join with an invite" in `dev-vault-a`, with a display name. Bootstrap
works once per relay state (then `409`); delete `packages/relay-cf/.wrangler/state` to start
over.

To bring in the second vault, either:
- run "Create an invite link" in `dev-vault-a` and paste the link into `dev-vault-b` (a new
  user), or
- in `dev-vault-b`, choose "Sign in with another device", then run "Approve a device sign-in" in
  `dev-vault-a` with the code it shows (the same user on a second device).

## Several workspaces in one vault

A vault can map one folder per workspace of the same relay. To put a dev user in a second
workspace, either redeem an owner's invite for it ("Join another workspace"), or dev-login the
same name with a `workspace` slug, which creates or joins that workspace (the e2e harness's
`ctx.api` does this):
```sh
curl -s -X POST http://localhost:8789/api/auth/dev-login -H "Content-Type: application/json" \
  -d '{"name":"alice","workspace":"second","device":{"name":"curl","platform":"macos","vaultId":"curl"}}'
```
Then, under Settings → ArcaSync → Shared folders, "Add folder" maps a folder to each
workspace. Each mapped workspace gets its own socket, and the status bar shows `<primary> +k`.
Removing a mapping stops that workspace's sync and keeps the files.

## Resetting the local relay

The relay's SQLite schema is versioned (`_meta.schema`). Nothing is deployed yet, so there are no
migrations: a relay that finds state from an older schema refuses to start the workspace and
logs `relay state predates schema 2; delete packages/relay-cf/.wrangler/state`. Stop `pnpm dev`,
delete that folder, and start again. Dev logins and synced notes on the relay are lost; the
vaults keep their files.
