/**
 * Pre-release GitHub sync verification.
 *
 * Compares every file in the critical directories against GitHub using
 * Git blob SHA hashes (the same algorithm GitHub uses internally), so
 * there is no need to download file content — only the lightweight
 * metadata endpoint is hit for each file.
 *
 * Usage:
 *   pnpm --filter @workspace/scripts run check:github-sync
 *
 * Exit codes:
 *   0 — all files match, safe to release
 *   1 — one or more files differ or are missing on GitHub — DO NOT release
 */

import { execSync, spawnSync } from "child_process";
import { readdirSync, statSync, existsSync } from "fs";
import { join, relative } from "path";

// ─── Config ──────────────────────────────────────────────────────────────────

/** Directories to scan recursively (relative to repo root). */
const SCAN_DIRS = [
  "artifacts/local-server/src",
  "artifacts/desktop/src",
  "artifacts/api-server/src/routes",
  // Full race-platform src — covers pages, components, lib, hooks, etc.
  "artifacts/race-platform/src",
];

/** Individual files outside the scan dirs that must also be checked. */
const EXTRA_FILES = [
  "artifacts/desktop/package.json",
  "artifacts/local-server/package.json",
  "artifacts/api-server/package.json",
  ".github/workflows/build-desktop.yml",
];

// ─── Helpers ─────────────────────────────────────────────────────────────────

function getRepoRoot(): string {
  return execSync("git rev-parse --show-toplevel", { encoding: "utf8" }).trim();
}

function getGitRemote(): { token: string; repo: string } {
  const remotes = execSync("git remote -v", { encoding: "utf8" });
  // Match: https://username:token@github.com/owner/repo.git
  const match = remotes.match(
    /https?:\/\/[^:]+:([^@]+)@github\.com\/([^/]+\/[^\s.]+)/,
  );
  if (!match) {
    throw new Error(
      "Could not extract GitHub token from git remote.\n" +
        "Make sure the remote URL contains a PAT token.",
    );
  }
  return { token: match[1], repo: match[2].replace(/\.git$/, "") };
}

function localBlobSha(filePath: string): string {
  return execSync(`git hash-object "${filePath}"`, { encoding: "utf8" }).trim();
}

async function githubBlobSha(
  token: string,
  repo: string,
  filePath: string,
): Promise<string | null> {
  const url = `https://api.github.com/repos/${repo}/contents/${filePath}`;
  const res = await fetch(url, {
    headers: { Authorization: `token ${token}`, Accept: "application/vnd.github+json" },
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`GitHub API error ${res.status} for ${filePath}`);
  const data = (await res.json()) as { sha?: string };
  return data.sha ?? null;
}

function collectFiles(dir: string, root: string): string[] {
  const abs = join(root, dir);
  if (!existsSync(abs)) return [];
  const result: string[] = [];
  const walk = (d: string) => {
    for (const entry of readdirSync(d)) {
      const full = join(d, entry);
      const stat = statSync(full);
      if (stat.isDirectory()) {
        walk(full);
      } else {
        result.push(relative(root, full));
      }
    }
  };
  walk(abs);
  return result;
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  const root = getRepoRoot();
  const { token, repo } = getGitRemote();

  console.log(`\n🔍  Checking GitHub sync for: ${repo}`);
  console.log(`    Repo root: ${root}\n`);

  // Collect all files to check
  const fileSet = new Set<string>();
  for (const dir of SCAN_DIRS) {
    for (const f of collectFiles(dir, root)) fileSet.add(f);
  }
  for (const f of EXTRA_FILES) {
    if (existsSync(join(root, f))) fileSet.add(f);
  }

  const files = [...fileSet].sort();
  console.log(`    Checking ${files.length} files...\n`);

  const CONCURRENCY = 8;
  const results: Array<{ file: string; status: "ok" | "diff" | "missing" }> =
    [];

  // Process in batches to respect GitHub rate limits
  for (let i = 0; i < files.length; i += CONCURRENCY) {
    const batch = files.slice(i, i + CONCURRENCY);
    const settled = await Promise.all(
      batch.map(async (file) => {
        try {
          const local = localBlobSha(join(root, file));
          const remote = await githubBlobSha(token, repo, file);
          if (remote === null) return { file, status: "missing" as const };
          if (remote !== local) return { file, status: "diff" as const };
          return { file, status: "ok" as const };
        } catch (err) {
          return { file, status: "diff" as const };
        }
      }),
    );
    results.push(...settled);
  }

  // ── Report ────────────────────────────────────────────────────────────────
  const ok = results.filter((r) => r.status === "ok");
  const diffs = results.filter((r) => r.status === "diff");
  const missing = results.filter((r) => r.status === "missing");
  const problems = [...diffs, ...missing];

  if (problems.length === 0) {
    console.log(`✅  All ${ok.length} files match GitHub — safe to release.\n`);
    process.exit(0);
  }

  console.log(`✅  ${ok.length} files in sync`);
  if (diffs.length > 0) {
    console.log(`\n❌  ${diffs.length} file(s) differ from GitHub:`);
    for (const r of diffs) console.log(`    DIFF     ${r.file}`);
  }
  if (missing.length > 0) {
    console.log(`\n❌  ${missing.length} file(s) missing on GitHub:`);
    for (const r of missing) console.log(`    MISSING  ${r.file}`);
  }

  // ── Fix instructions ─────────────────────────────────────────────────────
  console.log("\n── How to push missing/changed files ──────────────────────────");
  console.log("Run this script and pass the output to an agent, or push each");
  console.log("file manually via the GitHub Contents API. Quick shell snippet:\n");
  for (const r of problems) {
    const verb = r.status === "missing" ? "create" : "update";
    console.log(`  # ${verb}: ${r.file}`);
    console.log(`  # git hash-object "${r.file}"`);
  }
  console.log(
    "\nDO NOT create a GitHub release tag until this script reports all ✅.\n",
  );

  process.exit(1);
}

main().catch((err) => {
  console.error("Error running sync check:", err);
  process.exit(1);
});
