# RM Tracker on Railway

Project `rm-tracker` (workspace "tnelson933's Projects"), environment `production`.

| Service | What | Notes |
|---|---|---|
| `Postgres` | Railway PostgreSQL (template) | 50 GB volume. Private network only (no public TCP proxy). |
| `rm-tracker` | API + website, one service | GitHub `tnelson933/RMMX-Tracker`, auto-deploys on push. Volume at `/data/uploads`. |

Public URL: `https://rm-tracker-production-9c47.up.railway.app` (add a custom domain in the
service's Settings → Networking, then update `APP_URL`).

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

## Backups

Enable backups on the `Postgres` service (Railway dashboard → Postgres → Backups). Uploaded
files are on the `rm-tracker` volume. Copy them off occasionally (`railway volume files`).
