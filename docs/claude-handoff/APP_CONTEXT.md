# RM Tracker — application context

## 1. Product and users

RM Tracker is a race-operations platform for motorcycle and ATV clubs.
The repository also uses the names RMMX Tracker, Rocky Mountain Race Platform,
and Rocky Mountain ATV/MC Race Platform.

The system supports event administration and rider registration before an event,
check-in and timing during an event, and published results and championship
points afterward. It has cloud and offline workflows because race venues may
have unreliable internet.

Primary users:

- **Club organizers/promoters:** manage their club, events, riders, staff,
  registration, fees, waivers, race schedules, timing, results, and communications.
- **Club staff:** use permission-scoped organizer functions.
- **Platform administrators:** manage clubs, users, and platform communications.
- **Riders and families:** maintain one or more rider profiles, register, review
  race information/results, and use the rider app.
- **Spectators:** browse public results, live timing, broadcasts, and series points.
- **Timing operators:** connect readers, run motos/practice, and operate offline tools.

## 2. Stack and repository map

This is a pnpm 10.26.1 TypeScript monorepo. Root `package.json`,
`pnpm-workspace.yaml`, `pnpm-lock.yaml`, and TypeScript project references are
part of the application, not incidental editor files.

| Component | Current implementation |
| --- | --- |
| Web | React 19.1, Vite 7, wouter, TanStack Query 5, Tailwind 4, shadcn/Radix UI, Framer Motion |
| Cloud API | Express 5, TypeScript, esbuild ESM output, pino logging |
| Cloud data | PostgreSQL, `pg`, Drizzle ORM, drizzle-zod |
| API contract | OpenAPI YAML, Orval-generated React client and Zod schemas |
| Organizer authentication | Existing email/password + bcrypt + express-session, PostgreSQL session store |
| Rider authentication | Rider-account authentication; web sessions and mobile bearer tokens |
| Offline API | Express, better-sqlite3, local schema/init and sync |
| Desktop | Electron, esbuild, electron-builder, native serial/USB support, encrypted credential storage |
| Timing bridge | Separate Electron tray app; TCP/serial hardware adapters and cloud connection |
| Mobile | Expo SDK 54 / React Native 0.81, Expo Router, secure storage/biometrics, notifications |
| Email | Resend via server-side API key |
| Payments | Stripe Checkout and club-scoped Stripe Connect Express |
| AI | Rocky organizer assistant and rider AI capabilities; Anthropic/OpenAI integration code |
| Files | Replit App Storage using Google Cloud Storage client and Replit sidecar credentials |
| Realtime | Server-Sent Events for timing, WebSockets for video and connector communication |

Repository responsibilities:

- `artifacts/api-server/src/app.ts`: logging, trust proxy, raw Stripe webhook,
  body parsing, sessions, staff-permission middleware, `/api` mount.
- `artifacts/api-server/src/index.ts`: HTTP server, WebSocket attachment,
  required port, and startup state normalization.
- `artifacts/api-server/src/routes/`: feature routes; nested `anthropic/`
  contains Rocky's prompt and assistant integration.
- `artifacts/race-platform/src/App.tsx`: SPA routes and authentication boundaries.
- `artifacts/race-platform/src/pages/{public,organizer}/`: main web experiences.
- `artifacts/race-platform/src/contexts/`: session/UI/broadcast state.
- `artifacts/race-platform/src/lib/`: timing/audio/announcer/video client policies.
- `artifacts/rider-app/app/`: Expo file-based routes.
- `artifacts/rider-app/context/AuthContext.tsx`: rider mobile account, profiles,
  token persistence, biometrics, and authenticated fetch.
- `artifacts/local-server/src/`: SQLite API, auto-sync, and standalone sync.
- `artifacts/desktop/src/`: desktop host, sync engine, hardware, preload/IPC.
- `artifacts/connector/src/`: RM Connect host, cloud transport, reader protocols.
- `lib/db/src/schema/`: authoritative application database model definitions.
- `lib/api-spec/openapi.yaml`: API contract; `orval.config.ts` is the generator config.
- `lib/api-client-react/src/generated/`: generated typed calls, hooks, and models.
- `lib/api-zod/src/generated/`: generated validation schemas/types.
- `lib/integrations*`, `lib/object-storage-web`: reusable integration/client utilities.

