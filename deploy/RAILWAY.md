# RM Tracker on Railway

Project `rm-tracker` (workspace "tnelson933's Projects"), environment `production`.

| Service | What | Notes |
|---|---|---|
| `Postgres` | Railway PostgreSQL (template) | 50 GB volume. Private network only (no public TCP proxy). |
| `rm-tracker` | API + website, one service | GitHub `tnelson933/RMMX-Tracker`, auto-deploys on push. Volume at `/data/uploads`. |

Public URL: **`https://www.rmroost.com`** (`APP_URL`). DNS is at Network Solutions: `www` is a CNAME
to Railway, and the bare `rmroost.com` forwards to `www`, because Network Solutions can't CNAME the
bare domain. The bare domain is also added on Railway, pending, in case DNS moves to Cloudflare.
The Railway address `https://rm-tracker-production-9c47.up.railway.app` still works.

App builds point at `www.rmroost.com`: the rider app via `EXPO_PUBLIC_DOMAIN` in `eas.json`, and
desktop/RM Connect via the GitHub repo variable `CLOUD_URL`.

## How it runs

`deploy/Dockerfile.railway` builds the API and the website. `WEB_DIST_DIR` makes the API also
serve the built site, so `/api`, WebSockets (video, RM Connect) and live-timing SSE share one
origin with no proxy. Health check: `/api/healthz`.

Service settings live in Railway, **not** in a repo file. `railway.json` was ignored by this
project, and Railway is retiring config-as-code files. The settings:

- Variable `RAILWAY_DOCKERFILE_PATH=deploy/Dockerfile.railway` (plus the same Dockerfile path in settings)
- Health check path `/api/healthz`, timeout 120 s
- Replicas: **1**. Live timing keeps per-moto locks, SSE clients and relays in process memory,
  so never scale this service above one replica.
- Restart policy: on failure, 10 retries

## Variables (`rm-tracker` service)

| Name | Value |
|---|---|
| `DATABASE_URL` | `${{Postgres.DATABASE_URL}}` (private network) |
| `SESSION_SECRET` | random, set at creation. Don't change it, or everyone is logged out. |
| `APP_URL` | the public URL (used in emails and Stripe return links) |
| `PORT` | `8080` |
| `LOG_LEVEL` | `info` |
| `STRIPE_SECRET_KEY`, `STRIPE_PUBLISHABLE_KEY`, `STRIPE_WEBHOOK_SECRET` | add when ready (test keys first) |
| `RESEND_API_KEY`, `EMAIL_FROM` | add to send real emails; without them setup/reset links are only logged |
| `ANTHROPIC_API_KEY`, `OPENAI_API_KEY` | Rocky, AI mechanic, points-table AI, announcer voice |

Set secrets in the Railway dashboard (service → Variables), never in chat or in the repo.

## Database schema

Schema changes are applied with `drizzle-kit push` (`pnpm --filter @workspace/db run push`).
The first deploy ran it once as a pre-deploy command, which was then removed. For later schema
changes, review the diff first: do not add push back as a permanent pre-deploy step, because a
push that wants to drop or rename something would run unattended against production data.

## First admin account

On an empty database, create the first super admin with `scripts/dev-bootstrap-admin.mjs`. It
needs network access to the private database, so run it inside the service (Railway SSH, or a
one-time pre-deploy command):

```bash
BOOTSTRAP_ALLOW_HOST=postgres.railway.internal node /app/scripts/dev-bootstrap-admin.mjs you@example.com "Club Name" UT
```

It prints a one-time `/setup-account` link built from `APP_URL`.

## Restoring the Replit production database

Rehearsed locally on 2026-10-26 with Replit's `pg_dump -Fc --no-owner --no-acl
--exclude-table-data=session` export (PostgreSQL 16, 40 tables, 5,285 rows). All row counts
matched, and the site and API worked on the restored data.

1. In Railway, turn on **Public Networking** (TCP proxy) for the `Postgres` service. The database
   is private-only otherwise.
2. Replace the placeholder data, restore and upgrade the schema (from a machine with PostgreSQL 17+
   client tools):
   ```bash
   psql "$RAILWAY_PUBLIC_DB_URL" -c 'DROP SCHEMA public CASCADE; DROP SCHEMA IF EXISTS _system CASCADE; CREATE SCHEMA public;'
   pg_restore --no-owner --no-acl --exit-on-error -d "$RAILWAY_PUBLIC_DB_URL" production.dump
   psql "$RAILWAY_PUBLIC_DB_URL" -v ON_ERROR_STOP=1 -f deploy/migrations/2026-10-26-replit-prod-to-current.sql
   ```
   Use the reviewed SQL, **not** `drizzle-kit push`. Push would drop the `session` table and an
   existing foreign key.
3. Check the row counts against the export's `row-counts.csv`, then redeploy `rm-tracker`.
4. Turn Public Networking **off** again.

People sign in with their existing Replit accounts. The bootstrap admin created on the empty
database is replaced.

Uploaded images don't come across. The 12 files that production references (11 past event
images and 1 club logo) already fail to load on the live Replit site, so organizers re-upload them.

A rehearsal restore must not run while Replit is still live: the copy holds real rider emails and
push tokens. Do the real restore at cutover, from a fresh export taken with registrations paused.

## Backups

Enable backups on the `Postgres` service (Railway dashboard → Postgres → Backups). Uploaded
files are on the `rm-tracker` volume. Copy them off occasionally (`railway volume files`).
