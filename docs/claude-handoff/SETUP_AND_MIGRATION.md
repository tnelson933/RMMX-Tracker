# Setup and migration guide

## 1. Choose the first goal

The least risky transition is to move programming to Claude first, get a local
development environment working, and leave the live service intact. Moving
hosting, data, DNS, installed clients and payment callbacks is a second step.

No deployment, DNS, database import, or provider account transfer has been
performed by generating this package.

## 2. Runtime and dependencies

- Cloud/web tooling was observed running Node 24.13.0 with pnpm 10.26.1.
- Mobile EAS production builds intentionally pin Node 20.19.4; do not blindly
  apply the cloud Node version to mobile builders.
- PostgreSQL is required for the cloud API.
- Python/build tools are needed for some native Electron/SQLite dependencies.
- Platform installers require the existing macOS/Windows CI or equivalent
  operating-system runners; an installer is not built by a web build.

From an extracted source directory:

```bash
corepack enable
corepack prepare pnpm@10.26.1 --activate
pnpm install --frozen-lockfile
```

**Important portability issue:** `pnpm-workspace.yaml` intentionally excludes
many non-Linux-x64 optional binaries. On macOS, Windows, Linux ARM, or musl,
have Claude make a reviewed change to remove only incompatible platform-exclusion
overrides and regenerate the lockfile with pnpm. Existing installer workflows
already contain platform-specific adaptations, but their text matching may
not cover every quote style in the current YAML.

Do not remove security overrides or the minimum package release age policy as
an unrelated shortcut. Preserve the native-build allowlist, including
`better-sqlite3`, `serialport`, Electron, and esbuild.

If SQLite native bindings were skipped:

```bash
pnpm rebuild better-sqlite3
```

Use Electron's target ABI for packaged desktop native dependencies, as the
existing release jobs do; a Node-compatible native binary is not automatically
Electron-compatible.

## 3. Configure a disposable development environment

Read `ENVIRONMENT_REFERENCE.md`. Create local secrets through your development
environment's secret facility or a private ignored file. No secret values are
included in the archive.

The API does not automatically load a root `.env` using dotenv.
Set variables in its actual process environment. If adding a dotenv loader,
load it before imports that initialize the database/client libraries.

Core configuration:

- `DATABASE_URL`: a new development PostgreSQL database, not production.
- `SESSION_SECRET`: newly generated random development secret.
- `NODE_ENV=development`.
- API `PORT=8080`.
- Frontend `PORT=19869`, `BASE_PATH=/`.
- `APP_URL`: the public-facing local reverse-proxy origin used by both UI and API.

Create schema **only against the disposable development database**:

```bash
pnpm --filter @workspace/db run push
```

This is a schema write. Review prompts instead of using `push-force`.
No seed script should run automatically. The schema source is included;
production data is not. Model-derived SQL DDL is also generated under
`export-metadata` if schema export succeeds; inspect its export report for
exact status. It is generated from TypeScript models without connecting to a
database and is not a production schema dump.

The session store creates its own session table when necessary. Integration
packages may own additional tables/schemas; inspect them before assuming the
application models are a full database backup.

## 4. Run API and frontend

In separate shells with the correct service-specific environments:

```bash
# API shell: DATABASE_URL and SESSION_SECRET already configured
PORT=8080 NODE_ENV=development pnpm --filter @workspace/api-server run dev

# Web shell
PORT=19869 BASE_PATH=/ pnpm --filter @workspace/race-platform run dev
```

On shells that do not accept POSIX inline assignments, use their native
environment-variable syntax. The API `dev`/`start` scripts also contain POSIX
commands (`export`, `fuser`, `sleep`); on Windows use WSL or adapt the launcher
without changing application behavior.

**Required outside Replit:** configure a local reverse proxy, or add a
development-only Vite `/api` proxy to `http://127.0.0.1:8080` with WebSocket
support. The current Vite configuration relies on Replit for routing and does
not provide this itself. Otherwise requests for `/api` go to the frontend.

Keep the browser-facing app and API same-origin where possible. Cookies,
public registration, generated-client calls, raw fetches, SSE and WebSockets
all need the same coherent origin—not only a single API base-URL override.

Health checks:

```bash
curl -f http://127.0.0.1:8080/
curl -f http://127.0.0.1:8080/api/healthz
```

An unauthenticated `/api/auth/me` returning 401 is expected. A real organizer
account is needed for private screens; no account passwords are supplied.
Have Claude inspect the supported account/admin setup flow or create explicitly
approved development-only fixtures, not a hardcoded auth bypass.

## 5. What specifically needs adaptation off Replit

