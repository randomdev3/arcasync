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
`.obsidian/plugins/teamsync` and a `Shared/` folder. Then:

1. In Obsidian, use "Open folder as vault" for `dev-vault-a`, and again for `dev-vault-b` (a
   second window).
2. Settings → Community plugins: enable "TeamSync" (trust the plugin).
3. Settings → TeamSync: server URL `http://localhost:8789`, then dev login as `alice` in one
   vault and `bob` in the other. Map the `Shared` folder.

After a plugin rebuild, reload it in Obsidian (disable and enable it, or run "Reload app without
saving").

## Resetting the local relay

The relay's SQLite schema is versioned (`_meta.schema`). Nothing is deployed yet, so there are no
migrations: a relay that finds state from an older schema refuses to start the workspace and
logs `relay state predates schema 2; delete packages/relay-cf/.wrangler/state`. Stop `pnpm dev`,
delete that folder, and start again. Dev logins and synced notes on the relay are lost; the
vaults keep their files.
