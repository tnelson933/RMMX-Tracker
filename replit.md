# Rocky Mountain ATV/MC Race Platform

A full-stack SaaS race operations platform for motorcycle and ATV clubs — live RFID timing, race scoring, series points, and public results.

## Run & Operate

- `pnpm --filter @workspace/api-server run dev` — run the API server (port 8080)
- `pnpm run typecheck` — full typecheck across all packages
- `pnpm run build` — typecheck + build all packages
- `pnpm --filter @workspace/api-spec run codegen` — regenerate API hooks and Zod schemas from the OpenAPI spec
- `pnpm --filter @workspace/db run push` — push DB schema changes (dev only)
- Required env: `DATABASE_URL` — Postgres connection string, `SESSION_SECRET` — express-session secret

## Desktop App (Electron)

- `pnpm --filter @workspace/desktop run build` — compile Electron main process + preload with esbuild
- `pnpm --filter @workspace/desktop run dist` — build + package as .dmg (Mac), .exe NSIS (Windows), or AppImage (Linux)
- Built artifacts written to `artifacts/desktop/release/`

**Pre-requisites for `dist`:**
1. `pnpm --filter @workspace/local-server run build` — build the local Express server (bundled into the app)
2. `pnpm --filter @workspace/race-platform run build` — build the web frontend (served from local server)
3. Place icon files in `artifacts/desktop/assets/` — `icon.icns` (Mac), `icon.ico` (Win), `icon.png` (Linux, 512×512)

**How it works:** The desktop app spawns the local-server Express process on `localhost:9090`, opens a BrowserWindow loading that URL, manages native serial/USB RFID readers via `serialport`, and maintains a real-time cloud sync queue backed by SQLite. Credentials are stored encrypted via Electron `safeStorage`.

**Cloud sync endpoints added to the cloud API:**
- `POST /api/clubs/:clubId/desktop-push` — receive write-queue batches from the desktop
- `POST /api/clubs/:clubId/sync-pull` — send new cloud rows to the desktop (watermark-based)

## Stack

- pnpm workspaces, Node.js 24, TypeScript 5.9
- API: Express 5 + express-session (server-side sessions)
- DB: PostgreSQL + Drizzle ORM
- Validation: Zod (`zod/v4`), `drizzle-zod`
- API codegen: Orval (from OpenAPI spec)
- Build: esbuild (CJS bundle)
- Frontend: React + Vite + wouter + TanStack Query + shadcn/ui + Tailwind + framer-motion

## Where things live

- `lib/db/src/schema/index.ts` — DB schema (10 tables: clubs, users, events, riders, registrations, checkins, rfid_assignments, motos, race_results, event_publication, series, series_points)
- `lib/api-spec/openapi.yaml` — OpenAPI spec (source of truth for API contract)
- `lib/api-client-react/src/generated/` — generated hooks and Zod schemas (run codegen to update)
- `artifacts/api-server/src/routes/` — all Express route handlers
- `artifacts/race-platform/src/pages/public/` — public consumer pages (no login)
- `artifacts/race-platform/src/pages/organizer/` — club organizer pages (login required)
- `artifacts/race-platform/src/App.tsx` — frontend router

## Architecture decisions

- **Contract-first API**: OpenAPI spec → Orval codegen → typed React Query hooks used everywhere in the frontend. Never call fetch directly in pages.
- **Server-side sessions**: express-session with SESSION_SECRET; session userId stored as `(req.session as any).userId`. No JWT.
- **Two-portal design**: Public consumer app (no auth) and Organizer Portal (club-scoped login) share the same React SPA; route auth is enforced by `ProtectedRoute` in App.tsx.
- **Event publication is separate from event status**: `event_publication` table controls whether results appear publicly; event `status` field tracks operational state (draft → registration_open → race_day → completed).
- **Results public filter**: Public results page filters for `status: 'completed'` events. Do not filter for `results_published` — that is not a valid event status value.

## Product

- **Public App**: Home page with events by state and recent results; Race Results browser by state/event; Event Results with per-class moto standings; Series Leaderboard with championship points
- **Organizer Portal**: Dashboard with club stats; Events management (create/edit/publish); Event detail with tabs for Registrations, Check-in, Motos, Enter Results, Report; Riders list + detail; RFID assignment management; Series & points management

## Seed data (dev)

- 3 clubs, 3 users, 10 riders, 4 events, registrations, checkins, motos, results, series, series_points
- Organizer login: `jake@desertstormmx.com` / `password123` (Desert Storm MX Club, clubId=1)
- Organizer login: `sarah@rockymtnriders.com` / `password123` (Rocky Mountain Riders, clubId=2)
- Event 4 (Spring Opener 2026, AZ, completed) has motos and results — the main demo event
- Event 1 (Desert Classic, AZ, race_day) has registrations and check-ins
- Rider portal logins (all password `Rider123!`): `tyler@email.com` (6 results), `marcus@email.com` (5), `blake@email.com` (5), `devon@email.com` (4), `brett@email.com` (4), `jaxon@email.com` (4)

## User preferences

_Populate as you build — explicit user instructions worth remembering across sessions._

## Gotchas

- `pnpm --filter @workspace/race-platform run typecheck` not `build` — build needs PORT/BASE_PATH env vars wired by workflow
- queryKey TypeScript issue in generated hooks: cast options with `as any` e.g. `{ query: { ... } as any }` in all pages
- Public Results page must filter `status: 'completed'`, NOT `results_published`
- API server runs on port 8080; all routes prefixed with `/api` at `app.ts` level (route files do not include `/api`)
- Session is cookie-based; the 401 on `/api/auth/me` on public pages is expected and intentional

## Pointers

- See the `pnpm-workspace` skill for workspace structure, TypeScript setup, and package details
