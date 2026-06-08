import { getDb } from "./db";

export function initDb() {
  const db = getDb();

  db.exec(`
    CREATE TABLE IF NOT EXISTS clubs (
      id         INTEGER PRIMARY KEY,
      name       TEXT NOT NULL,
      state      TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS users (
      id            INTEGER PRIMARY KEY,
      club_id       INTEGER NOT NULL,
      email         TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      role          TEXT NOT NULL DEFAULT 'organizer',
      first_name    TEXT,
      last_name     TEXT,
      created_at    TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS events (
      id             INTEGER PRIMARY KEY,
      club_id        INTEGER NOT NULL,
      name           TEXT NOT NULL,
      date           TEXT NOT NULL,
      location       TEXT,
      state          TEXT,
      status         TEXT NOT NULL DEFAULT 'draft',
      classes        TEXT NOT NULL DEFAULT '[]',
      min_lap_times  TEXT NOT NULL DEFAULT '{}',
      ama_event_id   TEXT,
      created_at     TEXT NOT NULL DEFAULT (datetime('now'))
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
      id                         INTEGER PRIMARY KEY,
      event_id                   INTEGER NOT NULL,
      rider_id                   INTEGER NOT NULL,
      race_class                 TEXT NOT NULL,
      status                     TEXT NOT NULL DEFAULT 'confirmed',
      payment_status             TEXT NOT NULL DEFAULT 'unpaid',
      bib_number                 TEXT,
      bike_brand                 TEXT,
      my_laps_transponder_number TEXT,
      club_id_number             TEXT,
      amount_paid                TEXT,
      payment_method             TEXT,
      stats_email_opt_in         INTEGER NOT NULL DEFAULT 0,
      transponder_rental         INTEGER NOT NULL DEFAULT 0,
      selected_purchase_options  TEXT NOT NULL DEFAULT '[]',
      display_first_name         TEXT,
      display_last_name          TEXT,
      created_at                 TEXT NOT NULL DEFAULT (datetime('now'))
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
      event_id     INTEGER NOT NULL UNIQUE,
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

  const migrations: Array<[string, string]> = [
    ["motos", "name           TEXT NOT NULL DEFAULT ''"],
    ["motos", "type           TEXT NOT NULL DEFAULT 'moto'"],
    ["motos", "scheduled_time TEXT"],
    ["motos", "lap_count      INTEGER"],
    ["race_results", "event_id   INTEGER"],
    ["race_results", "race_class TEXT"],
    ["race_results", "position   INTEGER"],
    ["race_results", "bib_number TEXT"],
    ["race_results", "total_time TEXT"],
    ["events", "min_lap_times TEXT NOT NULL DEFAULT '{}'"],
  ];

  for (const [table, colDef] of migrations) {
    try {
      db.prepare(`ALTER TABLE ${table} ADD COLUMN ${colDef}`).run();
    } catch {
      // Column already exists — ignore
    }
  }
}