Use `export-metadata/WORKSPACE_PACKAGES.json` for actual package scripts and
`export-metadata/SOURCE_TREE.txt` for the exported file map.

## 3. Main feature areas

### Organizer and administration

- Club profile, logo, contact details, club identifier, account dashboard.
- Event creation/editing, tracks, race classes, multi-day events, registration
  windows, event settings, fees, capacity, required waivers and transponders.
- Rider records, profile/bike information, class entries, bib/RFID/transponder assignment.
- Registration management, payment status, discounts, comp codes, fee categories,
  exports, liability-waiver records, and check-in.
- Staff/team access and permissions; platform-level club/user administration.
- Series definitions, class mappings, points tables, and series points.
- Organizer notifications and rider notification preferences.
- Rocky assistant grounded in the application prompt/context.

### Race operations

- Practice sessions, race schedules, moto creation/run order, gate workflows,
  manual results, timing crossings, race-day displays, and reports.
- Passive RFID and active-transponder timing paths.
- Timing reader assignment and ingest, multi-checkpoint/enduro timing/scoring.
- Live leaderboards, audio feedback and shared announcements, public views.
- Live video broadcasting and viewing.
- Offline data packages, local operation, queued changes, and cloud reconciliation.

### Public web and rider web

Important routes include:

| Route | Purpose |
| --- | --- |
| `/` | Public event/result browsing and download links |
| `/results`, `/results/:eventId` | Published event results |
| `/leaderboard` | Series championship points |
| `/register/:eventId` | Public event registration |
| `/live/:motoId` | Live moto view |
| `/watch/:eventId` | Event broadcast/live view |
| `/widget/:eventId`, `/widget/series/:seriesId` | Embeddable views |
| `/login`, `/setup-account`, `/forgot-password` | Organizer account access |
| `/rider/login`, `/rider/portal` | Rider web account/profile portal |
| `/dashboard` | Organizer account overview |
| `/events/:eventId/...` | Event-specific operations |
| `/rfid/setup`, `/rfid`, `/practice` | Hardware, assignments, practice |
| `/gate`, `/gate-mobile`, `/race-day-display` | Operations displays |
| `/offline-mode`, `/offline/sync` | Offline workflows |
| `/payments`, `/discount-codes` | Club payments and discounts |
| `/notifications`, `/team`, `/staff` | Communications and access |
| `/admin/...` | Platform administration |
| `/privacy`, `/delete-account` | Public privacy/deletion surfaces |

Refer to the router for the full current list and exact access rules.

### Rider mobile app

The Expo app includes home, upcoming/my races, results, profile and rider
management, event/result/rider detail, organizations, notifications integration,
RM Cash, training, mechanic assistance, bike maintenance, and maintenance history.
Multiple rider profiles can belong to a rider account.

The presence of a screen does **not** imply every displayed feature is fully
backed by production data. For example, replacing hardcoded RM Cash transaction
history was a proposed work item; verify the implementation before claiming it works.

Preserve existing bundle/package IDs and EAS project identity when moving tooling.
The app's release version is in `artifacts/rider-app/app.json`, not the placeholder
workspace package version.

## 4. Data model and invariants

The schema is larger than the old table list in `replit.md`. Read all modules
exported by `lib/db/src/schema/index.ts`. Major groups include:

- Clubs, users, club settings, tracks, staff relationships/settings.
- Events, riders, registrations, check-ins, RFID assignments, readers and
  event-reader assignments.
- Motos, lap crossings, race results, publication, series, series points and points tables.
- Practice sessions/crossings, enduro checkpoint arrivals and time checks.
- Discount categories, comp codes, waiver signatures and setup/reset tokens.
- Rider accounts, bikes, mobile tokens, push tokens, notification preferences.
- Rider maintenance/history, conversations/messages, notification logs,
  quick-checkin notifications and offline rider identities.
