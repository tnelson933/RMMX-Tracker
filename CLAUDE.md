# RM Tracker — instructions for continuing development

Read `docs/claude-handoff/START_HERE.md`, then
`docs/claude-handoff/APP_CONTEXT.md` before making changes.
The remaining handoff documents cover setup, migration, verification, and unfinished work.

## Preserve the existing product

This is an existing race operations system, not a starter project.
It includes the organizer/public web app, cloud API, rider mobile app,
offline local server, Electron desktop app, and RM Connect timing bridge.
Do not replace these with a new scaffold, switch authentication providers,
change databases, or redesign unrelated screens without the owner's approval.

## Development rules

- Use pnpm 10.26.1. Preserve the workspace and package boundaries.
- Treat `lib/api-spec/openapi.yaml` as the generated client's contract.
  After contract changes, run `pnpm --filter @workspace/api-spec run codegen`.
  Do not fix generated files by hand.
- Cloud PostgreSQL and local SQLite must remain compatible at the API boundary.
  Review both servers when changing race-day operations or sync payloads.
- Preserve organizer club isolation, staff permissions, rider account/profile separation,
  payment ownership, signed-waiver records, and race history.
- Registration rows are class entries, not necessarily unique riders.
  Do not conflate entry counts, people, and distinct registration emails.
- Race event status and public result publication are separate concerns.
- The dashboard is an account overview. Check-in belongs to an individual event,
  not an account-wide summary card.
- Preserve timing serialization, SSE baseline handoff, active-transponder routing,
  timestamp normalization, and announcer monotonic sequencing. See the included
  `.agents/memory/` notes and `docs/claude-handoff/APP_CONTEXT.md`.
- Active timing customer-facing terminology is vendor-neutral.
- Update `artifacts/api-server/src/routes/anthropic/SYSTEM_PROMPT.md` when shipping
  organizer-facing capabilities that Rocky needs to understand.
- Keep secrets out of source, chat, exports, client build variables, and logs.
  The environment reference contains names only.
- Review data-changing scripts before running them. Do not run seeds, imports,
  `push-force`, synchronization, or production schema changes as setup shortcuts.
- Verify changes with appropriate typechecks, tests, builds, and API checks.
  A mocked browser test or successful bundle does not prove real-device or production behavior.
- Keep existing deployments, signing identities, Expo app identifiers, and provider
  accounts intact until an approved migration is tested. Do not trigger a release
  merely because these instructions mention one.

## Outside Replit

The export contains the source, not Replit's runtime, credentials, cloud database
contents, or storage bucket. Set up a same-origin `/api` reverse proxy for the
website; support WebSocket upgrades and unbuffered SSE. Adapt object storage
and AI credentials before calling those integrations portable.

Do not assume `replit.md` or historical plans are current. The code and current
owner instructions win. See the handoff's known discrepancies.

## Local development on this machine (Windows, no Replit)

Production still runs on Replit (`rmmx-tracker.replit.app`); this checkout is for
development only. All commands run from the repo root (`RM-Tracker/`).

- `pnpm run db:start` / `db:stop`: portable PostgreSQL 17 (binaries in
  `%LOCALAPPDATA%\pgsql17`, data in gitignored `.local-pg/`, localhost only, trust auth).
  `db:init` already ran and created `rmtracker_dev`. Schema is applied with
  `pnpm --filter @workspace/db run push` (needs `DATABASE_URL` exported in the shell).
- `pnpm run dev:api`: builds and runs the API on 8080. `pnpm run dev:web`: Vite on 19869,
  proxying `/api` (including WebSockets) to the API through `DEV_API_PROXY`. Open
  **http://rmtracker.localhost:19869**, not 127.0.0.1 or localhost. Some pages
  (StripeConnect, OfflineMode, LiveBroadcast) treat those hostnames as the offline
  desktop app. `APP_URL` in `.env` must match, because it builds Stripe return URLs.
- Stripe: the local `.env` uses a **test-mode** restricted key. Dev Club (#1000) is
  onboarded to Connect in test mode, and test event 1 has a paid test registration.
  Local test organizer: `.local-pg/e2e-credentials.txt` (gitignored). Payments are
  destination charges with no `application_fee_amount`: the club gets the full fee
  and the platform's Stripe balance pays the processing fees. Both are launched by `scripts/dev-local.mjs`, which loads the
  root `.env` (gitignored; template `.env.example`). AI env vars are placeholders, so
  Rocky/AI/TTS routes fail locally until real keys are configured.
- `node scripts/dev-bootstrap-admin.mjs [email] [club] [state]`: creates the first
  super_admin and club in the local DB and prints a one-time `/setup-account` link.
  It refuses to run against a non-localhost database.
- `node scripts/dev-sample-data.mjs <organizer-email> <password> [clubId]`: fills the local
  DB with 2 completed demo events, 12 riders and a series. It publishes results and
  recalculates points through the running API. Local only, and does nothing on a second run.
- API access is default-deny (`artifacts/api-server/src/middleware/accessControl.ts`): a new
  route needs an organizer session unless it's added to `PUBLIC_RULES`, and organizers are
  scoped to their club through `res.locals.staffClubId`. After auth changes, run
  `node scripts/dev-security-check.mjs e2e-organizer@local.test other-organizer@local.test <pw> 7`
  (club 2000 / event 7 is a local-only second club for cross-club checks).
- Branding follows the claude.ai org design system "Rocky Mountain ATV/MC Design System"
  (Barlow/Roboto, red `#B30000`, charcoal `#242424`, pill buttons). Theme tokens live in
  `artifacts/race-platform/src/index.css`; brand assets are in `race-platform/public/brand/`.
  The brand red is only ~2.1:1 on charcoal, so don't use it as text on dark surfaces.
- Windows-only adaptations: `pnpm-workspace.yaml` stops excluding the win32-x64 esbuild,
  rollup, lightningcss and tailwind-oxide binaries (Linux deploys are unaffected), and
  `lib/db/drizzle.config.ts` uses forward slashes in the schema path.
- `better-sqlite3` is **not built**, because no Node 24 prebuild exists for v11 and no
  MSVC is installed. local-server, desktop and SQLite scripts won't run until Visual
  Studio C++ Build Tools are installed and `pnpm rebuild better-sqlite3` succeeds.
  Install with `pnpm install --ignore-scripts`, then `pnpm rebuild` the other native deps.
- Unit tests (from the `scripts/` directory, where `tsx` is installed):
  `./node_modules/.bin/tsx --test ../artifacts/api-server/src/lib/*.test.ts ../artifacts/race-platform/src/lib/*.test.ts`.
  59/61 pass on Windows. The two `videoRelay` timing tests fail, and the run doesn't exit
  on its own (open handles). Connector tests (`node test.mjs`) pass.
- The package `dev`/`start`/`test:browser` scripts are POSIX/Replit-specific. Use the
  root `dev:*` scripts here and leave the originals as they are for Replit.
