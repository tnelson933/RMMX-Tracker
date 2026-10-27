#!/usr/bin/env node
// Apply reviewed SQL migrations in deploy/migrations/ once each, in filename order.
//
//   node scripts/migrate.mjs            # apply pending migrations
//   node scripts/migrate.mjs --status   # list applied / pending, change nothing
//
// Each file runs in its own transaction and is recorded in app_schema_migrations.
// Files must be additive and safe to re-run (IF NOT EXISTS ...): the first run on a
// database restored from Replit re-applies files whose changes are already present.
// Used as Railway's pre-deploy command, so never put destructive SQL here without review.
import { createRequire } from "node:module";
import { readdirSync, readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const envFile = path.join(root, ".env");
if (!process.env.DATABASE_URL && existsSync(envFile)) process.loadEnvFile(envFile);
if (!process.env.DATABASE_URL) {
  console.error("migrate: DATABASE_URL is not set");
  process.exit(1);
}

const dir = path.join(root, "deploy", "migrations");
const files = readdirSync(dir).filter(f => f.endsWith(".sql")).sort();
const statusOnly = process.argv.includes("--status");

const { Client } = createRequire(path.join(root, "lib", "db", "package.json"))("pg");
const db = new Client({ connectionString: process.env.DATABASE_URL });
await db.connect();
try {
  await db.query(`CREATE TABLE IF NOT EXISTS app_schema_migrations (
    filename text PRIMARY KEY,
    applied_at timestamptz NOT NULL DEFAULT now()
  )`);
  const applied = new Set((await db.query("SELECT filename FROM app_schema_migrations")).rows.map(r => r.filename));
  const pending = files.filter(f => !applied.has(f));
  if (statusOnly) {
    for (const f of files) console.log(`${applied.has(f) ? "applied" : "PENDING"}  ${f}`);
  } else if (pending.length === 0) {
    console.log(`migrate: up to date (${files.length} migrations)`);
  } else {
    for (const f of pending) {
      const sql = readFileSync(path.join(dir, f), "utf8");
      // Files may manage their own BEGIN/COMMIT; wrapping again is harmless in Postgres
      // only if they don't, so strip a file-level transaction and wrap uniformly.
      const body = sql.replace(/^\s*BEGIN;\s*$/im, "").replace(/^\s*COMMIT;\s*$/im, "");
      await db.query("BEGIN");
      try {
        await db.query(body);
        await db.query("INSERT INTO app_schema_migrations (filename) VALUES ($1)", [f]);
        await db.query("COMMIT");
        console.log(`migrate: applied ${f}`);
      } catch (err) {
        await db.query("ROLLBACK").catch(() => {});
        console.error(`migrate: FAILED ${f}: ${err.message}`);
        process.exitCode = 1;
        break;
      }
    }
  }
} finally {
  await db.end();
}
