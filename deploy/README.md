# Self-hosting RM Tracker (test server)

Runs the cloud API, the website and PostgreSQL with Docker Compose. Caddy serves
the site and forwards `/api` to the API on the same origin, which is the job
Replit's router used to do. That includes WebSockets (video, RM Connect) and
unbuffered SSE (live timing).

Not covered here: the rider mobile app's web export (`/rider-app/`), the desktop
installers, and RM Connect. Those still point at `rmmx-tracker.replit.app` until
they are rebuilt for the new address.

## 1. Prerequisites

- Docker Engine with Compose v2. On Windows use Docker Desktop. Any x86-64 Linux works.
- Ports 80 (and 443 once you have a domain) reachable from the browsers that will use it.

## 2. Configure

```bash
cp deploy/.env.example deploy/.env
```

Fill in `deploy/.env`. At minimum set `POSTGRES_PASSWORD`, `SESSION_SECRET` and
`APP_URL` (the address people will type, e.g. `http://192.168.1.50`).
Keep `COOKIE_SECURE=false` until the site is on HTTPS.

## 3. Build and start

From the repository root:

```bash
docker compose -f deploy/docker-compose.yml up -d --build
```

## 4. Create the database tables (first time, and after schema changes)

Run this **before anyone logs in**. Logging in creates a `session` table that
drizzle doesn't know about. If drizzle later offers to drop it, that only logs
users out.

```bash
docker compose -f deploy/docker-compose.yml run --rm api sh -c "cd /app && pnpm --filter @workspace/db run push"
```

## 5. First admin account (empty database only)

```bash
docker compose -f deploy/docker-compose.yml run --rm -e BOOTSTRAP_ALLOW_HOST=db api node /app/scripts/dev-bootstrap-admin.mjs you@example.com "Club Name" UT
```

Open the printed `/setup-account` link to choose the password. Skip this step if
you restore a copy of the production database instead.

## 6. Check it

- `http://<server>/api/healthz` should return `{"status":"ok"}`
- `http://<server>/` should load the site
- Logs: `docker compose -f deploy/docker-compose.yml logs -f api`

## Updating to new code

```bash
git pull
docker compose -f deploy/docker-compose.yml up -d --build
```

If the update changed the schema, run step 4 again and **read every prompt**.
Never use `push-force` on a database with real data.

## Data lives in Docker volumes

- `pgdata`: the database
- `uploads`: logos, event images, PDFs (`UPLOADS_DIR`)
- `caddy_data`: HTTPS certificates

Back up `pgdata` (with `pg_dump`) and `uploads` before upgrades.
`docker compose down -v` **deletes** the volumes.

## Going to HTTPS later

Point your domain's DNS at the server and set `SITE_ADDRESS=tracker.example.com`
and `APP_URL=https://tracker.example.com`. Remove `COOKIE_SECURE`, then
`up -d`. Caddy obtains the certificate automatically.
