#!/usr/bin/env node
// Migration rehearsal (CI): proves deploy/migrations/ applies cleanly to a fresh
// database, is re-runnable, and leaves no schema the Drizzle schema doesn't know.
//
//   ADMIN_DATABASE_URL=postgres://postgres@127.0.0.1:5432/postgres node scripts/ci/migration-rehearsal.mjs
//
// Steps, each on throwaway databases this script creates and drops:
//   1. <prefix>_drizzle:  `drizzle-kit push` only (what lib/db/src/schema declares).
//   2. <prefix>_migrated: `drizzle-kit push`, then `node scripts/migrate.mjs` twice.
//      The migrations assume the base schema already exists (0001 starts from the
//      Replit production schema), so the base comes from Drizzle, as on a new dev box.
//      The second run must report "up to date" and change nothing.
//   3. Compare the two structurally (columns, indexes, constraints, enums). Any
//      difference is drift: a migration added or changed something Drizzle doesn't
//      declare, so a later `drizzle-kit push` would try to undo it. Known, reviewed
//      drift is listed in KNOWN_DRIFT below; anything else fails the run.
//
// Why not `drizzle-kit push --strict` as the drift check: on drizzle-kit 0.31 it
// always re-proposes dropping/re-adding foreign keys whose names exceed Postgres'
// 63-character limit and resetting array defaults ('{}'), and it needs a TTY to
// stop at its prompt, so it can't report drift without risking changes.
//
// Refuses any host other than localhost/127.0.0.1/::1 or the CI service ("postgres").
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const { Client } = createRequire(path.join(root, "lib", "db", "package.json"))("pg");

/**
 * Reviewed drift that is accepted for now. Each key is a line printed by this
 * script's diff. Remove an entry once the Drizzle schema declares it (the script
 * fails when a listed entry no longer differs, so this list can't go stale).
 */
const KNOWN_DRIFT = new Map([
  // Empty: list "+ index table.name" style lines here, with the reason, only for
  // drift that is understood and accepted.
]);

const adminUrl = process.env.ADMIN_DATABASE_URL;
if (!adminUrl) {
  console.error("migration-rehearsal: set ADMIN_DATABASE_URL to a maintenance database (e.g. .../postgres)");
  process.exit(2);
}
const admin = new URL(adminUrl);
if (!["localhost", "127.0.0.1", "[::1]", "postgres"].includes(admin.hostname)) {
  console.error(`migration-rehearsal: refusing non-local database host ${admin.hostname}`);
  process.exit(2);
}
const prefix = (process.env.REHEARSAL_DB_PREFIX ?? "ci_rehearsal").replace(/[^a-z0-9_]/g, "");
const dbUrl = (name) => { const u = new URL(adminUrl); u.pathname = `/${name}`; return u.toString(); };

async function withClient(url, fn) {
  const c = new Client({ connectionString: url });
  await c.connect();
  try { return await fn(c); } finally { await c.end(); }
}

async function recreate(name) {
  await withClient(adminUrl, async (c) => {
    await c.query(`DROP DATABASE IF EXISTS "${name}"`);
    await c.query(`CREATE DATABASE "${name}"`);
  });
}

async function drop(name) {
  await withClient(adminUrl, (c) => c.query(`DROP DATABASE IF EXISTS "${name}"`));
}

function run(label, cmd, args, url) {
  console.log(`\n$ ${label}`);
  const r = spawnSync(cmd, args, {
    cwd: root,
    env: { ...process.env, DATABASE_URL: url },
    encoding: "utf8",
    shell: process.platform === "win32",
  });
  const out = `${r.stdout ?? ""}${r.stderr ?? ""}`;
  // drizzle-kit draws a spinner; keep the log readable.
  process.stdout.write(out.split(/\r?\n/).filter((l) => !/Pulling schema/.test(l)).join("\n") + "\n");
  if (r.status !== 0) throw new Error(`${label} exited with ${r.status}`);
  return out;
}

const pushSchema = (url) => run("drizzle-kit push (base schema from lib/db)", "pnpm", ["--filter", "@workspace/db", "run", "push"], url, { shell: process.platform === "win32" });
const migrate = (url) => run("node scripts/migrate.mjs", process.execPath, ["scripts/migrate.mjs"], url);

