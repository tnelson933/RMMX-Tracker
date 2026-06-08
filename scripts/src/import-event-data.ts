import Database from "better-sqlite3";
import { readFileSync } from "fs";
import { resolve } from "path";

const exportFile = process.argv[2];
if (!exportFile) {
  console.error(
    "Usage: pnpm --filter @workspace/scripts run import-data <path-to-export.json> [path-to-output.db]",
  );
  process.exit(1);
}

const dbFile = resolve(process.argv[3] ?? "./race_data.db");
const exportPath = resolve(exportFile);

console.log(`\n  Importing from: ${exportPath}`);
console.log(`  Database:       ${dbFile}\n`);

let rawData: string;
try {
  rawData = readFileSync(exportPath, "utf-8");
} catch {
  console.error(`Cannot read export file: ${exportPath}`);
  process.exit(1);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const data: Record<string, any> = JSON.parse(rawData);
if (!data.version || !data.club) {
  console.error("Invalid export file — missing version or club data.");
  process.exit(1);
}

const db = new Database(dbFile);
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = OFF");

// ─── Schema ──────────────────────────────────────────────────────────────────

db.exec(`
CREATE TABLE IF NOT EXISTS clubs (
  id                          INTEGER PRIMARY KEY,
  name                        TEXT NOT NULL DEFAULT '',
  state                       TEXT,
  city                        TEXT,
  website                     TEXT,
  logo_url                    TEXT,
  contact_email               TEXT,
  contact_phone               TEXT,
  description                 TEXT,
  stripe_connect_account_id   TEXT,
  stripe_onboarding_complete  INTEGER NOT NULL DEFAULT 0,
  gate_seeding                TEXT,
  created_at                  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS users (
  id               INTEGER PRIMARY KEY,
  email            TEXT NOT NULL,
  password_hash    TEXT,
  name             TEXT NOT NULL DEFAULT '',
  role             TEXT NOT NULL DEFAULT 'organizer',
  club_id          INTEGER,
  stripe_customer_id TEXT,
  tour_completed   INTEGER NOT NULL DEFAULT 0,
  created_at       TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS events (
  id                          INTEGER PRIMARY KEY,
  club_id                     INTEGER NOT NULL,
  name                        TEXT NOT NULL,
  date                        TEXT NOT NULL,
  state                       TEXT NOT NULL,
  location                    TEXT,
  track_name                  TEXT,
  race_classes                TEXT NOT NULL DEFAULT '[]',
  registration_open           TEXT,
  registration_close          TEXT,
  status                      TEXT NOT NULL DEFAULT 'draft',
  payment_enabled             INTEGER NOT NULL DEFAULT 0,
  require_ama                 INTEGER NOT NULL DEFAULT 0,
  entry_fee                   TEXT,
  max_riders                  INTEGER,
  race_class_limits           TEXT DEFAULT '{}',
  purchase_options            TEXT NOT NULL DEFAULT '[]',
  image_url                   TEXT,
  timing_technology           TEXT NOT NULL DEFAULT 'rfid',
  transponder_rental_enabled  INTEGER NOT NULL DEFAULT 0,
  transponder_rental_fee      TEXT,
  no_duplicate_bibs           INTEGER NOT NULL DEFAULT 0,
  require_club_id             INTEGER NOT NULL DEFAULT 0,
  scoring_table_id            INTEGER,
  min_lap_times               TEXT DEFAULT '{}',
  ama_event_id                TEXT,
  created_at                  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS riders (
  id           INTEGER PRIMARY KEY,
  first_name   TEXT NOT NULL DEFAULT '',
  last_name    TEXT NOT NULL DEFAULT '',
  email        TEXT,
  phone        TEXT,
  rfid_number  TEXT,
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS registrations (
  id                        INTEGER PRIMARY KEY,
  event_id                  INTEGER NOT NULL,
  rider_id                  INTEGER NOT NULL,
  race_class                TEXT NOT NULL,
  status                    TEXT NOT NULL DEFAULT 'confirmed',
  payment_status            TEXT NOT NULL DEFAULT 'unpaid',
  bib_number                TEXT,
  bike_brand                TEXT,
  my_laps_transponder_number TEXT,
  club_id_number            TEXT,
  amount_paid               TEXT,
  payment_method            TEXT,
  stats_email_opt_in        INTEGER NOT NULL DEFAULT 0,
  transponder_rental        INTEGER NOT NULL DEFAULT 0,
  selected_purchase_options TEXT NOT NULL DEFAULT '[]',
  display_first_name        TEXT,
  display_last_name         TEXT,
  created_at                TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS checkins (
  id            INTEGER PRIMARY KEY,
  event_id      INTEGER NOT NULL,
  rider_id      INTEGER NOT NULL,
  race_class    TEXT NOT NULL,
  bib_number    TEXT,
  checked_in    INTEGER NOT NULL DEFAULT 0,
  checked_in_at TEXT,
  rfid_number   TEXT,
  rfid_linked   INTEGER NOT NULL DEFAULT 0,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS rfid_assignments (
  id           INTEGER PRIMARY KEY,
  rider_id     INTEGER NOT NULL,
  event_id     INTEGER NOT NULL,
  rfid_number  TEXT NOT NULL,
  assigned_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS motos (
  id             INTEGER PRIMARY KEY,
  event_id       INTEGER NOT NULL,
  name           TEXT NOT NULL DEFAULT '',
  type           TEXT NOT NULL DEFAULT 'moto',
  race_class     TEXT NOT NULL DEFAULT '',
  moto_number    INTEGER NOT NULL DEFAULT 0,
  scheduled_time TEXT,
  lineup         TEXT NOT NULL DEFAULT '[]',
  lap_count      INTEGER,
  status         TEXT NOT NULL DEFAULT 'scheduled',
  started_at     TEXT,
  completed_at   TEXT,
  created_at     TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS race_results (
  id         INTEGER PRIMARY KEY,
  event_id   INTEGER,
  moto_id    INTEGER NOT NULL,
  rider_id   INTEGER NOT NULL,
  race_class TEXT,
  position   INTEGER,
  bib_number TEXT,
  lap_times  TEXT NOT NULL DEFAULT '[]',
  total_time TEXT,
  dnf        INTEGER NOT NULL DEFAULT 0,
  dns        INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS lap_crossings (
  id            INTEGER PRIMARY KEY,
  event_id      INTEGER NOT NULL,
  moto_id       INTEGER NOT NULL,
  rider_id      INTEGER,
  rfid_number   TEXT NOT NULL,
  crossing_time TEXT NOT NULL,
  lap_number    INTEGER NOT NULL,
  lap_time_ms   INTEGER NOT NULL,
  reader_id     TEXT,
  antenna_id    INTEGER
);

CREATE INDEX IF NOT EXISTS idx_lap_crossings_moto_rfid
  ON lap_crossings (moto_id, rfid_number);

CREATE TABLE IF NOT EXISTS event_publication (
  id           INTEGER PRIMARY KEY,
  event_id     INTEGER NOT NULL,
  published    INTEGER NOT NULL DEFAULT 0,
  published_at TEXT,
  updated_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS series (
  id               INTEGER PRIMARY KEY,
  club_id          INTEGER NOT NULL,
  name             TEXT NOT NULL,
  year             INTEGER NOT NULL DEFAULT 0,
  classes          TEXT NOT NULL DEFAULT '[]',
  event_ids        TEXT NOT NULL DEFAULT '[]',
  scoring_table_id INTEGER,
  created_at       TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS series_points (
  id            INTEGER PRIMARY KEY,
  series_id     INTEGER NOT NULL,
  rider_id      INTEGER NOT NULL,
  race_class    TEXT NOT NULL,
  total_points  INTEGER NOT NULL DEFAULT 0,
  event_results TEXT NOT NULL DEFAULT '[]',
  updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS _sync_watermarks (
  table_name      TEXT PRIMARY KEY,
  max_imported_id INTEGER NOT NULL DEFAULT 0,
  last_synced_at  TEXT
);
`);

// ─── Helpers ─────────────────────────────────────────────────────────────────

function toSnake(s: string): string {
  return s.replace(/([A-Z])/g, "_$1").toLowerCase();
}

function serializeForSqlite(val: unknown): string | number | null {
  if (val === null || val === undefined) return null;
  if (typeof val === "boolean") return val ? 1 : 0;
  if (typeof val === "object") return JSON.stringify(val);
  return val as string | number;
}

type ColInfo = { name: string };

function upsertRows(tableName: string, rows: unknown[]): number {
  if (!rows || rows.length === 0) return 0;

  const tableInfo = db
    .prepare(`PRAGMA table_info(${tableName})`)
    .all() as ColInfo[];
  const sqliteColSet = new Set(tableInfo.map((c) => c.name));

  const sample = rows[0] as Record<string, unknown>;
  const colPairs = Object.keys(sample)
    .map((k) => ({ jsKey: k, sqlCol: toSnake(k) }))
    .filter(({ sqlCol }) => sqliteColSet.has(sqlCol));

  if (colPairs.length === 0) return 0;

  const cols = colPairs.map((c) => c.sqlCol);
  const placeholders = cols.map((c) => `@${c}`);

  const stmt = db.prepare(
    `INSERT OR REPLACE INTO ${tableName} (${cols.join(", ")}) VALUES (${placeholders.join(", ")})`,
  );

  let count = 0;
  const insertMany = db.transaction((rowList: unknown[]) => {
    for (const row of rowList) {
      const r = row as Record<string, unknown>;
      const record: Record<string, unknown> = {};
      for (const { jsKey, sqlCol } of colPairs) {
        record[sqlCol] = serializeForSqlite(r[jsKey]);
      }
      stmt.run(record);
      count++;
    }
  });
  insertMany(rows);

  return count;
}

// ─── Import in FK-safe order ─────────────────────────────────────────────────

const steps: [string, unknown[]][] = [
  ["clubs", [data.club]],
  ["users", data.users ?? []],
  ["events", data.events ?? []],
  ["riders", data.riders ?? []],
  ["registrations", data.registrations ?? []],
  ["checkins", data.checkins ?? []],
  ["rfid_assignments", data.rfidAssignments ?? []],
  ["motos", data.motos ?? []],
  ["race_results", data.raceResults ?? []],
  ["event_publication", data.eventPublications ?? []],
  ["series", data.series ?? []],
  ["series_points", data.seriesPoints ?? []],
];

let totalInserted = 0;

for (const [table, rows] of steps) {
  const n = upsertRows(table, rows);
  const label = table.padEnd(22);
  if (n > 0) {
    console.log(`  ✓  ${label} ${n} row${n !== 1 ? "s" : ""}`);
    totalInserted += n;
  } else {
    console.log(`  -  ${label} (none)`);
  }
}

db.pragma("foreign_keys = ON");

// ─── Write sync watermarks ────────────────────────────────────────────────────

const watermarkStmt = db.prepare(
  "INSERT OR REPLACE INTO _sync_watermarks (table_name, max_imported_id) VALUES (?, ?)",
);

const writeWatermarks = db.transaction(() => {
  for (const [table, rows] of steps) {
    if (rows && (rows as unknown[]).length > 0) {
      const ids = (rows as Record<string, unknown>[])
        .map((r) => Number(r["id"]) || 0)
        .filter((n) => n > 0);
      if (ids.length > 0) {
        watermarkStmt.run(table, Math.max(...ids));
      }
    }
  }
});
writeWatermarks();

console.log(
  `\n  Total: ${totalInserted} rows written to ${dbFile}`,
);
console.log(
  `  Sync watermarks saved — run sync-to-cloud to upload changes.\n  Done!\n`,
);
