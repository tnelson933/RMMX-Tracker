# Verification and release operations

## Typechecks and generation

```bash
pnpm run typecheck:libs
pnpm --filter @workspace/api-server run typecheck
pnpm --filter @workspace/race-platform run typecheck
pnpm --filter @workspace/rider-app run typecheck
pnpm --filter @workspace/local-server run typecheck
pnpm --filter @workspace/desktop run typecheck
pnpm --filter @workspace/connector run typecheck
pnpm --filter @workspace/scripts run validate:registration-schema
```

For complete repository checks use `pnpm run typecheck`; it may include the
design sandbox as well. Do not silently suppress failures.

After editing OpenAPI:

```bash
pnpm --filter @workspace/api-spec run codegen
```

The API build runs shared-library and API typechecks plus registration-schema
validation, then esbuild. The latter cannot prove that production database
columns match the application.

## Tests

Browser tests are under `artifacts/race-platform/tests/browser`. The Playwright
configuration starts a Vite server on port 4174 and uses desktop and phone-sized
Chromium profiles. Inspect tests for mocks; a mocked API is not end-to-end
database verification.

On this Replit/Nix environment:

```bash
pnpm --filter @workspace/race-platform run test:browser
```

Outside Nix, install the appropriate Playwright browser and use:

```bash
cd artifacts/race-platform
pnpm exec playwright install chromium
pnpm exec playwright test
```

The `test:browser` wrapper uses `command -v chromium`; if no system Chromium
exists, call Playwright directly or set its executable configuration deliberately.

Timing/audio/announcer/video tests use Node's test API in TypeScript files.
For example, from a configured installation:

```bash
pnpm --filter @workspace/scripts exec tsx --test ../artifacts/api-server/src/lib/*.test.ts ../artifacts/race-platform/src/lib/*.test.ts
pnpm --filter @workspace/connector run test
```

Check imports and environment prerequisites if a suite fails before reaching tests.
The `tsx` executable is installed in the scripts package, not the API/web packages.
There is no single authoritative root test command covering every component.

`scripts/src/benchmark-live-timing.ts` intentionally writes fixture data and
requires its explicit opt-in. Run only against a disposable environment after
reviewing the file. The F2000 latency guide in `docs/` and Python RFID bridge
utility/tests cover additional hardware-specific workflows.

## Build commands

```bash
pnpm --filter @workspace/api-server run build
PORT=19869 BASE_PATH=/ pnpm --filter @workspace/race-platform run build
pnpm --filter @workspace/local-server run build
pnpm --filter @workspace/desktop run build
pnpm --filter @workspace/connector run build
```

These commands do not publish. A frontend Vite build writes
`artifacts/race-platform/dist/public`; API build writes `dist/index.mjs`
inside the API package. Those generated files are not included in the source ZIP.

## Functional verification checklist

- Legitimate organizer login, logout, persistence and club isolation.
- Staff restrictions and platform-administrator boundaries.
- Correct four-card account dashboard; next-event snapshot and alert rules.
- Event CRUD, multi-day dates, class registration and void behavior.
- Registration payments in Stripe **test mode**, connected-account destination,
  webhook replay/idempotency, and return/cancel behavior.
- Standard acknowledgment versus signed liability waiver, including minors.
- Check-in, bib/transponder assignment and fresh event requirement enforcement.
- Practice, moto start/stop, duplicate reads, timestamps, live results, sound and
  reconnect behavior.
- Motocross-only fastest-lap-1 exclusion versus other disciplines.
- Series points and public result publication rules.
- Video with broadcaster/viewer reconnect and control/binary frame handling.
- Desktop offline operations, restart durability, sync conflict/identity handling.
- RM Connect reader readiness, enabled loops and actual physical crossings.
- Mobile login/multi-profile selection, race/results/maintenance screens,
  notifications and physical-device reachability.
- Public/deep links, uploaded logos/PDFs, private object authorization.
- Installed PWA update after a rebuilt/redeployed frontend.

For production schema-affecting work, perform read-only smoke tests against
event roster, check-in list, bib availability and public schedule, and investigate
unexpected 500s. Expected unauthenticated 401s are not application failures.

## Release ownership and workflow

Existing project instructions say a production publish should also produce a
software-download release unless the owner explicitly opts out. Preserve that
coordination expectation, but **do not trigger releases from a documentation
handoff or without the owner's authorization**.

### Desktop

- Source: `artifacts/desktop`.
- Installer configuration: `electron-builder.yml`.
- CI: `.github/workflows/desktop-release.yml`.
- Release tags: `desktop-v*`; package version must match the tag.
- Build the local API and web assets before packaging.
- Keep web download fallbacks and API release resolution aligned.
- Existing CI generates Mac and Windows installers and uploads release assets.
- GitHub repository variable `CLOUD_URL` supplies the cloud origin for builds.
- Native module rebuilding, icon generation and bundled dependencies are
  significant; use the workflow as the current operational reference.

### RM Connect

- Source: `artifacts/connector`.
- CI: `.github/workflows/connector-release.yml`.
- Tags: `connector-v*`.
- Separate version and release assets from RM Tracker desktop.
- Download resolution lives in API config and web download surfaces.

### Rider mobile

- Run EAS operations from `artifacts/rider-app` unless the workflow explicitly
  handles monorepo config placement.
- Preserve Expo project ID, iOS bundle ID, Android package, signing and push identity.
- Read the existing app version, Android versionCode, and EAS auto-increment config;
  do not reset them.
- Production SDK 54 builds pin Node 20.19.4, Android SDK 54 image and the current
  configured Xcode 26 image for compatibility.
- Included EAS workflow handles config visibility for root-resolving submit jobs;
  review `.agents/memory/eas-monorepo-submit.md`.
- Store submission credentials/private keys are not in the ZIP.

## Export-time results

`export-metadata/VERIFICATION_REPORT.md` records what was checked while preparing
the package. It distinguishes fresh checks from earlier conversation reports.
No new hardware/store/payment certification is implied.
