# Export report

- Exported at (UTC): 2026-10-15T15:47:20+00:00
- Source: current working tree, not only the last commit.
- Source/config/context files selected: 810
- Historical Markdown task plans copied: 116
- Application tables found in Drizzle source: 38
- Excluded tracked/untracked paths: 21
- Exported-copy documentation redactions: 1
- Live database connections or data exports performed: **none**
- Model-derived SQL DDL export: **succeeded**
- Bucket files, local database records, secret values, signing material: **not included**
- Git history, installed modules, compiled builds, logs and test artifacts: **not included**

## Integrity and completeness

FILE_MANIFEST.json lists every archived payload file except itself, its size and
SHA-256. The source tree is listed separately. The exporter fails on detected
provider credentials/private keys, unsafe paths or a failed schema export.
This is targeted credential screening, not a guarantee or a full security audit.
The Firebase Android google-services.json is public application client
configuration; service-account/signing credentials are not included.

## Limits

This is not a turnkey deployment or a full backup of the running service.
The included historical plans are not authoritative task states. Full prior
conversation history and the complete live Replit task database are not available.
APP_CONTEXT.md and the other handoff documents are the curated continuation context.
No credential values were requested from environment secrets or copied from them.

## Included-copy changes

- replit.md: Removed historical demo login/password documentation lines; live file unchanged.
