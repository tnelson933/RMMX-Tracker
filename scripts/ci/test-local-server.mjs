#!/usr/bin/env node
// CI runner for the offline server's tests (artifacts/local-server/src/**/*.test.ts)
// under plain Node, with tsx loading the TypeScript.
//
//   node scripts/ci/test-local-server.mjs
//
// scripts/test-local-server.mjs (the local Windows runner) uses Electron as Node,
// because on that machine better-sqlite3 is only built for Electron and the
// pnpm store lives in ./.v. On Linux CI, `pnpm install` builds better-sqlite3 for
// the runner's Node (prebuild download or node-gyp), so plain Node works.
// TEST_NODE=<path to electron> runs them under Electron as Node instead.
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
// tsx is a dependency of the scripts package.
const tsxDir = path.dirname(createRequire(path.join(root, "scripts", "package.json")).resolve("tsx/package.json"));
const loader = pathToFileURL(path.join(tsxDir, "dist", "loader.mjs")).href;

const serverDir = path.join(root, "artifacts", "local-server");
const tests = [];
const walk = (dir) => {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p);
    else if (e.name.endsWith(".test.ts")) tests.push(path.relative(serverDir, p));
  }
};
walk(path.join(serverDir, "src"));
if (tests.length === 0) {
  console.error("test-local-server: no *.test.ts files found under artifacts/local-server/src");
  process.exit(1);
}

const runtime = process.env.TEST_NODE || process.execPath;
const run = spawnSync(runtime, ["--import", loader, "--test", "--test-force-exit", ...tests], {
  cwd: serverDir,
  stdio: "inherit",
  env: {
    ...process.env,
    ...(process.env.TEST_NODE ? { ELECTRON_RUN_AS_NODE: "1" } : {}),
    // Never let a test's sync code reach the production cloud (local server defaults to it).
    CLOUD_URL: process.env.CLOUD_URL ?? "http://127.0.0.1:9",
  },
});
process.exit(run.status ?? 1);
