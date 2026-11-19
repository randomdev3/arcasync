# Deploying ArcaSync

## VPS with docker-compose

```sh
cp .env.example .env   # edit every "change-me"
docker compose up -d --build
docker compose logs -f server
```

Caddy terminates TLS for `$DOMAIN` and proxies both REST (`/api/*`) and the WebSocket (`/ws`)
to the server. Postgres and MinIO are internal only.

## Railway

1. Create a project; add a **Postgres** service and a **Bucket** (S3-compatible).
2. Add a service from this repo with root Dockerfile path `packages/server/Dockerfile`.
3. Set variables from `.env.example` (`ARCASYNC_DB_URL` = Postgres `DATABASE_URL`, `S3_*` from the
   bucket credentials, `ARCASYNC_PUBLIC_URL` = the generated domain).
4. Generate a domain; health check path `/api/ready`.

## Backups

`pg_dump` nightly plus a bucket mirror (`mc mirror` / `rclone`). See P6 in the roadmap for the
`arcasync export/import` tooling.
