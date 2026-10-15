# Timing ingest auth: migration plan (draft for owner approval)

Status: **direction approved by the owner on 2026-10-15** (decisions 1-3 in
section 7). Production (Replit) is untouched until the owner deploys.

Progress:
- Done (branch `claude/timing-token-hardening`): reader tokens are redacted
  from request logs, and the token route rejects an `eventId` from another club
  with 403.
- Done (branch `claude/timing-ingest-observe`): Phase 0. Every ingest POST
  logs one `timing ingest observed` line with route, credential kind
  (`reader_path_token` / `bearer` / `session` / `none`), club/event/moto hints,
  status and user agent. No credential values are logged.
- Next: Phase 1, which needs a decision on the per-club enforcement column.

## 1. The problem

`staffPermissionMiddleware` (`api-server/src/middleware/staffPermissions.ts:111`)
calls `next()` when there is no session, and organizers/admins also pass through
without a `staffClubId`. Six cloud ingest routes in
`api-server/src/routes/timing.ts` therefore accept crossings from anyone, and
club-scope only staff sessions:

| Route | Line | Target chosen by | Today's check |
|---|---|---|---|
| `POST /timing/crossing` | 1116 | `motoId` in body | staff only |
| `POST /timing/active/crossing?clubId=` | 1213 | `clubId` query → in-progress moto, enduro fallback, then practice | staff only |
| `POST /timing/ping?clubId=` | 1399 | none (echo only) | none |
| `POST /timing/impinj-crossing?eventId=` | 1446 | `eventId` → in-progress moto | staff only |
| `POST /timing/zebra-crossing?eventId=` | 1506 | `eventId` → in-progress moto | staff only |
| `POST /timing/mylaps-crossing?eventId=` | 1570 | `eventId` → in-progress moto | staff only |

Impact: anyone who can guess a small integer can add laps to, or start (enduro
fallback), a live moto of any club. Unauthenticated callers can also put tags
into a club's live tag scanner (`recordTagSeen` runs before any check), and can
claim a "trusted" `source` and get past-skew timestamp replacement
(`ingestDirectActiveCrossingTime`, timing.ts:48).

Related gaps found during the review. These are in scope for this plan because
they share the same fix:

- **`/timing/readers/:token/crossing`** (`reader-ingest.ts:88`, the model route)
  trusts `body.eventId` without checking it belongs to `reader.clubId`. A valid
  token from club A can route crossings into club B's event.
- **`POST /practice/active/crossing?clubId=`** (`practice.ts:252`) is open in the
  same way. `rfid_bridge.py` and the local server both use it.
- **Reader tokens in logs.** The token is a URL path segment. `pino-http` logs
  `url` with only the query string stripped (`app.ts:25`), so every reader token
  appears in request logs.

## 2. Callers (verified against source)

| Caller | Ships separately? | Cloud endpoint(s) | Auth sent today |
|---|---|---|---|
| **RM Connect** (`artifacts/connector`) | Yes, tagged installers `connector-v*` | 1. `/timing/readers/:token/crossing` (`cloud.ts:195`). 2. On a 422 whose message contains "assignment" or "no active race_day event", one retry to `/timing/active/crossing?clubId=` (`cloud.ts:214`) | Token in path only. Fallback: none. No crossing queue. |
| **Electron desktop** (`artifacts/desktop`) | Yes, auto-updates | **None.** Posts to its own local server `127.0.0.1:9090/api/timing/active/crossing` (`main.ts:797-851`). Reaches the cloud only via `/clubs/:id/desktop-push`, `/sync`, `/sync-pull` with a cookie | n/a for ingest |
| **local-server** (`artifacts/local-server`) | Yes, offline bundle | **None.** Has its own open copies of `/timing/crossing`, `/active/crossing`, `/mylaps-crossing` (and `/transponder-crossing`), `/impinj-crossing`, `/zebra-crossing`, `/practice/active/crossing`. Reaches the cloud only via `/clubs/:id/sync` with `SYNC_TOKEN` bearer or cookie | n/a for ingest |
| **`rfid_bridge.py`** (downloaded from `race-platform/public/`) | Yes, copied to laptops | `/timing/crossing` (generic, needs `motoId`), `/impinj-crossing?eventId=`, `/zebra-crossing?eventId=`, `/active/crossing?clubId=` (TCP active mode), `/practice/active/crossing?clubId=` | None. SQLite retry queue stores the **full path** per row. HTTP 400/409 are treated as done; any other status is retried. |
| **OfflineMode.tsx** reader config (`:309-329`) | Pushes config to hardware via the bridge | Programs Impinj/Zebra to `http://<laptop>:5555/timing/{impinj,zebra}-crossing` (the bridge, **not** the cloud). `cloudEndpoint` at `:332` is dead code. | Bridge sets only `Content-Type` on the reader |
| **ReaderSetup.tsx** | Web app (deploys with API) | Shows hand-copy URLs: facility `/timing/active/crossing?clubId=` (`:21`, `:488`) and per-reader `/timing/readers/:token/crossing` (`:634`). Calls `/timing/ping?clubId=` from the browser (`:800`). | Ping sends the session cookie. Hand-programmed readers send nothing. |
| **Hardware already in the field** | n/a (reprogramming needs a site visit) | Whatever URL was copied: cloud facility URL, per-reader token URL, bridge `:5555`, or local `:8080/api/timing/active/crossing` from the offline README (`offline.ts:156`) | Usually cannot add custom headers |
| `scripts/src/benchmark-live-timing.ts:316` | Dev tool | `/timing/crossing` | None. Defaults to localhost. |
| rider-app | n/a | none | n/a |

