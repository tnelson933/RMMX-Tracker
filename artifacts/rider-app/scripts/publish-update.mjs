#!/usr/bin/env node
// Publish an over-the-air update to riders' phones, safely.
//
//   pnpm --filter @workspace/rider-app run publish:update -- "What changed"
//   (or: node scripts/publish-update.mjs "What changed" [--channel preview] [--dry-run])
//
// Why this exists: an update's server address is baked in from the publishing
// computer's environment. On 2026-11-04 an emulator address from .env.local went
// out in a production update and broke login for everyone. This script:
//   1. refuses to run while any .env* file in this folder sets EXPO_PUBLIC_API_URL
//      (Expo loads it even when the shell doesn't);
//   2. builds with a clean environment: EXPO_PUBLIC_API_URL removed,
//      EXPO_PUBLIC_DOMAIN=www.rmroost.com, and the bundler cache cleared;
//   3. scans the iOS and Android bundles and stops if either contains a test
//      address (localhost, 127.0.0.1, 10.0.2.2, a LAN address) or lacks
//      www.rmroost.com;
//   4. only then runs `eas update` from those exact bundles, and removes dist/.
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const appDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DOMAIN = "www.rmroost.com";
const args = process.argv.slice(2);
const flag = (name) => { const i = args.indexOf(name); if (i < 0) return null; const v = args[i + 1]; args.splice(i, 2); return v; };
const dryRun = args.includes("--dry-run") ? (args.splice(args.indexOf("--dry-run"), 1), true) : false;
const channel = flag("--channel") ?? "production";
const message = args.join(" ").trim();

const fail = (msg) => { console.error(`\n✖ ${msg}\n`); process.exit(1); };
if (!message && !dryRun) fail('Say what changed: node scripts/publish-update.mjs "Fix the Go Live card"');

// 1. No .env file may point the app somewhere else.
for (const f of readdirSync(appDir).filter((n) => n.startsWith(".env"))) {
  const text = readFileSync(path.join(appDir, f), "utf8");
  if (/^\s*EXPO_PUBLIC_API_URL\s*=/m.test(text)) {
    fail(`${f} sets EXPO_PUBLIC_API_URL (a test server). Move it aside first:\n  Rename-Item ${f} ${f}.testing-bak`);
  }
}

// 2. Clean build.
const env = { ...process.env, EXPO_PUBLIC_DOMAIN: DOMAIN, NODE_ENV: "production" };
delete env.EXPO_PUBLIC_API_URL;
const dist = path.join(appDir, "dist");
rmSync(dist, { recursive: true, force: true });
const run = (cmd, cmdArgs) => {
  const r = spawnSync(cmd, cmdArgs, { cwd: appDir, env, stdio: "inherit", shell: process.platform === "win32" });
  if (r.status !== 0) fail(`${cmd} ${cmdArgs[0]} failed (exit ${r.status}).`);
};
console.log(`Building the update for ${DOMAIN}…`);
run("npx", ["expo", "export", "--platform", "all", "--output-dir", "dist", "--clear"]);

// 3. Check both bundles.
const bundles = [];
const walk = (d) => { for (const n of readdirSync(d)) { const p = path.join(d, n); if (statSync(p).isDirectory()) walk(p); else if (/\.(hbc|js)$/.test(n) && !n.endsWith(".map")) bundles.push(p); } };
walk(path.join(dist, "_expo", "static", "js"));
const native = bundles.filter((b) => /[\\/](ios|android)[\\/]/.test(b));
if (native.length < 2) fail("Expected an iOS and an Android bundle in dist/_expo/static/js.");
const BAD = [/10\.0\.2\.2/, /\blocalhost:\d/, /127\.0\.0\.1/, /http:\/\/192\.168\./, /\.localhost:\d/];
for (const b of native) {
  // Library defaults that are in every bundle and never used to reach our API:
  // React Native's dev server (Libraries/Core/Devtools/getDevServer.js) and Expo
  // Router's web-preview origin (expo-router/build/head/url.js). Any OTHER local
  // address still stops the publish.
  const LIBRARY_DEFAULTS = ["http://localhost:8081", "http://localhost:3000"];
  let text = readFileSync(b).toString("latin1");
  for (const known of LIBRARY_DEFAULTS) text = text.split(known).join("");
  const bad = BAD.find((re) => re.test(text));
  if (bad) fail(`${path.relative(appDir, b)} contains a test address (${bad}). Nothing was published.`);
  if (!text.includes(DOMAIN)) fail(`${path.relative(appDir, b)} doesn't contain ${DOMAIN}. Nothing was published.`);
}
console.log(`✔ Bundles checked: ${native.length} native bundles point at ${DOMAIN} and contain no test addresses.`);

// 4. Publish exactly what was checked.
if (dryRun) {
  console.log("Dry run: not publishing. dist/ left in place for inspection.");
  process.exit(0);
}
run("npx", ["eas", "update", "--channel", channel, "--skip-bundler", "--input-dir", "dist", "--non-interactive", "--message", message]);
rmSync(dist, { recursive: true, force: true });
console.log(`\n✔ Published to the ${channel} channel. Phones get it on the next open (sometimes a second relaunch).`);
