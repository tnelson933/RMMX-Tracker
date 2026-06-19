import { getDb } from "./db";

export function initDb() {
  const db = getDb();

  // ── MIGRATION: Add AUTOINCREMENT to the events table ─────────────────────
  // Without AUTOINCREMENT, desktop-created events start at ID=1 and collide
  // with cloud events (Postgres also starts at 1).  The collision puts the
  // desktop event ID into _write_queue, which then appears in pendingIds and
  // permanently blocks the cloud version from being upserted during pull.
  // The migration must run BEFORE the CREATE TRIGGER statements below so that
  // the triggers (re)created by CREATE TRIGGER IF NOT EXISTS are on the new table.
  {
    const row = db
      .prepare(
        "SELECT sql FROM sqlite_master WHERE type='table' AND name='events'",
      )
      .get() as { sql: string } | undefined;

    if (row && !row.sql.toUpperCase().includes("AUTOINCREMENT")) {
      // Determine which columns the old table actually has so we only copy what
      // both old and new tables share (avoids "no such column" errors on older DBs).
      const existingCols = (
        db.prepare("PRAGMA table_info(events)").all() as Array<{ name: string }>
      ).map((r) => r.name);

      const newCols = [
        "id", "club_id", "name", "date", "location", "state", "track_name",
        "race_classes", "registration_open", "registration_close", "status",
        "payment_enabled", "require_ama", "entry_fee", "max_riders",
        "race_class_limits", "purchase_options", "image_url",
        "timing_technology", "transponder_rental_enabled",
        "transponder_rental_fee", "no_duplicate_bibs", "require_club_id",
        "scoring_table_id", "entry_fee_category_id", "min_lap_ms",
        "ama_event_id", "end_date", "created_at", "image_sync_attempts",
      ];
      const colsToCopy = newCols.filter((c) => existingCols.includes(c));
      const colList = colsToCopy.join(", ");

      // Wrap in a transaction: if anything fails, the original table is untouched.
      db.transaction(() => {
        db.prepare("DROP TABLE IF EXISTS events_new").run();
        db.prepare(`
          CREATE TABLE events_new (
            id                         INTEGER PRIMARY KEY AUTOINCREMENT,
            club_id                    INTEGER NOT NULL,
            name                       TEXT NOT NULL,
            date                       TEXT NOT NULL,
            location                   TEXT,
            state                      TEXT NOT NULL DEFAULT '',
            track_name                 TEXT,
            race_classes               TEXT NOT NULL DEFAULT '[]',
            registration_open          TEXT,
            registration_close         TEXT,
            status                     TEXT NOT NULL DEFAULT 'draft',
            payment_enabled            INTEGER NOT NULL DEFAULT 0,
            require_ama                INTEGER NOT NULL DEFAULT 0,
            entry_fee                  TEXT,
            max_riders                 INTEGER,
            race_class_limits          TEXT NOT NULL DEFAULT '{}',
            purchase_options           TEXT NOT NULL DEFAULT '[]',
            image_url                  TEXT,
            timing_technology          TEXT NOT NULL DEFAULT 'rfid',
            transponder_rental_enabled INTEGER NOT NULL DEFAULT 0,
            transponder_rental_fee     TEXT,
            no_duplicate_bibs          INTEGER NOT NULL DEFAULT 0,
            require_club_id            INTEGER NOT NULL DEFAULT 0,
            scoring_table_id           INTEGER,
            entry_fee_category_id      INTEGER,
            min_lap_ms                 INTEGER,
            ama_event_id               TEXT,
            end_date                   TEXT,
            created_at                 TEXT NOT NULL DEFAULT (datetime('now')),
            image_sync_attempts        INTEGER NOT NULL DEFAULT 0
          )
        `).run();
        db.prepare(
          `INSERT INTO events_new (${colList}) SELECT ${colList} FROM events`,
        ).run();
        // Fix up sqlite_sequence so the new table knows its max-seen ID
        try {
          db.prepare(
            "UPDATE sqlite_sequence SET name = 'events' WHERE name = 'events_new'",
          ).run();
        } catch { /* sqlite_sequence may not exist yet */ }
        db.prepare("DROP TABLE events").run();
        db.prepare("ALTER TABLE events_new RENAME TO events").run();
      })();
      // Triggers on the old table were dropped with it; CREATE TRIGGER IF NOT
      // EXISTS below will recreate them on the new table.
    }
  }

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
      password_hash TEXT,
      role          TEXT NOT NULL DEFAULT 'organizer',
      first_name    TEXT,
      last_name     TEXT,
      created_at    TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS events (
      id                         INTEGER PRIMARY KEY AUTOINCREMENT,
      club_id                    INTEGER NOT NULL,
      name                       TEXT NOT NULL,
      date                       TEXT NOT NULL,
      location                   TEXT,
      state                      TEXT NOT NULL DEFAULT '',
      track_name                 TEXT,
      race_classes               TEXT NOT NULL DEFAULT '[]',
      registration_open          TEXT,
      registration_close         TEXT,
      status                     TEXT NOT NULL DEFAULT 'draft',
      payment_enabled            INTEGER NOT NULL DEFAULT 0,
      require_ama                INTEGER NOT NULL DEFAULT 0,
      entry_fee                  TEXT,
      max_riders                 INTEGER,
      race_class_limits          TEXT NOT NULL DEFAULT '{}',
      purchase_options           TEXT NOT NULL DEFAULT '[]',
      image_url                  TEXT,
      timing_technology          TEXT NOT NULL DEFAULT 'rfid',
      transponder_rental_enabled INTEGER NOT NULL DEFAULT 0,
      transponder_rental_fee     TEXT,
      no_duplicate_bibs          INTEGER NOT NULL DEFAULT 0,
      require_club_id            INTEGER NOT NULL DEFAULT 0,
      scoring_table_id           INTEGER,
      entry_fee_category_id      INTEGER,
      min_lap_ms                 INTEGER,
      ama_event_id               TEXT,
      end_date                   TEXT,
      created_at                 TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS riders (
      id                   INTEGER PRIMARY KEY,
      first_name           TEXT NOT NULL DEFAULT '',
      last_name            TEXT NOT NULL DEFAULT '',
      email                TEXT,
      phone                TEXT,
      bib_number           TEXT,
      date_of_birth        TEXT,
      emergency_contact    TEXT,
      emergency_phone      TEXT,
      rfid_number          TEXT,
      street_address       TEXT,
      city                 TEXT,
      home_state           TEXT,
      zip                  TEXT,
      bike_manufacturer    TEXT,
      bike_model           TEXT,
      bike_year            TEXT,
      sponsors             TEXT,
      ama_number           TEXT,
      mylaps_transponder_id TEXT,
      created_at           TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS registrations (
      id                         INTEGER PRIMARY KEY,
      event_id                   INTEGER NOT NULL,
      rider_id                   INTEGER NOT NULL,
      race_class                 TEXT NOT NULL,
      status                     TEXT NOT NULL DEFAULT 'confirmed',
      payment_status             TEXT NOT NULL DEFAULT 'unpaid',
      payment_method             TEXT,
      amount_paid                TEXT,
      bib_number                 TEXT,
      ama_number                 TEXT,
      club_id_number             TEXT,
      bike_brand                 TEXT,
      bike_model                 TEXT,
      bike_year                  TEXT,
      sponsors                   TEXT,
      stats_email_opt_in         INTEGER NOT NULL DEFAULT 0,
      transponder_rental         INTEGER NOT NULL DEFAULT 0,
      mylaps_transponder_number  TEXT,
      selected_purchase_options  TEXT NOT NULL DEFAULT '[]',
      comp_code                  TEXT,
      comp_discount              TEXT,
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
      id                     INTEGER PRIMARY KEY,
      event_id               INTEGER NOT NULL,
      name                   TEXT NOT NULL DEFAULT '',
      type                   TEXT NOT NULL DEFAULT 'moto',
      race_class             TEXT NOT NULL DEFAULT '',
      race_classes           TEXT,
      status                 TEXT NOT NULL DEFAULT 'scheduled',
      moto_number            INTEGER NOT NULL DEFAULT 0,
      scheduled_time         TEXT,
      lineup                 TEXT NOT NULL DEFAULT '[]',
      lap_count              INTEGER,
      time_limit_ms          INTEGER,
      practice_mode          TEXT,
      countdown_seconds      INTEGER,
      started_at             TEXT,
      completed_at           TEXT,
      staggered_with_moto_id INTEGER,
      staggered_order        INTEGER,
      created_at             TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS race_results (
      id         INTEGER PRIMARY KEY,
      event_id   INTEGER NOT NULL,
      moto_id    INTEGER NOT NULL,
      rider_id   INTEGER NOT NULL,
      race_class TEXT NOT NULL DEFAULT '',
      position   INTEGER NOT NULL DEFAULT 999,
      total_time TEXT,
      lap_times  TEXT NOT NULL DEFAULT '[]',
      points     INTEGER,
      dnf        INTEGER NOT NULL DEFAULT 0,
      dns        INTEGER NOT NULL DEFAULT 0,
      bib_number TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS lap_crossings (
      id            INTEGER PRIMARY KEY,
      event_id      INTEGER NOT NULL,
      moto_id       INTEGER NOT NULL,
      rider_id      INTEGER,
      rfid_number   TEXT NOT NULL,
      crossing_time TEXT NOT NULL,
      lap_number    INTEGER,
      lap_time_ms   INTEGER,
      reader_id     TEXT,
      antenna_id    INTEGER,
      created_at    TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_lap_crossings_moto_rfid
      ON lap_crossings (moto_id, rfid_number);

    CREATE TABLE IF NOT EXISTS practice_sessions (
      id          INTEGER PRIMARY KEY,
      club_id     INTEGER NOT NULL,
      name        TEXT NOT NULL,
      status      TEXT NOT NULL DEFAULT 'idle',
      debounce_ms INTEGER NOT NULL DEFAULT 10000,
      started_at  TEXT,
      ended_at    TEXT,
      created_at  TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS practice_crossings (
      id            INTEGER PRIMARY KEY,
      session_id    INTEGER NOT NULL,
      rfid_number   TEXT NOT NULL,
      rider_id      INTEGER,
      rider_name    TEXT,
      bib_number    TEXT,
      crossing_time TEXT NOT NULL,
      lap_number    INTEGER NOT NULL DEFAULT 0,
      lap_time_ms   INTEGER,
      created_at    TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_practice_crossings_session
      ON practice_crossings (session_id, rfid_number);

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
      season           TEXT NOT NULL DEFAULT '',
      classes          TEXT NOT NULL DEFAULT '[]',
      event_ids        TEXT NOT NULL DEFAULT '[]',
      points_system    TEXT NOT NULL DEFAULT 'standard',
      scoring_table_id INTEGER,
      created_at       TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS points_tables (
      id                 INTEGER PRIMARY KEY,
      club_id            INTEGER,
      name               TEXT NOT NULL,
      description        TEXT NOT NULL DEFAULT '',
      scoring_method     TEXT NOT NULL DEFAULT 'highest_points',
      main_event_only    INTEGER NOT NULL DEFAULT 0,
      points_scale       TEXT NOT NULL DEFAULT '[]',
      scoring_formula    TEXT,
      is_system_default  INTEGER NOT NULL DEFAULT 0,
      auto_dnf_enabled   INTEGER NOT NULL DEFAULT 0,
      auto_dnf_threshold INTEGER NOT NULL DEFAULT 75,
      created_at         TEXT NOT NULL DEFAULT (datetime('now'))
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

    -- Guard flag set by the sync-engine during cloud-pull upserts.
    -- Triggers skip enqueue when this table has a row (active = 1) so that
    -- cloud-originated rows do not echo back into the push queue.
    CREATE TABLE IF NOT EXISTS discount_categories (
      id         INTEGER PRIMARY KEY,
      club_id    INTEGER NOT NULL,
      name       TEXT    NOT NULL,
      description TEXT,
      created_at TEXT    NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS comp_codes (
      id            INTEGER PRIMARY KEY,
      event_id      INTEGER,
      club_id       INTEGER,
      rider_id      INTEGER,
      code          TEXT NOT NULL,
      discount_type TEXT NOT NULL DEFAULT 'fixed',
      amount        REAL NOT NULL DEFAULT 0,
      max_uses      INTEGER NOT NULL DEFAULT 1,
      uses_count    INTEGER NOT NULL DEFAULT 0,
      is_active     INTEGER NOT NULL DEFAULT 1,
      expires_at    TEXT,
      category_ids  TEXT NOT NULL DEFAULT '[]',
      created_at    TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS _cloud_pull_guard (
      active INTEGER PRIMARY KEY
    );

    CREATE TABLE IF NOT EXISTS _sync_watermarks (
      table_name     TEXT PRIMARY KEY,
      last_pulled_at TEXT NOT NULL DEFAULT '1970-01-01T00:00:00.000Z',
      updated_at     TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS _sync_state (
      id              INTEGER PRIMARY KEY CHECK (id = 1),
      last_attempt_at TEXT,
      last_success_at TEXT,
      last_error      TEXT,
      rows_synced     TEXT NOT NULL DEFAULT '{}'
    );

    INSERT OR IGNORE INTO _sync_state (id) VALUES (1);

    -- Desktop write queue: rows inserted by SQLite triggers on every local write.
    -- The Electron sync engine polls this table and pushes changes to the cloud.
    CREATE TABLE IF NOT EXISTS _write_queue (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      table_name    TEXT NOT NULL,
      record_id     INTEGER NOT NULL,
      operation     TEXT NOT NULL DEFAULT 'upsert',
      created_at    TEXT NOT NULL DEFAULT (datetime('now')),
      synced_at     TEXT,
      error         TEXT,
      attempt_count INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_write_queue_unsynced
      ON _write_queue (synced_at, attempt_count)
      WHERE synced_at IS NULL;

    -- Triggers: automatically enqueue a row whenever any mutable club table is written.
    -- These are idempotent (CREATE TRIGGER IF NOT EXISTS is supported in SQLite 3.35+).
    -- Covers ALL tables that the organizer can edit on the desktop so every local
    -- change is pushed to the cloud and the web portal stays in lockstep.

    -- lap_crossings (timing data written by RFID reader)
    CREATE TRIGGER IF NOT EXISTS _wq_lap_crossings_insert
    AFTER INSERT ON lap_crossings
    WHEN NOT EXISTS (SELECT 1 FROM _cloud_pull_guard)
    BEGIN
      INSERT INTO _write_queue (table_name, record_id, operation) VALUES ('lap_crossings', NEW.id, 'insert');
    END;

    -- race_results (enter/edit results)
    CREATE TRIGGER IF NOT EXISTS _wq_race_results_insert
    AFTER INSERT ON race_results
    WHEN NOT EXISTS (SELECT 1 FROM _cloud_pull_guard)
    BEGIN
      INSERT INTO _write_queue (table_name, record_id, operation) VALUES ('race_results', NEW.id, 'upsert');
    END;
    CREATE TRIGGER IF NOT EXISTS _wq_race_results_update
    AFTER UPDATE ON race_results
    WHEN NOT EXISTS (SELECT 1 FROM _cloud_pull_guard)
    BEGIN
      INSERT INTO _write_queue (table_name, record_id, operation) VALUES ('race_results', NEW.id, 'upsert');
    END;

    -- motos (moto status, lineup changes)
    CREATE TRIGGER IF NOT EXISTS _wq_motos_insert
    AFTER INSERT ON motos
    WHEN NOT EXISTS (SELECT 1 FROM _cloud_pull_guard)
    BEGIN
      INSERT INTO _write_queue (table_name, record_id, operation) VALUES ('motos', NEW.id, 'upsert');
    END;
    CREATE TRIGGER IF NOT EXISTS _wq_motos_update
    AFTER UPDATE ON motos
    WHEN NOT EXISTS (SELECT 1 FROM _cloud_pull_guard)
    BEGIN
      INSERT INTO _write_queue (table_name, record_id, operation) VALUES ('motos', NEW.id, 'upsert');
    END;

    -- checkins (check in / RFID link)
    CREATE TRIGGER IF NOT EXISTS _wq_checkins_insert
    AFTER INSERT ON checkins
    WHEN NOT EXISTS (SELECT 1 FROM _cloud_pull_guard)
    BEGIN
      INSERT INTO _write_queue (table_name, record_id, operation) VALUES ('checkins', NEW.id, 'upsert');
    END;
    CREATE TRIGGER IF NOT EXISTS _wq_checkins_update
    AFTER UPDATE ON checkins
    WHEN NOT EXISTS (SELECT 1 FROM _cloud_pull_guard)
    BEGIN
      INSERT INTO _write_queue (table_name, record_id, operation) VALUES ('checkins', NEW.id, 'upsert');
    END;

    -- registrations (on-site walk-up registrations or edits)
    CREATE TRIGGER IF NOT EXISTS _wq_registrations_insert
    AFTER INSERT ON registrations
    WHEN NOT EXISTS (SELECT 1 FROM _cloud_pull_guard)
    BEGIN
      INSERT INTO _write_queue (table_name, record_id, operation) VALUES ('registrations', NEW.id, 'upsert');
    END;
    CREATE TRIGGER IF NOT EXISTS _wq_registrations_update
    AFTER UPDATE ON registrations
    WHEN NOT EXISTS (SELECT 1 FROM _cloud_pull_guard)
    BEGIN
      INSERT INTO _write_queue (table_name, record_id, operation) VALUES ('registrations', NEW.id, 'upsert');
    END;

    -- riders (new rider created at the gate)
    CREATE TRIGGER IF NOT EXISTS _wq_riders_insert
    AFTER INSERT ON riders
    WHEN NOT EXISTS (SELECT 1 FROM _cloud_pull_guard)
    BEGIN
      INSERT INTO _write_queue (table_name, record_id, operation) VALUES ('riders', NEW.id, 'upsert');
    END;
    CREATE TRIGGER IF NOT EXISTS _wq_riders_update
    AFTER UPDATE ON riders
    WHEN NOT EXISTS (SELECT 1 FROM _cloud_pull_guard)
    BEGIN
      INSERT INTO _write_queue (table_name, record_id, operation) VALUES ('riders', NEW.id, 'upsert');
    END;

    -- rfid_assignments (assign transponder to rider at event)
    CREATE TRIGGER IF NOT EXISTS _wq_rfid_assignments_insert
    AFTER INSERT ON rfid_assignments
    WHEN NOT EXISTS (SELECT 1 FROM _cloud_pull_guard)
    BEGIN
      INSERT INTO _write_queue (table_name, record_id, operation) VALUES ('rfid_assignments', NEW.id, 'upsert');
    END;
    CREATE TRIGGER IF NOT EXISTS _wq_rfid_assignments_update
    AFTER UPDATE ON rfid_assignments
    WHEN NOT EXISTS (SELECT 1 FROM _cloud_pull_guard)
    BEGIN
      INSERT INTO _write_queue (table_name, record_id, operation) VALUES ('rfid_assignments', NEW.id, 'upsert');
    END;

    -- events (new events created on desktop)
    CREATE TRIGGER IF NOT EXISTS _wq_events_insert
    AFTER INSERT ON events
    WHEN NOT EXISTS (SELECT 1 FROM _cloud_pull_guard)
    BEGIN
      INSERT INTO _write_queue (table_name, record_id, operation) VALUES ('events', NEW.id, 'upsert');
    END;

    -- events (status changes, class list updates made on desktop)
    CREATE TRIGGER IF NOT EXISTS _wq_events_update
    AFTER UPDATE ON events
    WHEN NOT EXISTS (SELECT 1 FROM _cloud_pull_guard)
    BEGIN
      INSERT INTO _write_queue (table_name, record_id, operation) VALUES ('events', NEW.id, 'upsert');
    END;

    -- events (deletions on desktop — record the id before the row disappears)
    CREATE TRIGGER IF NOT EXISTS _wq_events_delete
    AFTER DELETE ON events
    WHEN NOT EXISTS (SELECT 1 FROM _cloud_pull_guard)
    BEGIN
      INSERT INTO _write_queue (table_name, record_id, operation) VALUES ('events', OLD.id, 'delete');
    END;

    -- practice_sessions (start / stop / name changes on desktop)
    CREATE TRIGGER IF NOT EXISTS _wq_practice_sessions_insert
    AFTER INSERT ON practice_sessions
    WHEN NOT EXISTS (SELECT 1 FROM _cloud_pull_guard)
    BEGIN
      INSERT INTO _write_queue (table_name, record_id, operation) VALUES ('practice_sessions', NEW.id, 'upsert');
    END;
    CREATE TRIGGER IF NOT EXISTS _wq_practice_sessions_update
    AFTER UPDATE ON practice_sessions
    WHEN NOT EXISTS (SELECT 1 FROM _cloud_pull_guard)
    BEGIN
      INSERT INTO _write_queue (table_name, record_id, operation) VALUES ('practice_sessions', NEW.id, 'upsert');
    END;

    -- practice_crossings (RFID reads during practice mode — insert-only, immutable)
    CREATE TRIGGER IF NOT EXISTS _wq_practice_crossings_insert
    AFTER INSERT ON practice_crossings
    WHEN NOT EXISTS (SELECT 1 FROM _cloud_pull_guard)
    BEGIN
      INSERT INTO _write_queue (table_name, record_id, operation) VALUES ('practice_crossings', NEW.id, 'insert');
    END;
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS password_setup_tokens (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id    INTEGER NOT NULL,
      token      TEXT NOT NULL UNIQUE,
      expires_at TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS rider_accounts (
      id            INTEGER PRIMARY KEY,
      email         TEXT    NOT NULL UNIQUE,
      created_at    TEXT    NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS rider_push_tokens (
      id                INTEGER PRIMARY KEY,
      rider_account_id  INTEGER NOT NULL REFERENCES rider_accounts(id) ON DELETE CASCADE,
      expo_push_token   TEXT    NOT NULL UNIQUE,
      created_at        TEXT    NOT NULL DEFAULT (datetime('now'))
    );
  `);

  // Schema migrations — safely add any column that might be missing on older DBs.
  // Each entry is [table, "col_name  TYPE  DEFAULT ..."].
  // ALTER TABLE ADD COLUMN is idempotent: errors are swallowed when column already exists.
  const migrations: Array<[string, string]> = [
    // events
    ["events", "track_name                 TEXT"],
    ["events", "race_classes               TEXT NOT NULL DEFAULT '[]'"],
    ["events", "registration_open          TEXT"],
    ["events", "registration_close         TEXT"],
    ["events", "payment_enabled            INTEGER NOT NULL DEFAULT 0"],
    ["events", "require_ama                INTEGER NOT NULL DEFAULT 0"],
    ["events", "entry_fee                  TEXT"],
    ["events", "max_riders                 INTEGER"],
    ["events", "race_class_limits          TEXT NOT NULL DEFAULT '{}'"],
    ["events", "purchase_options           TEXT NOT NULL DEFAULT '[]'"],
    ["events", "image_url                  TEXT"],
    ["events", "timing_technology          TEXT NOT NULL DEFAULT 'rfid'"],
    ["events", "transponder_rental_enabled INTEGER NOT NULL DEFAULT 0"],
    ["events", "transponder_rental_fee     TEXT"],
    ["events", "no_duplicate_bibs          INTEGER NOT NULL DEFAULT 0"],
    ["events", "require_club_id            INTEGER NOT NULL DEFAULT 0"],
    ["events", "scoring_table_id           INTEGER"],
    ["events", "entry_fee_category_id      INTEGER"],
    ["events", "min_lap_ms                 INTEGER"],
    // keep legacy column name for backward compat (old rows may reference it)
    ["events", "min_lap_times              TEXT NOT NULL DEFAULT '{}'"],
    ["events", "ama_event_id               TEXT"],
    // users
    ["users", "tour_completed INTEGER NOT NULL DEFAULT 0"],
    ["users", "name           TEXT NOT NULL DEFAULT ''"],
    ["users", "permissions    TEXT NOT NULL DEFAULT '[]'"],
    // clubs
    ["clubs", "contact_email    TEXT"],
    ["clubs", "contact_phone    TEXT"],
    ["clubs", "logo_url         TEXT"],
    ["clubs", "website          TEXT"],
    ["clubs", "description      TEXT"],
    ["clubs", "auto_dnf_enabled   INTEGER NOT NULL DEFAULT 0"],
    ["clubs", "auto_dnf_threshold INTEGER NOT NULL DEFAULT 75"],
    // series
    ["series", "season        TEXT NOT NULL DEFAULT ''"],
    ["series", "points_system TEXT NOT NULL DEFAULT 'standard'"],
    // points_tables (table created above; add any future columns here)
    ["points_tables", "auto_dnf_enabled   INTEGER NOT NULL DEFAULT 0"],
    ["points_tables", "auto_dnf_threshold INTEGER NOT NULL DEFAULT 75"],
    // riders
    ["riders", "bib_number            TEXT"],
    ["riders", "date_of_birth         TEXT"],
    ["riders", "emergency_contact     TEXT"],
    ["riders", "emergency_phone       TEXT"],
    ["riders", "street_address        TEXT"],
    ["riders", "city                  TEXT"],
    ["riders", "home_state            TEXT"],
    ["riders", "zip                   TEXT"],
    ["riders", "bike_manufacturer     TEXT"],
    ["riders", "bike_model            TEXT"],
    ["riders", "bike_year             TEXT"],
    ["riders", "sponsors              TEXT"],
    ["riders", "ama_number            TEXT"],
    ["riders", "mylaps_transponder_id TEXT"],
    // registrations
    ["registrations", "ama_number                TEXT"],
    ["registrations", "bike_brand                TEXT"],
    ["registrations", "bike_model                TEXT"],
    ["registrations", "bike_year                 TEXT"],
    ["registrations", "sponsors                  TEXT"],
    ["registrations", "club_id_number            TEXT"],
    ["registrations", "stats_email_opt_in        INTEGER NOT NULL DEFAULT 0"],
    ["registrations", "transponder_rental        INTEGER NOT NULL DEFAULT 0"],
    ["registrations", "comp_code                 TEXT"],
    ["registrations", "comp_discount             TEXT"],
    // rename old mylaps column (keep old for compat)
    ["registrations", "mylaps_transponder_number TEXT"],
    ["registrations", "selected_purchase_options TEXT NOT NULL DEFAULT '[]'"],
    ["registrations", "display_first_name        TEXT"],
    ["registrations", "display_last_name         TEXT"],
    // motos
    ["motos", "name                   TEXT NOT NULL DEFAULT ''"],
    ["motos", "type                   TEXT NOT NULL DEFAULT 'moto'"],
    ["motos", "race_classes           TEXT"],
    ["motos", "scheduled_time         TEXT"],
    ["motos", "lap_count              INTEGER"],
    ["motos", "time_limit_ms          INTEGER"],
    ["motos", "practice_mode          TEXT"],
    ["motos", "countdown_seconds      INTEGER"],
    ["motos", "staggered_with_moto_id INTEGER"],
    ["motos", "staggered_order        INTEGER"],
    // race_results
    ["race_results", "event_id   INTEGER"],
    ["race_results", "race_class TEXT"],
    ["race_results", "position   INTEGER"],
    ["race_results", "bib_number TEXT"],
    ["race_results", "total_time TEXT"],
    ["race_results", "points     INTEGER"],
    // lap_crossings
    ["lap_crossings", "created_at TEXT NOT NULL DEFAULT (datetime('now'))"],
    // _sync_watermarks — ensure new column names exist on older schemas
    ["_sync_watermarks", "last_pulled_at TEXT NOT NULL DEFAULT '1970-01-01T00:00:00.000Z'"],
    ["_sync_watermarks", "updated_at     TEXT NOT NULL DEFAULT (datetime('now'))"],
    // clubs — Stripe Connect fields
    ["clubs", "stripe_account_id          TEXT"],
    ["clubs", "stripe_onboarding_complete INTEGER NOT NULL DEFAULT 0"],
    // users — push notification rate limiting
    ["users", "last_push_sent_at TEXT"],
    // events — multi-day support
    ["events", "end_date TEXT"],
    // image sync retry counters — stops runaway retries for permanently-broken images
    ["events", "image_sync_attempts INTEGER NOT NULL DEFAULT 0"],
    ["clubs",  "image_sync_attempts INTEGER NOT NULL DEFAULT 0"],
    // _cloud_pull_guard — safety: ensure it exists (created above, but just in case)
  ];

  for (const [table, colDef] of migrations) {
    try {
      db.prepare(`ALTER TABLE ${table} ADD COLUMN ${colDef}`).run();
    } catch {
      // Column already exists — ignore
    }
  }

  // Seed autoincrement sequences so desktop-created rows start at a high ID range
  // and never collide with cloud-assigned sequential IDs (1, 2, 3...).
  // ON CONFLICT DO UPDATE uses MAX so an already-elevated sequence is never lowered.
  try {
    db.exec(`
      INSERT INTO sqlite_sequence (name, seq) VALUES ('events', 9999999)
        ON CONFLICT(name) DO UPDATE SET seq = MAX(seq, excluded.seq);
      INSERT INTO sqlite_sequence (name, seq) VALUES ('practice_sessions', 9999999)
        ON CONFLICT(name) DO UPDATE SET seq = MAX(seq, excluded.seq);
    `);
  } catch {
    // sqlite_sequence doesn't exist until the first AUTOINCREMENT insert — safe to ignore on a brand-new DB
  }
}