No caller in the repo posts to `/timing/mylaps-crossing` on the cloud. Only the
ReaderSetup page (with a session) calls `/timing/ping`.

The scope is narrower than first feared. **Desktop and local-server never call
cloud ingest.** The cloud-facing callers are RM Connect's fallback,
`rfid_bridge.py`, readers hand-programmed with the facility URL, and the benchmark
script.

## 3. Target model

Every cloud ingest request resolves to one **ingest principal** before any
routing happens:

- **Reader token** gives `{ kind: "reader", readerId, clubId, type }`. The token
  can come from (a) the URL path, for hardware that can't set headers, or
  (b) `Authorization: Bearer <readerToken>`, for RM Connect and the bridge.
- **Session user** gives `{ kind: "user", clubId }`. This applies to organizers,
  admins and staff with the `events` permission. It closes the organizer gap and
  keeps the ReaderSetup ping working.
- **None** means legacy and unauthenticated. This is allowed only while the
  enforcement switch for that club is off.

The handler then derives the **target club** from what the request addresses
(`motoId` → event → club, `eventId` → club, or `clubId` query) and requires
`principal.clubId === targetClub`. For token principals, `clubId`/`eventId`
from the query or body become hints that must agree with the token's club.
They are never trusted on their own.

New path-token routes, so hand-programmed hardware can move off `?clubId=`:

- `POST /timing/readers/:token/active/crossing` uses the same payload handling as
  `/timing/active/crossing` (Impinj events[], fw10 array, Zebra tags[],
  generic/F2000), with `clubId` taken from the token.
- `POST /timing/readers/:token/ping` works the same way.

I recommend factoring the existing `/active/crossing` body into a shared
function that takes `clubId` (plus an optional `readerId`). The old route and the
token route then share one implementation, with no copy to drift.

## 4. Phases

Each phase is a separate change for owner review. Nothing ships to Replit until
the owner deploys it.

### Phase 0: Observe (no behavior change)
- Add one structured log line per ingest request: route, principal kind
  (`reader`/`user`/`none`), target club, user agent, and a coarse caller hint.
  Never log the token itself.
- Redact `/timing/readers/<token>/…` and `/connector/ws?token=` in the
  `pino-http` serializer.
- Run for at least two race weekends. The output is a per-club list of who still
  posts unauthenticated, which tells us which clubs need a bridge upgrade or a
  site visit before Phase 3.

### Phase 1: Additive auth (no request is rejected that is accepted today)
- Add the `resolveIngestPrincipal` helper and the target-club check to all six
  routes, plus `/practice/active/crossing`.
  - A principal from the **wrong** club gets 403. This can't break a working
    caller, because no legitimate caller sends a credential for another club.
  - **No principal** is still accepted and is logged `none`.
- Fix the token route's `body.eventId` check: reject when the event's club ≠
  `reader.clubId`. Use a 422 whose message does **not** contain "assignment" or
  "no active race_day event", so RM Connect doesn't fall back. Confirm that
  shipped connectors only send `eventId` for their own club's armed moto.
- Move `recordTagSeen` after the auth check (unauthenticated requests still
  record while enforcement is off).
- Add the two path-token routes from section 3.
- Add `POST /readers/:id/rotate-token` (session, club-scoped), so a leaked token
  can be revoked. GET /readers already exposes tokens to club users. Decide
  whether staff without `events` should see them.
- Add a per-club enforcement setting: `clubs.timing_ingest_auth` = `off` |
  `warn` | `enforce`, default `off`. This needs a schema change, so check
  `push` safety first. An env kill switch overrides it globally.

### Phase 2: Move the callers
- **RM Connect** (new installer):
  - Send `Authorization: Bearer <readerToken>` on the facility fallback, or
    better, point the fallback at `/timing/readers/:token/active/crossing`.
  - Keep the token route's 422 message strings stable, because older connectors
    match on them.
  - Update the `connector-release` config and ReaderSetup download links.
- **`rfid_bridge.py`**:
  - Add `--reader-token`.
  - Send it as a Bearer header **at send time**, so rows already queued with old
    paths replay with auth after the upgrade.
  - Prefer the token routes for new rows.
  - Handle 401/403 as a permanent failure with a loud log, instead of an endless
    retry.
  - Update the launcher scripts in OfflineMode.tsx (`:333-334`, `:454-470`) to
    pass the token.
