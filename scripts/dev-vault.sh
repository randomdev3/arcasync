#!/usr/bin/env bash
# Creates throwaway dev vaults (dev-vault-a, dev-vault-b) with the built plugin symlinked in.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
for v in a b; do
  VAULT="$ROOT/dev-vault-$v"
  mkdir -p "$VAULT/.obsidian/plugins" "$VAULT/Shared"
  cat > "$VAULT/.obsidian/app.json" <<JSON
{ "readableLineLength": true }
JSON
  echo '["teamsync"]' > "$VAULT/.obsidian/community-plugins.json"
  ln -sfn "../../../packages/plugin/dist" "$VAULT/.obsidian/plugins/teamsync"
  [ -f "$VAULT/Shared/Welcome.md" ] || printf '# Welcome\n\nThis folder is shared via TeamSync.\n' > "$VAULT/Shared/Welcome.md"
  echo "prepared $VAULT"
done
cat <<TXT

Next:
  1. pnpm dev   (Cloudflare relay on http://localhost:8789, plugin watch -> packages/plugin/dist;
                `pnpm dev:node` runs the Node server on http://localhost:8787 instead)
  2. In Obsidian: "Open folder as vault" -> dev-vault-a, then again for dev-vault-b (second window)
  3. Settings -> Community plugins -> enable "TeamSync" (trust the plugin)
  4. Settings -> TeamSync -> server URL http://localhost:8789 -> Dev login as "alice" / "bob"
TXT