/** A sorted, comparable description of the public schema. */
async function snapshot(url) {
  return withClient(url, async (c) => {
    const lines = new Set();
    const skipTable = (t) => t === "app_schema_migrations";
    const cols = await c.query(`
      SELECT table_name, column_name, data_type, udt_name, is_nullable, column_default,
             character_maximum_length, numeric_precision, numeric_scale
      FROM information_schema.columns
      WHERE table_schema = 'public'`);
    for (const r of cols.rows) {
      if (skipTable(r.table_name)) continue;
      const type = r.data_type === "USER-DEFINED" || r.data_type === "ARRAY" ? r.udt_name : r.data_type;
      const len = r.character_maximum_length ?? (r.numeric_precision != null && r.data_type === "numeric" ? `${r.numeric_precision},${r.numeric_scale}` : "");
      lines.add(`column ${r.table_name}.${r.column_name} ${type}${len ? `(${len})` : ""} ${r.is_nullable === "YES" ? "null" : "not null"} default=${r.column_default ?? "none"}`);
    }
    const idx = await c.query(`SELECT tablename, indexname, indexdef FROM pg_indexes WHERE schemaname = 'public'`);
    for (const r of idx.rows) {
      if (skipTable(r.tablename)) continue;
      lines.add(`index ${r.tablename}.${r.indexname}`);
      lines.add(`indexdef ${r.tablename}.${r.indexname} ${r.indexdef}`);
    }
    const cons = await c.query(`
      SELECT cl.relname AS table_name, co.conname, co.contype, pg_get_constraintdef(co.oid) AS def
      FROM pg_constraint co JOIN pg_class cl ON cl.oid = co.conrelid
      JOIN pg_namespace n ON n.oid = cl.relnamespace
      WHERE n.nspname = 'public'`);
    for (const r of cons.rows) {
      if (skipTable(r.table_name)) continue;
      lines.add(`constraint ${r.table_name}.${r.conname} ${r.contype} ${r.def}`);
    }
    const enums = await c.query(`
      SELECT t.typname, string_agg(e.enumlabel, ',' ORDER BY e.enumsortorder) AS labels
      FROM pg_type t JOIN pg_enum e ON e.enumtypid = t.oid
      JOIN pg_namespace n ON n.oid = t.typnamespace
      WHERE n.nspname = 'public' GROUP BY t.typname`);
    for (const r of enums.rows) lines.add(`enum ${r.typname} ${r.labels}`);
    const tables = await c.query(`SELECT tablename FROM pg_tables WHERE schemaname = 'public'`);
    for (const r of tables.rows) if (!skipTable(r.tablename)) lines.add(`table ${r.tablename}`);
    return lines;
  });
}

const drizzleDb = `${prefix}_drizzle`;
const migratedDb = `${prefix}_migrated`;
let failed = false;
try {
  await recreate(drizzleDb);
  await recreate(migratedDb);

  pushSchema(dbUrl(drizzleDb));
  pushSchema(dbUrl(migratedDb));

  const first = migrate(dbUrl(migratedDb));
  if (/FAILED/.test(first)) throw new Error("a migration failed on the first run");
  const second = migrate(dbUrl(migratedDb));
  if (!/migrate: up to date/.test(second) || /applied /.test(second)) {
    throw new Error("second migrate run was not a no-op");
  }
  const third = await snapshot(dbUrl(migratedDb));
  // Re-running every file (as on a database restored from Replit) must also succeed.
  await withClient(dbUrl(migratedDb), (c) => c.query("TRUNCATE app_schema_migrations"));
  const rerun = migrate(dbUrl(migratedDb));
  if (/FAILED/.test(rerun)) throw new Error("re-applying every migration failed (files must be re-runnable)");
  const afterRerun = await snapshot(dbUrl(migratedDb));
  const rerunDiff = [...afterRerun].filter((l) => !third.has(l)).concat([...third].filter((l) => !afterRerun.has(l)));
  if (rerunDiff.length) {
    console.error("\nRe-applying migrations changed the schema:\n  " + rerunDiff.join("\n  "));
    failed = true;
  }

  const base = await snapshot(dbUrl(drizzleDb));
  const diff = [
    ...[...afterRerun].filter((l) => !base.has(l)).map((l) => `+ ${l}`),
    ...[...base].filter((l) => !afterRerun.has(l)).map((l) => `- ${l}`),
  ].sort();
  // An index shows as "index" and "indexdef"; match known drift on the short line.
  const isKnown = (l) => KNOWN_DRIFT.has(l) || KNOWN_DRIFT.has(l.replace(/^([+-]) indexdef (\S+) .*/, "$1 index $2"));
  const unknown = diff.filter((l) => !isKnown(l));
  const stale = [...KNOWN_DRIFT.keys()].filter((k) => !diff.includes(k));

  console.log(`\nSchema comparison: Drizzle-only vs Drizzle + migrations (${afterRerun.size} schema facts)`);
  for (const l of diff.filter(isKnown)) console.log(`  known drift: ${l}`);
  if (unknown.length) {
    console.error("\nDrift between lib/db/src/schema and deploy/migrations (+ only after migrations, - only in Drizzle):");
    for (const l of unknown) console.error(`  ${l}`);
    console.error("Declare the change in the Drizzle schema too (or fix the migration).");
    failed = true;
  }
  if (stale.length) {
    console.error(`\nKNOWN_DRIFT entries that no longer differ (remove them from ${path.relative(root, fileURLToPath(import.meta.url))}):`);
    for (const l of stale) console.error(`  ${l}`);
    failed = true;
  }
  if (!failed) console.log("\nmigration-rehearsal: OK (applies from empty, second run is a no-op, files re-runnable, no unknown drift)");
} catch (err) {
  console.error(`\nmigration-rehearsal: ${err.message}`);
  failed = true;
} finally {
  if (!process.env.KEEP_REHEARSAL_DBS) {
    await drop(drizzleDb).catch(() => {});
    await drop(migratedDb).catch(() => {});
  }
}
process.exit(failed ? 1 : 0);
