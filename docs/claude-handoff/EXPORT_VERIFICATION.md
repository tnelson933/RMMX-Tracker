# Checks performed while preparing this handoff

## Reconciliation and regenerated export

The local `claude-handoff` branch now includes both the local project history
and the last fetched GitHub main history. Application files were retained after
reviewing the conflicting changes. See RECONCILIATION.md for the rationale.
GitHub main was not modified. Remote delivery requires a successful push;
the existence of this ZIP does not prove that GitHub has received the branch.

Fresh checks after reconciliation:

- Whole-workspace `pnpm run typecheck`: passed.
- API/web unit tests: 61 passed, 0 failed.
- Connector tests: 26 passed, 0 failed.
- Registration schema check: passed for 31 fields.
- Browser tests were not rerun; the previous failures below remain unresolved.
- No application source files changed during reconciliation.

The regenerated archive includes `export-metadata/SOURCE_REVISION.json` to
identify its source commit and any uncommitted files present during export.

## Previous export-preparation checks

The remaining sections record the previous export-preparation run, not fresh
browser or deployment verification. No application feature changed in that run.

## Passed

- `pnpm run typecheck`: shared libraries plus API, connector, desktop,
  local-server, design sandbox, web, rider-app and scripts completed successfully.
- `pnpm --filter @workspace/scripts exec tsx --test ../artifacts/api-server/src/lib/*.test.ts ../artifacts/race-platform/src/lib/*.test.ts`:
  **61 tests passed**, zero failures.
- `pnpm --filter @workspace/connector run test`:
  **26 tests passed**, zero failures.
- `pnpm --filter @workspace/scripts run validate:registration-schema`:
  passed for 31 API-selected registration fields.
- `git diff --check`: passed before packaging; recheck after documentation changes.

## Failed / not fully verified

- `pnpm --filter @workspace/race-platform run test:browser`:
  **2 passed, 10 failed** on this run. Failures were test/navigation timeouts,
  including `page.goto` waiting for page load. The 12-test suite had been
  reported passing in the preceding development session, but that does not
  override this fresh result. Investigate environment/external asset loading,
  server readiness and actual page behavior before assuming a functional cause.
  No test was disabled or rewritten to hide this result.
- The proposed `pnpm --filter @workspace/api-server exec tsx ...` launcher
  could not resolve `tsx` because that executable is provided by the scripts
  package. The command above using `@workspace/scripts` ran successfully and
  is the documented supported invocation.

## Archive verification

The export script validates the final ZIP's CRCs, checks SHA-256 for every
manifest entry, checks expected source files from every product component,
and stops if targeted credential screening finds provider credentials or
private keys. Exact file counts and archive checksum are printed when packaging
completes and recorded in the export report/manifest.

Model-derived schema SQL is produced with Drizzle's `export` operation.
It is not a live database backup and does not establish production schema parity.

## Not performed

- Clean install or execution on a new Mac/Windows/Linux computer.
- A fresh full production build of every artifact during packaging.
- Live database or cloud-object export/restore.
- Authenticated visual review of private dashboard.
- Production checkout, payouts, email delivery or real push notifications.
- Physical timing hardware, installer signing or app-store submissions.
- Hosting/DNS/callback cutover.

Prior successful builds remain historical observations in STATUS_AND_BACKLOG.md.
None of the checks here imply that credentials, provider accounts or production
data are included in the archive.
