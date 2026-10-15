#!/usr/bin/env python3
"""Build a source/context handoff without reading environment secret values.

Run from any directory: python3 scripts/export-claude-handoff.py
This reads working-tree files, never Git history, live DB records or cloud objects.
It invokes Drizzle's model-to-SQL export, which does not access a database.
"""

from __future__ import annotations

import hashlib
import json
import pathlib
import re
import subprocess
import zipfile
from datetime import datetime, timezone

ROOT = pathlib.Path(__file__).resolve().parents[1]
OUTPUT = ROOT / "generated-artifacts" / "claude-handoff"
ARCHIVE = OUTPUT / "RM-Tracker-Claude-Handoff.zip"
PREFIX = "RM-Tracker"

# Includes current source edits/untracked documentation, never an old commit tree.
FORBIDDEN_PARTS = {
    ".git", "node_modules", "dist", ".expo", ".expo-shared", "__pycache__",
    ".cache", ".config", ".pythonlibs", ".uploads", ".upm", ".vscode",
    "test-results", "playwright-report", "coverage", "release",
    "generated-artifacts",
}
FORBIDDEN_SUFFIXES = {
    ".tsbuildinfo", ".pyc", ".pyo", ".log", ".db", ".sqlite", ".sqlite3",
    ".pem", ".p12", ".pfx", ".key", ".keystore", ".jks", ".mobileprovision",
    ".ipa", ".apk", ".aab", ".dmg", ".exe",
}
SECRET_PATTERNS = {
    "private key": re.compile(r"-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----"),
    "provider credential": re.compile(
        r"\b(?:sk_(?:live|test)_[A-Za-z0-9]{12,}"
        r"|rk_(?:live|test)_[A-Za-z0-9]{12,}"
        r"|sk-ant-[A-Za-z0-9_-]{16,}|sk-proj-[A-Za-z0-9_-]{16,}"
        r"|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}"
        r"|re_[A-Za-z0-9]{24,})"
    ),
    "credential in connection URL": re.compile(
        r"(?:postgres(?:ql)?|https?)://[A-Za-z0-9_.%-]+:"
        r"[A-Za-z0-9_.%+!~=-]{8,}@"
    ),
    "push bearer token": re.compile(r"ExponentPushToken\[[A-Za-z0-9_-]{10,}\]"),
}


def json_bytes(value: object) -> bytes:
    return (json.dumps(value, indent=2, ensure_ascii=False) + "\n").encode()