- **ReaderSetup.tsx**:
  - Replace the clubId facility URL with the per-reader token facility URL.
  - Keep the browser ping (it has a session).
  - Add a token ping for hardware tests.
  - Update `SYSTEM_PROMPT.md:564-581`. Its claim that the bridge programs
    "authentication headers" is wrong today.
- **OfflineMode.tsx**: delete the dead `cloudEndpoint` (`:332`).
- **Benchmark script**: accept a token or session cookie via env.
- **Desktop and local-server**: no change required, since they don't touch cloud
  ingest. Local ingest routes stay open on the LAN; see open decisions. Per
  CLAUDE.md, review the local server too. Accepting an `Authorization` header
  there and ignoring it keeps the API boundary compatible, so a bridge can point
  at either server.

### Phase 3: Enforce, club by club
- Turn on `warn` for a club. Unauthenticated requests are accepted but flagged in
  the organizer UI (for example, a ReaderSetup banner: "Reader X is using an
  unauthenticated URL").
- Then turn on `enforce`. Unauthenticated requests get **401** with a body that
  names the fix.
- Gate per club: zero `none` requests over the previous race weekend, and never
  flip it during a live event.
- Gate `/timing/mylaps-crossing` first. Nothing in the repo calls it.
- Once enforced, only token-authenticated **active** readers can claim a trusted
  direct-timing `source` for past-skew replacement, matching `reader-ingest.ts`.
- Once every club is on `enforce`, make it the default for new clubs.

### Phase 4 (optional): Retire
- Tombstone `/timing/impinj-crossing`, `/zebra-crossing` and `/mylaps-crossing`
  with a 410 and a pointer to the token routes, once the logs show no traffic.

## 5. Timing invariants: how each is preserved

- **Moto lock serialization.**
  - All auth and club lookups run **before** `processCrossing`, never inside
    `withMotoLock`.
  - `processCrossing` stays the only path that writes `lap_crossings`, with no
    new direct inserts.
  - Cache token → reader (short TTL, cleared on rotate/delete), so the extra
    lookup doesn't add latency ahead of the lock.
  - Re-run `benchmark-live-timing.ts` before and after to confirm no p95
    regression.
- **Timestamp normalization.**
  - `ingestCrossingTime` and `ingestDirectActiveCrossingTime` call `new Date()`
    inside the handler, so auth work would shift the "received" instant.
  - Capture `serverReceivedAt` at the start of the request (first middleware) and
    pass it in, so normalization sees the same receipt time as today.
  - `canonicalizeCrossingTimestamp` and `parseTrustworthyReceivedAt` themselves
    are unchanged.
- **SSE baseline handoff.** This is unaffected as long as the point above holds.
  `GET /timing/live/:motoId` takes the same lock, and every accepted crossing is
  still either in the baseline or delivered live.
- **Active-transponder routing.** The token facility route keeps the
  `f2000-practice-routing` rules:
  1. An armed connector's `eventId` wins, now validated against the token's club.
  2. A request with no event context goes to the in-progress moto, then to the
     running practice.
  3. While timing is idle, active readers get 409, not a fallback that starts a
     scheduled race.
  4. Event registration active IDs resolve before global rider IDs.

  Passive RFID stays connector-gated.
- **Announcer sequencing.** Untouched, since there's no announcer code in this
  path.

## 6. Verification before each phase ships
- Unit tests for principal resolution (path token, header token, session,
  wrong-club, unknown token, rotated token).
- Local API checks against the dev DB, never prod, for every route in each mode
  (`off`/`warn`/`enforce`), including the RM Connect 422 → fallback sequence.
- Hardware run with a real Impinj or Zebra, an F2000 through RM Connect, and the
  bridge queue replay, before any club is set to `enforce`. A software build
  doesn't prove hardware behavior.
- Typecheck, plus codegen if the new token routes go into `openapi.yaml`.

## 7. Owner decisions

Decided 2026-10-15:
- **1. Direction:** approved.
- **2. Order:** ship the token-log redaction and the token-route `eventId` fix
  first, then Phase 0, then Phase 1.
- **3. Credentials:** RM Connect and the bridge send the reader token as a
  Bearer header; path tokens only for hardware that can't set headers.

Still open: 4-6 below, plus the per-club enforcement column (schema change).

Original questions:
1. Approve the overall direction: tokens for hardware, sessions for people,
   enforcement per club.
2. Bearer header vs. path token for RM Connect and the bridge. Path-only is
   simpler, but tokens end up in logs and proxies. **Recommendation:** header
   where the caller supports it, path only for hardware.
3. Should Phase 1's token-route `eventId` fix ship on its own, ahead of the rest?
   It's small and closes a cross-club hole in the "safe" route.
4. Should the offline local server's LAN ingest routes stay open? Recommendation:
   yes for now, since it's an offline trust boundary. Revisit separately.
5. Who owns the field rollout: bridge/connector upgrades, and reprogramming
   readers that have the facility URL. What's the deadline before `enforce`
   becomes the default?
6. Should staff without the `events` permission be able to see reader tokens?