- PostgreSQL session storage and possible integration-owned schemas are runtime
  concerns beyond application model exports.

Domain rules to preserve:

1. **Club isolation:** organizer actions are club-scoped. Staff permissions and
   platform administrator rights are not interchangeable.
2. **Entries versus people:** a rider can have multiple registration/class rows.
   A rider account, rider profile, class entry, and check-in are distinct.
3. **Void entries:** do not count void registrations as active entries in next-event
   alerts or race-day counts that explicitly exclude them.
4. **Publication versus status:** result publication is separate from operational
   event status. `results_published` is not an event status. Public result browsing
   uses completed events and the relevant publication logic.
5. **Multi-day events:** end dates matter for upcoming/in-progress event selection;
   do not reduce all events to their first day.
6. **Waivers:** standard registration acknowledgments and signed liability waivers
   are separate models. Preserve signature records, guardian/minor semantics,
   and linkage to registrations.
7. **Payments:** each club owns its Stripe connected account and receives its own
   payouts. The platform secret is not an organizer input. Preserve the connected
   account destination when creating payment sessions.
8. **Cloud/local parity:** JSON field shapes, booleans, numeric fees, nullable values,
   registration identities and sync ordering must remain compatible across
   PostgreSQL and SQLite. Text money values must not crash `.toFixed()` consumers.
9. **Mobile identity:** preserve account/profile separation and token revocation.
   Database exports containing token/session tables are sensitive.
10. **Dashboard scope:** the organizer dashboard is an account overview, not a
    combined event check-in screen.

## 5. Timing and hardware behavior that must not regress

Read the detailed `.agents/memory/` notes before modifying these areas.
They are lessons from earlier debugging, not substitutes for inspecting current code.

- **Active-transponder requirements:** evaluate the current event requirement
  server-side; stale browser event state must not reject an otherwise valid registration.
  Assignment must keep registration/rider identities and check-in display state aligned.
- **Vendor-neutral naming:** active timing is intended for white-label distribution.
  It is white-labeled as **RM TrackR**: the reader (hardware model F2000) is the
  "RM TrackR" and its transponders (PowerTags) are "RM TrackR Transponders".
  Customer-facing text never says F2000 or PowerTag; code comments about the
  device protocol still do. Some legacy internal identifiers (mylaps_*) remain.
  MyLaps/AMB decoders are not supported.
- **F2000 readiness:** TCP connection and heartbeats do not prove loops are running.
  Confirm enabled-loop telemetry, respect setup ordering, retry opening loops,
  and own/cancel retry timers correctly.
- **Practice routing:** an armed active reader must not lose crossings because a
  local WebSocket start message was missed. Route through the actual running
  moto or practice on the server; reject idle timing rather than start a test.
  Passive RFID remains connector-gated.
- **Reader timestamps:** device wall-clock values may lack time zones. Preserve
  receipt/source metadata and skew normalization, especially after reconnect.
- **Fastest lap:** exclude partial lap 1 only when `raceStyle === "motocross"`
  (including supercross formatting). Keep that lap in counts, totals and display.
  Enduro and cross-country/desert count lap 1 normally; unknown styles include it.
- **SSE handoff:** initial leaderboard baseline creation/write and subscriber
  registration share the same per-moto serialization lock as crossing ingest.
  A crossing must be in either the no-sound baseline or a live event, never both/neither.
- **Announcer sequence:** durable and monotonic for the lifetime of a moto ID,
  even after race/API restarts. Reset lifecycle markers, not sequence numbering.
- **Video/control frames:** proxies may convert text WS frames to binary.
  Recognize JSON control messages by content instead of only `typeof`.
  Preserve bidirectional application heartbeats and keyframe handling.
- **VP9 recording:** the historical Chrome keyframe issue required an explicit
  keyframe interval. Do not remove that handling without a streaming test.