| Area | Current assumption | Migration work |
| --- | --- | --- |
| Routing | Artifact proxy joins `/`, `/api`, `/rider-app/` | Configure reverse proxy/static hosting and SPA fallback |
| API transport | Same-origin cookies, WS, SSE | Preserve TLS, upgrades, cookie flags, streaming and timeouts |
| Object storage | GCS client authenticates through localhost Replit sidecar | Implement target-provider credentials/client adapter; copy objects and ACL metadata |
| AI | Replit Anthropic/OpenAI proxy base URLs and managed keys | Use target-host server secrets and approved direct/provider-compatible endpoints; verify paths/models |
| Stripe | Direct env keys supported; connector fallback and `stripe-replit-sync` remain | Audit initialization/webhook verification and integration schemas; reconfigure endpoints safely |
| Email | Resend server key and verified sender | Reconfigure server secret and verify sender/domain ownership |
| Public URLs | `APP_URL` and Replit-domain fallbacks | Use a consistent new public origin; review every URL-building caller |
| Web PWA | Service-worker cached production assets | Rebuild, version/update caches deliberately, verify open installed clients update |
| Mobile dev | Script assembles Replit preview/proxy domain settings | Use ordinary Expo dev launcher and valid API hostname |
| Mobile release | EAS config points to current production hostname | Update only after backend migration is ready; preserve signing/project identity |
| Desktop/connector | CI-baked cloud origin and encrypted saved configuration | Rebuild installers if origin changes; document installed-client transition |
| GitHub helpers | Existing repo/release and optional Replit identity assumptions | Authenticate owner-controlled CI/CLI; do not bake personal tokens into source |

### Storage details

`artifacts/api-server/src/lib/objectStorage.ts` uses Replit's local sidecar on
port 1106 for credential exchange and URL signing. Copying bucket names into
environment variables on another server will not make it work.

Preserve `/api/storage...` application routes and `/objects/...` logical paths
where practical, so saved logos, PDFs and waiver-related files do not break.
Copy actual bytes plus content types and access-control metadata. Validate
private-object access; do not make the entire bucket public.

### Stripe details

`stripeClient.ts` supports `STRIPE_SECRET_KEY` or legacy `Stripe_secret_key`.
That does not prove every `stripe-replit-sync` behavior is portable.
The webhook handler currently delegates to that package, not a new plain
`stripe.webhooks.constructEvent` implementation.

The raw webhook route `/api/stripe/webhook` is mounted before JSON parsing.
Preserve it. Inspect the package's expected signing/initialization setup before
configuring webhooks elsewhere. Do not invent support for a signing-secret
environment variable the existing source never reads.

### Mobile details

The app constructs `https://${EXPO_PUBLIC_DOMAIN}`. Supply a hostname without
the scheme or a trailing path. Local development on a physical phone needs a
reachable HTTPS API hostname unless Claude deliberately adapts transport for
development. `localhost` on a phone means the phone.

`artifacts/rider-app/eas.json` contains the existing release-domain configuration.
Google client configuration is not a service-account private key, but push/
store credentials remain separately managed. No signing private keys are included.

## 6. Build and serve outside Replit

After typechecks:

```bash
pnpm --filter @workspace/api-server run build
PORT=19869 BASE_PATH=/ pnpm --filter @workspace/race-platform run build
NODE_ENV=production PORT=8080 node --enable-source-maps artifacts/api-server/dist/index.mjs
```

Set the API secrets in its process environment before the last command.
Serve `artifacts/race-platform/dist/public` from a static server with fallback
to `index.html` for SPA routes, but **never** rewrite `/api` traffic to that file.
Terminate TLS and forward `/api` to the API, including WebSocket upgrades.
Ensure SSE is unbuffered and long-lived connections are supported.

For offline builds:

```bash
pnpm --filter @workspace/local-server run build
PORT=9090 BASE_PATH=/ pnpm --filter @workspace/race-platform run build
pnpm --filter @workspace/desktop run build
pnpm --filter @workspace/connector run build
```

Use a persistent `SQLITE_FILE` and the correct `STATIC_FILES_DIR` for standalone
local-server operation. Cloud sync configuration is separate and can write data;
do not start sync against production merely to test the server.

## 7. Live data and provider transfer checklist

These steps are **not completed by this source export**:

1. Confirm which data is authoritative: production PostgreSQL, development
   PostgreSQL, and/or offline databases awaiting synchronization.
2. Back up source databases privately. A full database backup can contain rider
   personal information, password hashes, mobile/sync tokens and sessions.
   Do not attach it to a normal Claude chat or public repository.
3. Obtain a production backup through an authorized, secure database connection
   or provider export. A development `pg_dump` is not production.
4. Verify schema, custom types, indexes, constraints, sequences, integration
   schemas and counts, not just CSVs of visible application tables.
5. Restore to an isolated target and test. Decide which sessions/tokens to
   invalidate; preserve the records and IDs needed by installed clients.
6. Copy App Storage objects and verify referenced files against the restored DB.
   Also inspect any older local uploads or desktop-only files for required data.
7. Transfer server secrets privately into the new host's secret manager.
   Replit-managed short-lived integration credentials are not transferable keys.
8. Preserve Stripe accounts, webhook behavior, Resend verification, Expo/EAS
   identity, push credentials, GitHub CI permissions and signing ownership.
9. Run the verification checklist with production-like data and test-mode payments.
10. Plan a write freeze/final delta sync and rollback window before cutover.
11. Update URLs/DNS, payment and email callbacks, mobile configuration, and desktop/
    connector distribution with owner approval.
12. Verify after cutover and retain the old system/backups until sign-off.

Do not use an unreviewed `drizzle-kit push` to align a restored production
database. Establish a backup-backed, reviewed target-host migration process.
While production remains Replit-managed, continue using its supported publish
schema flow instead of writing startup migration code.

Platform export references consulted during handoff:

- https://docs.replit.com/help/projects-and-files
- https://docs.replit.com/features/data-and-storage/object-storage
- https://docs.replit.com/teams/identity-and-access-management/manually-copy-projects
