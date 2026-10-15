#!/usr/bin/env node
// Cross-platform local development launcher (Windows/macOS/Linux, no Replit).
//
//   node scripts/dev-local.mjs api   -> build + run the cloud API on API_PORT (8080)
//   node scripts/dev-local.mjs web   -> Vite dev server on WEB_PORT (19869), proxying /api to the API
//
// Reads secrets/config from the repo-root `.env` (gitignored; copy `.env.example`).
// The Replit package scripts (`export`, `fuser`, inline VAR=...) are left untouched.
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const envFile = path.join(root, ".env");
if (!existsSync(envFile)) {
  console.error("Missing .env at repo root. Copy .env.example to .env and fill it in.");
  process.exit(1);
}
process.loadEnvFile(envFile);

const apiPort = process.env.API_PORT ?? "8080";
const webPort = process.env.WEB_PORT ?? "19869";

function run(cmd, args, opts) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: "inherit", ...opts });
    child.on("exit", code => (code === 0 ? resolve() : reject(new Error(`${cmd} exited ${code}`))));
    process.on("SIGINT", () => child.kill("SIGINT"));
  });
}

const target = process.argv[2];
if (target === "api") {
  const cwd = path.join(root, "artifacts", "api-server");
  const env = { ...process.env, PORT: apiPort, NODE_ENV: process.env.NODE_ENV ?? "development" };
  await run(process.execPath, ["build.mjs"], { cwd, env });
  await run(process.execPath, ["--enable-source-maps", "dist/index.mjs"], { cwd, env });
} else if (target === "web") {
  const cwd = path.join(root, "artifacts", "race-platform");
  const env = {
    ...process.env,
    PORT: webPort,
    BASE_PATH: process.env.BASE_PATH ?? "/",
    DEV_API_PROXY: process.env.DEV_API_PROXY ?? `http://127.0.0.1:${apiPort}`,
  };
  const vite = path.join(cwd, "node_modules", "vite", "bin", "vite.js");
  await run(process.execPath, [vite, "--config", "vite.config.ts", "--host", "127.0.0.1"], { cwd, env });
} else {
  console.error("Usage: node scripts/dev-local.mjs <api|web>");
  process.exit(1);
}
