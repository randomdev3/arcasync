# ArcaSync

Real-time team collaboration for Obsidian with a single self-hosted server.

Google-Docs-grade co-editing, presence with jump-to-user and follow mode, named version history
with author attribution, full-vault sync (including binaries), and live multi-user Excalidraw.

Working today (P2): invite and device-code sign-in with owner tools, live role changes, attachments
synced through R2 chunks, 3-way merge of offline note edits, several workspaces per vault, and bulk
clone for devices that are far behind.

## Layout

| Package | Role |
|---|---|
| `packages/shared` | Protocol schemas (zod), doc naming, file kinds, hashing |
| `packages/server` | Node server: Hono REST + Hocuspocus sync, Postgres/PGlite, S3/fs blobs |
| `packages/plugin` | Obsidian plugin (esbuild + Svelte 5) |
| `deploy/` | docker-compose / Railway deployment |

## Development (zero external services)

```sh
pnpm install
pnpm dev            # server on :8787 with embedded PGlite + local blob store, plugin in watch mode
bash scripts/dev-vault.sh   # creates dev-vault-a/ and dev-vault-b/ with the plugin symlinked
```

Open each dev vault in Obsidian ("Open folder as vault"), enable community plugins, connect both to
`http://localhost:8787` via Settings → ArcaSync.
