#!/usr/bin/env node
// Run the offline server's unit tests (artifacts/local-server/src/**/*.test.ts).
// better-sqlite3 is only built for Electron on this machine, so the tests run
// with Electron as Node, with tsx loading the TypeScript.
//
//   node scripts/test-local-server.mjs
import { spawnSync } from "node:child_process";
import { readdirSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const store = path.join(root, ".v");
const find = (prefix, rel) => {
  const dir = readdirSync(store).filter((d) => d.startsWith(prefix)).sort().reverse()
    .map((d) => path.join(store, d, rel)).find((p) => existsSync(p));
  if (!dir) throw new Error(`Not found: ${prefix} ${rel}`);
  return dir;
};
const electron = find("electron@", path.join("node_modules", "electron", "dist", process.platform === "win32" ? "electron.exe" : "electron"));
const loader = pathToFileURL(find("tsx@", path.join("node_modules", "tsx", "dist", "loader.mjs"))).href;

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

const run = spawnSync(electron, ["--import", loader, "--test", ...tests], {
  cwd: serverDir,
  stdio: "inherit",
  env: { ...process.env, ELECTRON_RUN_AS_NODE: "1", CLOUD_URL: process.env.CLOUD_URL ?? "http://127.0.0.1:9" },
});
process.exit(run.status ?? 1);