def main() -> None:
    OUTPUT.mkdir(parents=True, exist_ok=True)
    raw_paths = subprocess.check_output(
        ["git", "ls-files", "--cached", "--others", "--exclude-standard", "-z"],
        cwd=ROOT,
    )
    candidates = sorted(set(p.decode() for p in raw_paths.split(b"\0") if p))
    payload: dict[str, bytes] = {}
    exclusions: list[dict[str, str]] = []
    redactions: list[dict[str, str]] = []
    included_source: list[str] = []
    plan_count = 0

    def put(relative: str, data: bytes) -> None:
        if pathlib.PurePosixPath(relative).is_absolute() or ".." in pathlib.PurePosixPath(relative).parts:
            raise RuntimeError("Unsafe archive path")
        try:
            text = data.decode()
        except UnicodeError:
            payload[relative] = data
            return
        for label, pattern in SECRET_PATTERNS.items():
            if pattern.search(text):
                # Print only category and path, never the credential.
                raise RuntimeError(f"Export stopped: possible {label} in {relative}")
        payload[relative] = data

    def sanitize(relative: str, data: bytes) -> bytes:
        if relative == "replit.md":
            text = data.decode()
            lines = text.splitlines()
            cleaned = [
                line for line in lines
                if not re.search(r"Organizer login:|Rider portal logins", line, re.I)
            ]
            if cleaned != lines:
                cleaned.append(
                    "\nHandoff note: historical demo login/password lines were removed "
                    "from this exported copy. No account credentials are supplied."
                )
                redactions.append({
                    "path": relative,
                    "reason": "Removed historical demo login/password documentation lines; live file unchanged.",
                })
                return ("\n".join(cleaned) + "\n").encode()
        return data

    for relative in candidates:
        p = pathlib.PurePosixPath(relative)
        reason = None
        if FORBIDDEN_PARTS.intersection(p.parts):
            reason = "Generated/cache/upload/install/runtime directory"
        elif ".local" in p.parts:
            reason = "Internal platform files; saved Markdown plans copied separately"
        elif p.name == ".env" or p.name.startswith(".env."):
            reason = "Environment configuration excluded"
        elif p.suffix.lower() in FORBIDDEN_SUFFIXES or p.name.endswith((".db-wal", ".db-shm")):
            reason = "Binary runtime data, credentials, logs or generated output"
        elif p.parts[0] == "screenshots":
            reason = "Session screenshots excluded"
        elif p.parts[0] == "attached_assets" and p.suffix == ".txt" and "Master-Replit-Build-Document" not in p.name:
            reason = "Pasted runtime/build logs excluded; original master brief retained"
        full = ROOT / relative
        if full.is_symlink():
            reason = "Symlinks excluded to prevent references outside project"
        elif not full.is_file():
            reason = "Working-tree file missing or not a regular file"
        if reason:
            exclusions.append({"path": relative, "reason": reason})
            continue
        put(relative, sanitize(relative, full.read_bytes()))
        included_source.append(relative)

    for plan in sorted((ROOT / ".local" / "tasks").glob("*.md")):
        if not plan.is_file() or plan.is_symlink():
            continue
        destination = "docs/historical-task-plans/" + plan.name
        put(destination, plan.read_bytes())
        plan_count += 1
    put(
        "docs/historical-task-plans/README-HISTORY.md",
        (
            "# Historical specifications, not an execution queue\n\n"
            "Copied from the available local Markdown task plans. Some describe completed "
            "work; current platform statuses and full subsequent conversations are not "
            "available here. Inspect source and ask the owner before executing a plan.\n"
        ).encode(),
    )

    # SQL is derived from models: no pg_dump, database login, or live records.
    schema_command = [
        "pnpm", "--filter", "@workspace/db", "exec", "drizzle-kit", "export",
        "--dialect", "postgresql", "--schema", "./src/schema/index.ts",
    ]
    result = subprocess.run(
        schema_command, cwd=ROOT, capture_output=True, timeout=120,
    )
    sql_output = result.stdout.decode(errors="replace")
    sql_start = re.search(r"(?m)^CREATE (?:TYPE|TABLE|SCHEMA)\b", sql_output)
    if result.returncode != 0 or sql_start is None:
        raise RuntimeError("Model-derived schema export failed; no archive finalized")
    sql = (
        "-- Generated from application Drizzle models, not from a live database.\n"
        "-- No records, production schema state, session or provider-managed schemas implied.\n"
        "-- Review before applying to a NEW disposable development database only.\n\n"
        + sql_output[sql_start.start():]
    )
    put("export-metadata/APPLICATION_SCHEMA_FROM_MODELS.sql", sql.encode())

    packages = []
    for f in included_source:
        if pathlib.PurePosixPath(f).name == "package.json":
            p = json.loads(payload[f])
            packages.append({
                "path": f, "name": p.get("name"), "version": p.get("version"),
                "packageManager": p.get("packageManager"), "scripts": p.get("scripts", {}),
                "engines": p.get("engines", {}),
            })
    env_refs = []
    ref_pattern = re.compile(
        r"(?:process\.env|import\.meta\.env)(?:\.([A-Za-z_]\w*)|\[['\"]([A-Za-z_]\w*)['\"]\])"
    )
    for f in included_source:
        if pathlib.PurePosixPath(f).suffix not in {".ts", ".tsx", ".js", ".mjs", ".cjs"}:
            continue
        text = payload[f].decode(errors="replace")
        names = sorted({a or b for a, b in ref_pattern.findall(text)})
        if names:
            env_refs.append({"path": f, "variable_names": names})

    model_tables = []
    for f in included_source:
        if f.startswith("lib/db/src/schema/") and f.endswith(".ts"):
            text = payload[f].decode()
            for name in re.findall(r"pgTable\(\s*['\"]([^'\"]+)['\"]", text):
                model_tables.append({"name": name, "source": f})

    put("export-metadata/WORKSPACE_PACKAGES.json", json_bytes(packages))
    put("export-metadata/ENVIRONMENT_NAMES_FROM_SOURCE.json", json_bytes(env_refs))
    put("export-metadata/APPLICATION_TABLES_FROM_SOURCE.json", json_bytes(model_tables))
    put("export-metadata/EXCLUDED_FILES.json", json_bytes(exclusions))
    put("export-metadata/EXPORTED_COPY_REDACTIONS.json", json_bytes(redactions))
    put("export-metadata/SOURCE_TREE.txt", ("\n".join(included_source) + "\n").encode())
    put("README-HANDOFF.md", payload["docs/claude-handoff/START_HERE.md"])

    # The verification record must describe actual fresh checks, not historical claims.
    verification_path = ROOT / "docs/claude-handoff/EXPORT_VERIFICATION.md"
    if not verification_path.is_file():
        raise RuntimeError("Write the actual export verification record before packaging")
    put("export-metadata/VERIFICATION_REPORT.md", verification_path.read_bytes())

    timestamp = datetime.now(timezone.utc).isoformat(timespec="seconds")
    report = f"""# Export report

- Exported at (UTC): {timestamp}
- Source: current working tree, not only the last commit.
- Source/config/context files selected: {len(included_source)}
- Historical Markdown task plans copied: {plan_count}
- Application tables found in Drizzle source: {len(model_tables)}
- Excluded tracked/untracked paths: {len(exclusions)}
- Exported-copy documentation redactions: {len(redactions)}
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

"""
    for item in redactions:
        report += f"- {item['path']}: {item['reason']}\n"
    put("export-metadata/EXPORT_REPORT.md", report.encode())

    manifest = [
        {"path": f, "bytes": len(data), "sha256": hashlib.sha256(data).hexdigest()}
        for f, data in sorted(payload.items())
    ]
    payload["export-metadata/FILE_MANIFEST.json"] = json_bytes(manifest)

    temp_archive = ARCHIVE.with_suffix(".zip.tmp")
    with zipfile.ZipFile(temp_archive, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=6) as z:
        for f, data in sorted(payload.items()):
            info = zipfile.ZipInfo(f"{PREFIX}/{f}")
            info.compress_type = zipfile.ZIP_DEFLATED
            is_script = f.endswith((".sh", ".py"))
            info.external_attr = (0o100755 if is_script else 0o100644) << 16
            z.writestr(info, data)
    with zipfile.ZipFile(temp_archive) as z:
        assert z.testzip() is None, "ZIP CRC validation failed"
        assert len(z.namelist()) == len(payload)
        for item in manifest:
            data = z.read(f"{PREFIX}/{item['path']}")
            assert hashlib.sha256(data).hexdigest() == item["sha256"], item["path"]
        required = [
            "CLAUDE.md", "package.json", "pnpm-lock.yaml", "pnpm-workspace.yaml",
            "artifacts/api-server/src/index.ts",
            "artifacts/race-platform/src/pages/organizer/Dashboard.tsx",
            "artifacts/rider-app/app.json", "artifacts/local-server/src/db-init.ts",
            "artifacts/desktop/src/main.ts", "artifacts/connector/src/main.ts",
            "lib/api-spec/openapi.yaml", "lib/db/src/schema/index.ts",
            "attached_assets/rm-logo.png", ".github/workflows/desktop-release.yml",
            "docs/claude-handoff/APP_CONTEXT.md",
        ]
        for f in required:
            assert f in payload, f"Missing required source file: {f}"
    temp_archive.replace(ARCHIVE)
    digest = hashlib.sha256(ARCHIVE.read_bytes()).hexdigest()
    (OUTPUT / "RM-Tracker-Claude-Handoff.zip.sha256").write_text(f"{digest}  {ARCHIVE.name}\n")
    (OUTPUT / "EXPORT_REPORT.md").write_bytes(payload["export-metadata/EXPORT_REPORT.md"])
    (OUTPUT / "APP_CONTEXT.md").write_bytes(payload["docs/claude-handoff/APP_CONTEXT.md"])
    print(json.dumps({
        "archive": str(ARCHIVE.relative_to(ROOT)), "bytes": ARCHIVE.stat().st_size,
        "payload_files": len(payload), "source_files": len(included_source),
        "historical_plans": plan_count, "model_tables": len(model_tables),
        "redacted_files": [r["path"] for r in redactions],
        "sha256": digest, "crc_and_hash_verification": "PASS",
    }, indent=2))


if __name__ == "__main__":
    main()
