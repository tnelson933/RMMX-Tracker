# Current state, known gaps, and historical work

## Current code state

The package is a snapshot of the working tree, not necessarily the same version
as the currently published site or the newest installed desktop/mobile release.
`export-metadata/EXPORT_REPORT.md` records packaging details.

Latest work discussed with the owner:

1. Replaced the organizer dashboard's Recent Activity rail with Next Event
   Snapshot and Action Needed, using server-calculated event/registration data.
2. Extended OpenAPI and regenerated React client/Zod outputs.
3. Removed Total Checked In from account-wide summary cards and changed the
   summary grid to four cards.

Owner's rationale: **“checked in is per event. the dashboard is an overall view
of the account.”** Preserve that distinction.

The old API fields were left for compatibility. The local-server dashboard
implementation is separate; do not assume the cloud additions were mirrored
there. Verify its response before shipping the new sidebar in offline mode.

## Prior verification versus this export

Earlier implementation work reported:

- Cloud API and web typechecks passed.
- API client regeneration completed.
- Browser suite completed with 12 passing tests.
- Web production bundle rebuilt after a stale-bundle problem.
- Mobile typecheck/restart passed after a transient generated-file resolution issue.
- The four-card change passed web typecheck and production build.

These are historical observations from the preceding session, not guarantees
about every file in the current snapshot or a clean external installation.
See the export's verification report for commands actually re-run during packaging.

Authenticated dashboard visual inspection was **not** completed: the screenshot
browser had no organizer session. It reached login/public pages instead.
Do not describe the signed-in dashboard as visually verified.

Hardware, Stripe live checkout/payouts, physical-device push, new-host deployment,
production schema/data restore, and installer signing have not been newly
validated by this handoff.

Production metadata queried while preparing the handoff reported a public,
successful Replit autoscale deployment at `https://rmmx-tracker.replit.app`.
That checks metadata only, not every feature or UI version.

## Known risks to investigate before a hosting move

- **Platform-specific package exclusions:** native optional dependency overrides
  assume Linux x64. Review before installing on a Mac/Windows/ARM machine.
- **Routing dependency:** the website currently relies on the platform proxy for
  same-origin API routing, SSE and WebSocket upgrades.
- **Storage dependency:** sidecar-authenticated object storage is not portable
  without an adapter and actual file migration.
- **AI dependency:** runtime proxy credentials must be replaced/adapted.
- **Payment lifecycle:** configured Stripe server keys exist as a code path, but
  webhook sync package setup still needs target-host review.
- **Unsafe defaults:** server code has development session-secret fallbacks.
  Explicitly supply strong production secrets. Review authorization, CORS,
  administrative/seed routes, and secret-based maintenance routes before exposing
  a new host. This handoff is not a security audit.
- **Startup data normalization:** the API invokes event-state normalization at
  startup. Starting against production is not a purely read-only action.
- **Process-local realtime state:** video and connector relays need a considered
  scaling/restart strategy.
- **Cloud/local parity:** schema and API evolution must preserve offline sync.
- **Stale PWA/builds:** correct source does not prove deployed or cached UI is current.
- **Data-changing utilities:** seed/import/sync/benchmark scripts are not generic
  setup commands and can modify or overwrite records.

## Partial proposed-work snapshot

The platform showed additional work proposals in the project snapshot. This is
**not a complete or live task export**; more tasks were not visible. Confirm each
item against current source and the owner's priorities before implementing.
Historical task plans may describe work already completed.

- Rider notification history and per-club notification snoozing.
- Safe fee display across local-server pages.
- Clear Rocky's draft after a home-widget send.
- Include remaining scheduled moto counts in Rocky's context.
- Show the next moto on the Race Day Display.
- Show corrections on the organizer WatchLive broadcast screen.
- Include waiver status in registration spreadsheet export.
- Manual in-app update checking.
- Organizer waiver acknowledgment at check-in.
- Share rider race results.
- Recalculate series points after event class-to-series mapping edits.
- Android adaptive branding icon.
- Guard against accidental data-loss schema changes.
- Back RM Cash transaction history with real database records.
- Expose the Team page in the desktop/local interface.
- Adjust remaining scheduled times when a moto overruns.
- Warn when clearing an existing multi-day event end date.
- Keep Rocky follow-up suggestions across screen switches.
- Common-question reply chips in Rocky chat.

Dashboard alert regression coverage was previously suggested. Regardless of
task-list status, verify void handling, per-event requirement flags, signature/
acknowledgment differences, no-upcoming-event state, and offline API compatibility.

## Saved task plans included

`docs/historical-task-plans/` copies available Markdown task descriptions from
the local project history. The export report gives the actual count.

They preserve acceptance criteria, intended scope, and feature context. They do
not carry authoritative current task states, assignment/dependency metadata,
or complete subsequent conversations. Do not automatically execute the folder.

## Suggested continuation sequence

1. Verify the archive and read the handoff.
2. Establish a disposable local database and same-origin web/API development setup.
3. Run targeted typechecks/tests/builds and document actual results.
4. Confirm the dashboard account-level summary and event-focused sidebar in a
   legitimate organizer session, including an offline/local response.
5. Choose whether hosting stays on Replit initially or moves.
6. If moving, complete storage/AI/Stripe adapters and private data migration
   in staging before changing the live origin.
7. Select the next product request with the owner rather than treating every
   historical idea as an instruction to build.
