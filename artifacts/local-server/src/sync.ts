import Database from "better-sqlite3";
import { resolve } from "path";

// ─── Config ──────────────────────────────────────────────────────────────────

const SQLITE_FILE = process.env.SQLITE_FILE  ?? process.argv[2] ?? "./race_data.db";
const CLOUD_URL   = (process.env.CLOUD_URL   ?? process.argv[3] ?? "").replace(/\/$/, "");
const CLUB_ID     = process.env.CLUB_ID      ?? process.argv[4] ?? "";
const EMAIL       = process.env.CLOUD_EMAIL  ?? process.argv[5] ?? "";
const PASSWORD    = process.env.CLOUD_PASSWORD ?? process.argv[6] ?? "";

if (!CLOUD_URL || !CLUB_ID || !EMAIL || !PASSWORD) {
  console.error(`
  Sync local SQLite → cloud Postgres.

  Usage (env vars):
    SQLITE_FILE=./race_data.db \\
    CLOUD_URL=https://your-app.replit.app \\
    CLUB_ID=1 \\
    CLOUD_EMAIL=jake@club.com \\
    CLOUD_PASSWORD=secret \\
    node dist/sync.mjs

  Usage (positional args):
    node dist/sync.mjs ./race_data.db https://your-app.replit.app 1 jake@club.com secret
`);
  process.exit(1);
}

// ─── Open SQLite ─────────────────────────────────────────────────────────────

const dbPath = resolve(SQLITE_FILE);
console.log(`\n  Database:  ${dbPath}`);
console.log(`  Cloud URL: ${CLOUD_URL}`);
console.log(`  Club ID:   ${CLUB_ID}\n`);

let db: InstanceType<typeof Database>;
try {
  db = new Database(dbPath, { readonly: true });
} catch {
  console.error(`  Cannot open database: ${dbPath}`);
  process.exit(1);
}

// ─── Read watermarks ─────────────────────────────────────────────────────────

type WatermarkRow = { table_name: string; max_imported_id: number };

let watermarkRows: WatermarkRow[] = [];
try {
  watermarkRows = db
    .prepare("SELECT table_name, max_imported_id FROM _sync_watermarks")
    .all() as WatermarkRow[];
} catch {
  console.error(
    "  _sync_watermarks table not found.\n" +
    "  Re-run the import script to create it, then retry.\n",
  );
  process.exit(1);
}

const watermarks: Record<string, number> = {};
for (const w of watermarkRows) {
  watermarks[w.table_name] = w.max_imported_id;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function toCamel(s: string): string {
  return s.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());
}

function normalizeRows(rows: Record<string, unknown>[]): Record<string, unknown>[] {
  return rows.map((row) => {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(row)) {
      out[toCamel(k)] = v;
    }
    return out;
  });
}

// ─── Read syncable tables ─────────────────────────────────────────────────────

const checkins        = normalizeRows(db.prepare("SELECT * FROM checkins").all()         as Record<string, unknown>[]);
const rfidAssignments = normalizeRows(db.prepare("SELECT * FROM rfid_assignments").all() as Record<string, unknown>[]);
const registrations   = normalizeRows(db.prepare("SELECT * FROM registrations").all()   as Record<string, unknown>[]);
const riders          = normalizeRows(db.prepare("SELECT * FROM riders").all()            as Record<string, unknown>[]);

console.log(`  Local rows:`);
console.log(`    checkins:         ${checkins.length}`);
console.log(`    rfid_assignments: ${rfidAssignments.length}`);
console.log(`    registrations:    ${registrations.length}`);
console.log(`    riders:           ${riders.length}`);

if (Object.keys(watermarks).length > 0) {
  console.log(`\n  Watermarks (max id at import):`);
  for (const [k, v] of Object.entries(watermarks)) {
    console.log(`    ${k.padEnd(18)} ${v}`);
  }
}

// ─── Authenticate ─────────────────────────────────────────────────────────────

console.log(`\n  Logging in as ${EMAIL}…`);

const loginRes = await fetch(`${CLOUD_URL}/api/auth/login`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
});

if (!loginRes.ok) {
  const body = await loginRes.text();
  console.error(`  Login failed (${loginRes.status}): ${body}`);
  process.exit(1);
}

const rawSetCookie = loginRes.headers.get("set-cookie") ?? "";
const cookieValue = rawSetCookie
  .split(",")
  .map((c) => c.trim().split(";")[0].trim())
  .filter(Boolean)
  .join("; ");

if (!cookieValue) {
  console.error("  Login succeeded but no session cookie received.");
  process.exit(1);
}

console.log(`  Logged in. Syncing…\n`);

// ─── POST sync ────────────────────────────────────────────────────────────────

const syncRes = await fetch(`${CLOUD_URL}/api/clubs/${CLUB_ID}/sync`, {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    Cookie: cookieValue,
  },
  body: JSON.stringify({
    watermarks,
    checkins,
    rfidAssignments,
    registrations,
    riders,
  }),
});

if (!syncRes.ok) {
  const body = await syncRes.text();
  console.error(`  Sync failed (${syncRes.status}): ${body}`);
  process.exit(1);
}

type SyncResult = {
  ok: boolean;
  syncedAt: string;
  results: {
    checkinsUpdated:        number;
    checkinsInserted:       number;
    rfidUpserted:           number;
    registrationsUpdated:   number;
    registrationsInserted:  number;
    ridersUpdated:          number;
    skipped:                number;
  };
};

const result = (await syncRes.json()) as SyncResult;

console.log(`  ✓  Sync complete (${result.syncedAt})\n`);
console.log(`     Checkins updated:        ${result.results.checkinsUpdated}`);
console.log(`     Checkins inserted:       ${result.results.checkinsInserted}`);
console.log(`     RFID assignments synced: ${result.results.rfidUpserted}`);
console.log(`     Registrations updated:   ${result.results.registrationsUpdated}`);
console.log(`     Registrations inserted:  ${result.results.registrationsInserted}`);
console.log(`     Riders updated:          ${result.results.ridersUpdated}`);
if (result.results.skipped > 0) {
  console.log(`     Skipped (no change):     ${result.results.skipped}`);
}
console.log();