RM Connect and desktop support multiple hardware paths. Inspect the adapters
and reader setup UI for current capabilities rather than assuming one protocol
fits all readers. Hardware functionality cannot be proved by software builds alone.

## 6. Cloud, local and realtime architecture

The public web app and API are separate services, exposed under one origin:
web at `/`, API under `/api`, rider web export under `/rider-app/`.
Replit's artifact proxy currently supplies that routing. Vite is not configured
with a general API development proxy, so running the frontend alone outside
Replit will not make `/api` work.

The cloud API attaches the video and connector WebSocket relays to the same
HTTP server that serves Express. A reverse proxy must forward the whole `/api`
namespace, preserve upgrade requests, and not buffer SSE responses.

Video/connector relays and some timing coordination use process-local state.
Multiple API replicas require a deliberate shared-state/routing design; do not
assume PostgreSQL-backed sessions alone make the entire service horizontally scalable.

The desktop application runs a local Express API on port 9090, serves a build
of the same web frontend, and uses SQLite and synchronization queues. RM Connect
is a separate tray application connecting timing hardware to the cloud.
Moving the website does not automatically update installed desktops/connectors.

## 7. Current dashboard decisions

The latest requested dashboard shape is:

- Four account-wide summary cards: Upcoming Events, Total Riders,
  Registrations, Unique Registrants.
- Upcoming-event list.
- **Next Event Snapshot:** next selected event's name/date/location, countdown,
  active entries, registrations in the last seven days, paid count,
  capacity percentage when configured, and a manage-registration link.
- **Action Needed:** unpaid entries, missing required waivers, missing required
  transponder numbers, with counts and registration links, scoped to that next event.
- No Recent Activity rail and no Total Checked In summary card.

The API still returns legacy `recentActivity` and `checkedInToday` fields for
compatibility; their presence does not mean they should be displayed.

Alert rules:

- Exclude void registrations.
- Payment alert only if payment is enabled.
- Waiver/transponder alert only when required.
- Liability waiver completion uses a signature tied to the registration;
  standard waiver completion uses its acknowledgment timestamp.

A stale compiled web bundle previously still contained the old rail even when
the source was correct. Source, production bundles, PWA cache, and the actual
published deployment must be distinguished when debugging old UI.

## 8. Integrations and ownership

- Production URL verified during handoff preparation:
  `https://rmmx-tracker.replit.app`.
  This is a point-in-time observation, not a promise of future availability.
- GitHub release configuration points to the existing RMMX Tracker repository;
  inspect workflow/build config and the owner's repository access before changing it.
- Resend sends account/setup/reset and registration-related emails; sender domain
  ownership and provider access stay with the owner.
- Stripe Connect relationships, checkout state, webhook delivery and connected
  account IDs must survive migration. Never use live charges for a setup smoke test.
- Expo/EAS, Apple and Google store access, signing and push credentials live
  outside this source archive. Preserve existing store identities.
- Replit AI proxy credentials and object-storage sidecar credentials are not
  portable API credentials for another host.

## 9. Documentation precedence and limits

Priority: current owner request → current source and contract → current handoff
observations → historical notes/plans.

Known older documentation discrepancies:

- `replit.md` has an outdated table count and seed account descriptions.
  Exported copies remove demo password lines.
- Its old build-format description is not current: API output is `dist/index.mjs`.
- It describes an absolute no-raw-fetch rule, but the current app contains
  deliberate raw fetch paths, including unmount saves. Prefer generated hooks
  for contract-backed requests without breaking those exceptions.
- Historical Stripe notes may describe connector-only credentials; current
  `stripeClient.ts` first supports configured secret-key environment variables.
- Environment validation behavior in Vite has evolved; read its current config.
- Some historical memory index links may be missing. Use files actually included.
- Saved task descriptions are not reliable indicators of completion.
- No document can reconstruct the full prior conversation or platform task
  database. This package includes available saved plans and an explicitly
  partial backlog snapshot.
