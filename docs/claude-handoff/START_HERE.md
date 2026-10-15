# RM Tracker — Claude handoff

## What this package is

A source-code handoff for the entire RM Tracker / RMMX Tracker / Rocky Mountain
ATV/MC race platform, with documentation for continuing work in Claude Code or
another source-capable development environment.

**Claude is the programming assistant, not the hosting service.** The software
still needs a computer or server, PostgreSQL, environment configuration, and
the external services it uses. You can develop with Claude while leaving
production on Replit, or move hosting in a separate, tested migration.

This is a software-and-context export, **not a completed hosting or live-data
migration**. It does not modify the running application or shut anything down.

## Read in this order

1. `CLAUDE.md` — continuation instructions and guardrails.
2. `docs/claude-handoff/APP_CONTEXT.md` — product, architecture, feature map,
   domain rules, and recent decisions.
3. `docs/claude-handoff/SETUP_AND_MIGRATION.md` — local setup and what must change
   outside Replit.
4. `docs/claude-handoff/ENVIRONMENT_REFERENCE.md` — variable names, service
   ownership, and configuration boundaries. No credential values.
5. `docs/claude-handoff/STATUS_AND_BACKLOG.md` — recent work, verification limits,
   known risks, and historical task context.
6. `docs/claude-handoff/VERIFICATION_AND_RELEASES.md` — test/build and release steps.
7. `export-metadata/` in the ZIP — file inventory, checksums, scripts, schema
   source inventory, environment-name inventory, exclusions, and export report.

## Software included

| Directory | Purpose |
| --- | --- |
| `artifacts/race-platform` | Public website, organizer portal, rider web portal, live results, PWA |
| `artifacts/api-server` | Cloud API, PostgreSQL access, timing, integrations |
| `artifacts/rider-app` | Expo / React Native iOS, Android, and web rider app |
| `artifacts/local-server` | Offline/local Express + SQLite API and synchronization |
| `artifacts/desktop` | RM Tracker Electron desktop application |
| `artifacts/connector` | RM Connect Electron timing hardware bridge |
| `artifacts/mockup-sandbox` | Design experiments; not the production app |
| `lib` | Database models, API specification, generated clients, integration libraries |
| `scripts` | Validation, import/sync, benchmark, and export utilities |
| `.github/workflows` | Desktop and connector installer release automation |
| `.eas` | Expo workflow configuration |
| `.agents/memory` | Historical engineering lessons; verify against current source |
| `docs/historical-task-plans` | Saved task specifications, not a verified open-task list |

## Not included, intentionally

- Secret values, `.env` files, authenticated browser sessions, service credentials,
  private signing keys, provider access tokens, and machine-specific configuration.
- PostgreSQL table records, payment records, rider personal data, session tables,
  and databases from individual desktop installations.
- Replit App Storage bucket contents. Locally cached uploads are also excluded.
- Installed `node_modules`, compiled builds, native build caches, installer files,
  test reports, and Git history. Install dependencies and rebuild from source.
- Replit-internal skills/callback runtime, the private creator profile, and the
  platform's full task database or conversation transcript.

See `export-metadata/EXPORT_REPORT.md` for the exact count of included files,
hash inventory, any source redactions, and excluded paths.

**Do not cancel the old hosting account or delete the old project until data,
uploaded files, secrets, new hosting, payments, and hardware clients have all
been transferred and verified.**

## First session with Claude

Extract the ZIP into a new folder and open that folder in Claude Code.
Give Claude this prompt:

> Read CLAUDE.md and all docs/claude-handoff documents. This is my existing
> RM Tracker project. Preserve the current software and features; do not
> recreate it from scratch. First summarize the architecture, the components
> that need external configuration, and the migration steps still outstanding.
> Inspect the current source before assuming historical plans are unfinished.
> Help me get the web app and API running locally against a disposable
> development database. Do not touch the existing production database,
> publish releases, seed data, send emails, or charge payments without my
> approval. Never ask me to paste credentials into chat.

## Verify the export

After extraction, from the project root:

```bash
python3 - <<'PY'
import hashlib, json, pathlib
root = pathlib.Path(".")
manifest = json.loads((root / "export-metadata/FILE_MANIFEST.json").read_text())
for item in manifest:
    p = root / item["path"]
    assert p.is_file(), f"Missing: {p}"
    assert hashlib.sha256(p.read_bytes()).hexdigest() == item["sha256"], f"Changed: {p}"
print(f"Verified {len(manifest)} files")
PY
```

The checksum manifest excludes itself. A successful integrity check proves the
files survived the download, not that runtime services are already configured.
