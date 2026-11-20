import { getDb } from "./db";
import { DESKTOP_ID_FLOOR, ORG_TABLES, newDesktopId } from "./lib/desktop-ids";
import { ensureRiderTranspondersSchema } from "./lib/rider-transponders";

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
        "payment_enabled", "require_ama", "entry_fee", "early_bird_fee",
        "early_bird_ends_at", "max_riders",
        "race_class_limits", "purchase_options", "image_url",
        "timing_technology", "transponder_rental_enabled",
        "transponder_rental_fee", "no_duplicate_bibs", "require_club_id",
        "scoring_table_id", "entry_fee_category_id", "min_lap_ms",
        "ama_event_id", "race_style", "end_date", "created_at", "image_sync_attempts",
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
            early_bird_fee             TEXT,
            early_bird_ends_at         TEXT,
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
            race_style                 TEXT,
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
      race_style                 TEXT,
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
      plus_laps              INTEGER,
      practice_mode          TEXT,
      countdown_seconds      INTEGER,
      started_at             TEXT,
      time_expired_at        TEXT,
      completed_at           TEXT,
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

    CREATE TABLE IF NOT EXISTS tracks (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      club_id    INTEGER NOT NULL,
      name       TEXT NOT NULL,
      state      TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
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

    -- Durable translation between this SQLite database's rider IDs and the
    -- cloud IDs.  IDs are intentionally not rewritten locally: historic timing
    -- rows can safely retain their local foreign keys.
    CREATE TABLE IF NOT EXISTS _rider_cloud_map (
      local_rider_id INTEGER PRIMARY KEY,
      cloud_rider_id INTEGER,
      client_identity TEXT NOT NULL UNIQUE,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- Explicit rider profile outbox. The riders table is also a cloud cache, so
    -- mere row existence must never be interpreted as local write intent.
    CREATE TABLE IF NOT EXISTS _rider_profile_dirty (
      rider_id   INTEGER NOT NULL,
      field_name TEXT NOT NULL,
      version    INTEGER NOT NULL DEFAULT 1,
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (rider_id, field_name)
    );

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

    -- Deletions made on the desktop. A removed lap or result queues a snapshot
    -- of that race ('moto_race_snapshot', record_id = moto id): the sync sends
    -- the race's current laps and which riders still have a result, and the
    -- cloud makes its copy match. A removed race is sent as a delete.
    CREATE TRIGGER IF NOT EXISTS _wq_lap_crossings_delete
    AFTER DELETE ON lap_crossings
    WHEN NOT EXISTS (SELECT 1 FROM _cloud_pull_guard)
    BEGIN
      INSERT INTO _write_queue (table_name, record_id, operation) VALUES ('moto_race_snapshot', OLD.moto_id, 'upsert');
    END;
    CREATE TRIGGER IF NOT EXISTS _wq_race_results_delete
    AFTER DELETE ON race_results
    WHEN NOT EXISTS (SELECT 1 FROM _cloud_pull_guard)
    BEGIN
      INSERT INTO _write_queue (table_name, record_id, operation) VALUES ('moto_race_snapshot', OLD.moto_id, 'upsert');
    END;
    CREATE TRIGGER IF NOT EXISTS _wq_motos_delete
    AFTER DELETE ON motos
    WHEN NOT EXISTS (SELECT 1 FROM _cloud_pull_guard)
    BEGIN
      INSERT INTO _write_queue (table_name, record_id, operation) VALUES ('motos', OLD.id, 'delete');
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

  // Rider writes use the field-level outbox above. Remove triggers installed by
  // older versions, and discard their ambiguous rider queue entries: they do not
  // contain enough information to distinguish edits from untouched pulled rows.
  db.exec(`
    DROP TRIGGER IF EXISTS _wq_riders_insert;
    DROP TRIGGER IF EXISTS _wq_riders_update;
    DELETE FROM _write_queue WHERE table_name = 'riders';
  `);

  // ── MIGRATION: Add auto_dnf_enabled / auto_dnf_threshold to clubs ────────
  // Existing installs have a 4-column clubs table; these columns were added
  // later. ALTER TABLE is idempotent via the PRAGMA table_info guard.
  {
    const clubCols = (
      db.prepare("PRAGMA table_info(clubs)").all() as Array<{ name: string }>
    ).map((r) => r.name);

    if (!clubCols.includes("auto_dnf_enabled")) {
      db.prepare(
        "ALTER TABLE clubs ADD COLUMN auto_dnf_enabled INTEGER NOT NULL DEFAULT 0",
      ).run();
    }
    if (!clubCols.includes("auto_dnf_threshold")) {
      db.prepare(
        "ALTER TABLE clubs ADD COLUMN auto_dnf_threshold INTEGER NOT NULL DEFAULT 75",
      ).run();
    }
  }

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
    // checkins: rider reported wrong RM TrackR / RFID numbers at Quick Check-In (cloud)
    ["checkins", "numbers_flagged_at         TEXT"],
    // events
    ["events", "track_name                 TEXT"],
    ["events", "race_classes               TEXT NOT NULL DEFAULT '[]'"],
    ["events", "registration_open          TEXT"],
    ["events", "registration_close         TEXT"],
    ["events", "payment_enabled            INTEGER NOT NULL DEFAULT 0"],
    ["events", "require_ama                INTEGER NOT NULL DEFAULT 0"],
    ["events", "entry_fee                  TEXT"],
    ["events", "early_bird_fee             TEXT"],
    ["events", "early_bird_ends_at         TEXT"],
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
    ["events", "race_style                 TEXT"],
    // users
    ["users", "tour_completed INTEGER NOT NULL DEFAULT 0"],
    ["users", "name           TEXT NOT NULL DEFAULT ''"],
    ["users", "permissions    TEXT NOT NULL DEFAULT '[]'"],
    // clubs
    ["clubs", "contact_email          TEXT"],
    ["clubs", "contact_phone          TEXT"],
    ["clubs", "logo_url               TEXT"],
    ["clubs", "website                TEXT"],
    ["clubs", "description            TEXT"],
    ["clubs", "auto_dnf_enabled       INTEGER NOT NULL DEFAULT 0"],
    ["clubs", "auto_dnf_threshold     INTEGER NOT NULL DEFAULT 75"],
    ["clubs", "rider_acknowledgement  TEXT"],
    ["clubs", "default_classes        TEXT NOT NULL DEFAULT '[]'"],
    ["clubs", "track_name             TEXT"],
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
    // Legacy transponder column retained for database compatibility.
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
    ["motos", "plus_laps              INTEGER"],
    ["motos", "time_expired_at        TEXT"],
    ["motos", "practice_mode          TEXT"],
    ["motos", "countdown_seconds      INTEGER"],
    ["motos", "staggered_order        INTEGER"],
    ["motos", "staggered_group_id     INTEGER"],
    // The start group leaves the gate together (classes combined on one gate, scored separately).
    ["motos", "combined_start         INTEGER DEFAULT 0"],
    // Set when the organizer finalizes the race: results become official.
    ["motos", "results_finalized_at   TEXT"],
    // Enduro test option the website stores (a dedicated start gate). Nullable:
    // "not set" stays distinguishable from false.
    ["motos", "enduro_has_rfid_start  INTEGER"],
    // Library track + where the course map comes from (pulled from the cloud).
    ["events", "track_id                   INTEGER"],
    ["events", "course_source              TEXT NOT NULL DEFAULT 'track'"],
    ["practice_sessions", "track_id INTEGER"],
    // The track's course when the practice started (JSON, pulled from the
    // cloud): its split readers give sector times.
    ["practice_sessions", "course   TEXT"],
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
    // practice_sessions — track/venue name stored on the session
    ["practice_sessions", "venue_name TEXT"],
    // events — liability waiver requirement (pulled from cloud; checked at check-in)
    ["events", "require_liability_waiver INTEGER NOT NULL DEFAULT 0"],
    // events — fields pulled from the cloud for check-in add-ons, register-info and enduro
    ["events", "rfid_sticker_fee         TEXT"],
    ["events", "require_waiver           INTEGER NOT NULL DEFAULT 0"],
    ["events", "require_transponder      INTEGER NOT NULL DEFAULT 0"],
    ["events", "race_class_details       TEXT NOT NULL DEFAULT '{}'"],
    ["events", "enduro_penalty_config    TEXT"],
    // events — group races (teams whose members' tags all count for the team)
    ["events", "group_race               INTEGER NOT NULL DEFAULT 0"],
    ["events", "riders_per_group         INTEGER"],
    // Event fields the website has: nullable with no default, so "not pulled
    // from the cloud yet" is never pushed back as a value.
    ["events", "race_class_series_map      TEXT"],
    ["events", "class_order                TEXT"],
    ["events", "contingency_brands         TEXT"],
    ["events", "quick_checkin_enabled      INTEGER"],
    ["events", "quick_checkin_requirements TEXT"],
    ["events", "street_address             TEXT"],
    ["events", "zip                        TEXT"],
    ["events", "track_lat                  REAL"],
    ["events", "track_lng                  REAL"],
    ["registrations", "team_name          TEXT"],
    // Cash at the gate: what the rider handed over and the change given (amount_paid is what's kept).
    ["registrations", "cash_tendered      TEXT"],
    ["registrations", "cash_change        TEXT"],
    ["team_members",  "trackr_choice      TEXT"],
    ["team_members",  "rfid_purchased     INTEGER NOT NULL DEFAULT 0"],
    // registrations — check-in add-ons, waiver acknowledgment and rider cancellations
    ["registrations", "rfid_sticker_purchased INTEGER NOT NULL DEFAULT 0"],
    ["registrations", "rm_trackr_purchased    INTEGER NOT NULL DEFAULT 0"],
    // Add-ons paid in cash at desktop check-in: a JSON list of "transponder_rental" | "rfid_sticker" | "rm_trackr".
    ["registrations", "addons_paid            TEXT"],
    ["registrations", "rm_trackr_fulfilled_at TEXT"],
    ["registrations", "rm_trackr_transponder  TEXT"],
    ["registrations", "transponder_returned   INTEGER NOT NULL DEFAULT 0"],
    ["registrations", "waiver_acknowledged_at TEXT"],
    ["registrations", "waiver_snapshot        TEXT"],
    ["registrations", "cancelled_at           TEXT"],
    ["registrations", "cancellation_source    TEXT"],
    ["registrations", "refund_verified_at     TEXT"],
    // motos — pause / resume
    ["motos", "paused_at       TEXT"],
    ["motos", "total_paused_ms INTEGER NOT NULL DEFAULT 0"],
    // rfid_assignments — rental transponders expire 24 h after the event
    ["rfid_assignments", "expires_at TEXT"],
    // tracks — library address fields (PATCH /tracks/:id)
    ["tracks", "address TEXT"],
    ["tracks", "city    TEXT"],
    ["tracks", "zip     TEXT"],
    // event_reader_assignments — course map (split order and names)
    ["event_reader_assignments", "sequence INTEGER"],
    ["event_reader_assignments", "label    TEXT"],
    // Columns the website's API returns, pulled from the cloud so the same
    // screens show the same values offline. Nullable with no default.
    ["clubs", "stripe_direct_charges       INTEGER"],
    ["clubs", "stripe_pending_account_id   TEXT"],
    ["clubs", "stripe_terminal_location_id TEXT"],
    ["clubs", "active                      INTEGER"],
    ["clubs", "timing_ingest_auth          TEXT"],
    ["riders", "club_id                    INTEGER"],
    ["riders", "skill_level                TEXT"],
    ["riders", "race_types                 TEXT"],
    ["riders", "ai_maintenance_suggestions INTEGER"],
    ["riders", "bio                        TEXT"],
    ["riders", "plate_color                TEXT"],
    ["riders", "profile_visibility         TEXT"],
    ["riders", "avatar_url                 TEXT"],
    ["riders", "cover_url                  TEXT"],
    ["motos", "staggered_with_moto_id      INTEGER"],
    // Shared announcer state lives in the cloud; the desktop only stores what it pulled.
    ["motos", "announcer_started_at        TEXT"],
    ["motos", "announcer_last_lap          INTEGER"],
    ["motos", "announcer_time_expired_at   TEXT"],
    ["motos", "announcer_expiry_leader_lap INTEGER"],
    ["motos", "announcer_last_extra_lap    INTEGER"],
    ["motos", "announcer_sequence          INTEGER"],
    ["motos", "announcer_finished_at       TEXT"],
    ["events", "quick_checkin_notified_at  TEXT"],
    ["events", "stats_emails_sent_at       TEXT"],
    ["events", "finalize_reminder_sent_at  TEXT"],
    // Outcome of the last rental return reminder (sent by the cloud).
    ["registrations", "rental_reminder_status TEXT"],
    ["registrations", "rental_reminder_at     TEXT"],
    // Track Library: the track's course map (JSON list of { readerId, role, sequence, label }).
    ["tracks", "course TEXT"],
  ];

  for (const [table, colDef] of migrations) {
    try {
      db.prepare(`ALTER TABLE ${table} ADD COLUMN ${colDef}`).run();
    } catch {
      // Column already exists — ignore
    }
  }

  // ── Race-day tables mirrored from the cloud ──────────────────────────────
  // Pulled by the desktop sync engine and pushed back through the write queue.
  // Locally created rows get ids far above the cloud's serial range.
  db.exec(`
    -- Group race rosters: member 1 is the captain (the registration's rider).
    -- A read of any member's RFID tag or RM TrackR counts for the team.
    CREATE TABLE IF NOT EXISTS team_members (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      event_id        INTEGER NOT NULL,
      registration_id INTEGER NOT NULL,
      position        INTEGER NOT NULL,
      rider_id        INTEGER,
      first_name      TEXT NOT NULL,
      last_name       TEXT NOT NULL,
      email           TEXT,
      rfid_number     TEXT,
      trackr_number   TEXT,
      trackr_choice   TEXT,
      rfid_purchased  INTEGER NOT NULL DEFAULT 0,
      created_at      TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at      TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE (registration_id, position)
    );
    CREATE INDEX IF NOT EXISTS team_members_event_idx ON team_members (event_id);

    -- Signed liability waivers are legal records: never deleted locally.
    CREATE TABLE IF NOT EXISTS liability_waiver_signatures (
      id                  INTEGER PRIMARY KEY AUTOINCREMENT,
      club_id             INTEGER NOT NULL,
      event_id            INTEGER NOT NULL,
      registration_id     INTEGER,
      signer_name         TEXT NOT NULL,
      signer_email        TEXT NOT NULL,
      signer_ip           TEXT,
      signer_user_agent   TEXT,
      consent_to_esign    INTEGER NOT NULL DEFAULT 0,
      waiver_content_hash TEXT NOT NULL,
      waiver_snapshot     TEXT NOT NULL,
      field_layout        TEXT,
      signer_type         TEXT NOT NULL DEFAULT 'self',
      minor_rider_name    TEXT,
      signed_at           TEXT NOT NULL,
      created_at          TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_liability_waiver_signatures_event
      ON liability_waiver_signatures (event_id);

    CREATE TRIGGER IF NOT EXISTS _wq_liability_waiver_signatures_insert
    AFTER INSERT ON liability_waiver_signatures
    WHEN NOT EXISTS (SELECT 1 FROM _cloud_pull_guard)
    BEGIN
      INSERT INTO _write_queue (table_name, record_id, operation) VALUES ('liability_waiver_signatures', NEW.id, 'insert');
    END;
    CREATE TRIGGER IF NOT EXISTS _liability_waiver_signatures_no_delete
    BEFORE DELETE ON liability_waiver_signatures
    BEGIN
      SELECT RAISE(ABORT, 'Signed liability waivers cannot be deleted');
    END;

    -- Club waiver texts/PDFs and default class details (id = club id).
    CREATE TABLE IF NOT EXISTS club_settings (
      id                       INTEGER PRIMARY KEY,
      club_id                  INTEGER,
      rider_acknowledgement    TEXT,
      waiver_pdf_url           TEXT,
      liability_waiver_text    TEXT,
      liability_waiver_pdf_url TEXT,
      liability_waiver_fields  TEXT,
      default_classes          TEXT,
      track_name               TEXT
    );

    CREATE TABLE IF NOT EXISTS enduro_time_checks (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      event_id     INTEGER NOT NULL,
      check_number INTEGER NOT NULL,
      name         TEXT NOT NULL,
      targets      TEXT NOT NULL DEFAULT '[]',
      created_at   TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_enduro_time_checks_event
      ON enduro_time_checks (event_id);

    CREATE TABLE IF NOT EXISTS enduro_checkpoint_arrivals (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      event_id      INTEGER NOT NULL,
      time_check_id INTEGER NOT NULL,
      rider_id      INTEGER NOT NULL,
      arrival_time  TEXT NOT NULL,
      recorded_by   TEXT NOT NULL DEFAULT 'rfid',
      created_at    TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE (time_check_id, rider_id)
    );

    CREATE TABLE IF NOT EXISTS event_reader_assignments (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      event_id      INTEGER NOT NULL,
      reader_id     INTEGER NOT NULL,
      antenna_id    INTEGER,
      role          TEXT NOT NULL,
      moto_id       INTEGER,
      time_check_id INTEGER,
      sequence      INTEGER,
      label         TEXT,
      created_at    TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- Arrivals sync row by row. Time checks and reader assignments are saved as
    -- a whole per event (each PUT replaces them), so they sync as one per-event
    -- snapshot queued under 'event_enduro_setup' with record_id = event id.
    CREATE TRIGGER IF NOT EXISTS _wq_enduro_checkpoint_arrivals_insert
    AFTER INSERT ON enduro_checkpoint_arrivals
    WHEN NOT EXISTS (SELECT 1 FROM _cloud_pull_guard)
    BEGIN
      INSERT INTO _write_queue (table_name, record_id, operation) VALUES ('enduro_checkpoint_arrivals', NEW.id, 'upsert');
    END;
    CREATE TRIGGER IF NOT EXISTS _wq_enduro_checkpoint_arrivals_update
    AFTER UPDATE ON enduro_checkpoint_arrivals
    WHEN NOT EXISTS (SELECT 1 FROM _cloud_pull_guard)
    BEGIN
      INSERT INTO _write_queue (table_name, record_id, operation) VALUES ('enduro_checkpoint_arrivals', NEW.id, 'upsert');
    END;
    CREATE TRIGGER IF NOT EXISTS _wq_enduro_checkpoint_arrivals_delete
    AFTER DELETE ON enduro_checkpoint_arrivals
    WHEN NOT EXISTS (SELECT 1 FROM _cloud_pull_guard)
    BEGIN
      INSERT INTO _write_queue (table_name, record_id, operation) VALUES ('enduro_checkpoint_arrivals', OLD.id, 'delete');
    END;

    -- A rider passing a split reader on the course map (sector times only:
    -- never a lap or a placing). Same key as the cloud: once per moto, tag,
    -- split and lap. Reads recorded here are pushed once; a later renumbering
    -- (a finish pass deleted here) stays local, like the deleted pass itself.
    CREATE TABLE IF NOT EXISTS split_crossings (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      event_id       INTEGER NOT NULL,
      moto_id        INTEGER NOT NULL,
      assignment_id  INTEGER,
      reader_id      INTEGER,
      split_sequence INTEGER NOT NULL,
      label          TEXT,
      rider_id       INTEGER,
      rfid_number    TEXT NOT NULL,
      lap_number     INTEGER NOT NULL,
      crossing_time  TEXT NOT NULL,
      created_at     TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE (moto_id, rfid_number, split_sequence, lap_number)
    );
    CREATE INDEX IF NOT EXISTS split_crossings_moto_rider_idx ON split_crossings (moto_id, rider_id);
    CREATE TRIGGER IF NOT EXISTS _wq_split_crossings_insert
    AFTER INSERT ON split_crossings
    WHEN NOT EXISTS (SELECT 1 FROM _cloud_pull_guard)
    BEGIN
      INSERT INTO _write_queue (table_name, record_id, operation) VALUES ('split_crossings', NEW.id, 'insert');
    END;

    -- The same for a practice at a track whose course has split readers
    -- (practice_sessions.course, the copy the cloud took when it started).
    CREATE TABLE IF NOT EXISTS practice_split_crossings (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id     INTEGER NOT NULL,
      reader_id      INTEGER,
      split_sequence INTEGER NOT NULL,
      label          TEXT,
      rider_id       INTEGER,
      rfid_number    TEXT NOT NULL,
      lap_number     INTEGER NOT NULL,
      crossing_time  TEXT NOT NULL,
      created_at     TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE (session_id, rfid_number, split_sequence, lap_number)
    );
    CREATE TRIGGER IF NOT EXISTS _wq_practice_split_crossings_insert
    AFTER INSERT ON practice_split_crossings
    WHEN NOT EXISTS (SELECT 1 FROM _cloud_pull_guard)
    BEGIN
      INSERT INTO _write_queue (table_name, record_id, operation) VALUES ('practice_split_crossings', NEW.id, 'insert');
    END;
  `);
  for (const table of [
    "liability_waiver_signatures",
    "enduro_time_checks",
    "enduro_checkpoint_arrivals",
    "event_reader_assignments",
    "split_crossings",
    "practice_split_crossings",
  ]) {
    raiseAutoincrementFloor(db, table, 9999999);
  }

  db.exec(`
    -- The club's Sell Items (Admin > Sell Items), pulled from the cloud so
    -- check-in charges the club's prices offline. Read-only here.
    CREATE TABLE IF NOT EXISTS club_sell_items (
      id         INTEGER PRIMARY KEY,
      club_id    INTEGER NOT NULL,
      kind       TEXT NOT NULL,
      name       TEXT NOT NULL,
      price      TEXT,
      hidden     INTEGER NOT NULL DEFAULT 0,
      sort_order INTEGER NOT NULL DEFAULT 0,
      created_at TEXT
    );

    -- The club's readers as registered on the website (Reader Setup), pulled
    -- from the cloud. Gate, time-check and split assignments point at these ids.
    CREATE TABLE IF NOT EXISTS readers (
      id                   INTEGER PRIMARY KEY,
      club_id              INTEGER NOT NULL,
      name                 TEXT NOT NULL,
      type                 TEXT NOT NULL DEFAULT 'rfid',
      hardware_address     TEXT,
      connection           TEXT,
      active_timing_config TEXT,
      created_at           TEXT
    );

    -- Check-in add-ons that were paid (rentals, RM TrackR and RFID tag sales).
    -- Cash taken here gets a uid and is pushed to the cloud once; rows pulled
    -- from the cloud carry its id in cloud_id.
    CREATE TABLE IF NOT EXISTS addon_payments (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      uid             TEXT NOT NULL UNIQUE,
      cloud_id        INTEGER UNIQUE,
      event_id        INTEGER NOT NULL,
      registration_id INTEGER NOT NULL,
      item            TEXT NOT NULL,
      amount          REAL NOT NULL,
      quantity        INTEGER NOT NULL DEFAULT 1,
      method          TEXT NOT NULL,
      status          TEXT NOT NULL,
      cash_tendered   REAL,
      cash_change     REAL,
      created_at      TEXT NOT NULL DEFAULT (datetime('now')),
      paid_at         TEXT
    );
    CREATE INDEX IF NOT EXISTS addon_payments_event_idx ON addon_payments (event_id);

    CREATE TRIGGER IF NOT EXISTS _wq_addon_payments_insert
    AFTER INSERT ON addon_payments
    WHEN NOT EXISTS (SELECT 1 FROM _cloud_pull_guard)
    BEGIN
      INSERT INTO _write_queue (table_name, record_id, operation) VALUES ('addon_payments', NEW.id, 'insert');
    END;

    -- Group race rosters and tags entered at desktop check-in go to the cloud.
    CREATE TRIGGER IF NOT EXISTS _wq_team_members_insert
    AFTER INSERT ON team_members
    WHEN NOT EXISTS (SELECT 1 FROM _cloud_pull_guard)
    BEGIN
      INSERT INTO _write_queue (table_name, record_id, operation) VALUES ('team_members', NEW.id, 'upsert');
    END;
    CREATE TRIGGER IF NOT EXISTS _wq_team_members_update
    AFTER UPDATE ON team_members
    WHEN NOT EXISTS (SELECT 1 FROM _cloud_pull_guard)
    BEGIN
      INSERT INTO _write_queue (table_name, record_id, operation) VALUES ('team_members', NEW.id, 'upsert');
    END;
  `);

  // A column of a table created just above that the website's API returns.
  try { db.prepare("ALTER TABLE club_settings ADD COLUMN brand_contingencies TEXT").run(); } catch { /* already there */ }

  // Track Library rows made or changed on the desktop go to the cloud.
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS _wq_tracks_insert
    AFTER INSERT ON tracks
    WHEN NOT EXISTS (SELECT 1 FROM _cloud_pull_guard)
    BEGIN
      INSERT INTO _write_queue (table_name, record_id, operation) VALUES ('tracks', NEW.id, 'upsert');
    END;
    CREATE TRIGGER IF NOT EXISTS _wq_tracks_update
    AFTER UPDATE ON tracks
    WHEN NOT EXISTS (SELECT 1 FROM _cloud_pull_guard)
    BEGIN
      INSERT INTO _write_queue (table_name, record_id, operation) VALUES ('tracks', NEW.id, 'upsert');
    END;
    -- Club settings saved on the desktop (waiver texts, default classes, brands).
    CREATE TRIGGER IF NOT EXISTS _wq_club_settings_insert
    AFTER INSERT ON club_settings
    WHEN NOT EXISTS (SELECT 1 FROM _cloud_pull_guard)
    BEGIN
      INSERT INTO _write_queue (table_name, record_id, operation) VALUES ('club_settings', NEW.id, 'upsert');
    END;
    CREATE TRIGGER IF NOT EXISTS _wq_club_settings_update
    AFTER UPDATE ON club_settings
    WHEN NOT EXISTS (SELECT 1 FROM _cloud_pull_guard)
    BEGIN
      INSERT INTO _write_queue (table_name, record_id, operation) VALUES ('club_settings', NEW.id, 'upsert');
    END;
    CREATE TRIGGER IF NOT EXISTS _wq_tracks_delete
    AFTER DELETE ON tracks
    WHEN NOT EXISTS (SELECT 1 FROM _cloud_pull_guard)
    BEGIN
      INSERT INTO _write_queue (table_name, record_id, operation) VALUES ('tracks', OLD.id, 'delete');
    END;
  `);

  // Track names were historically stored locally but omitted from desktop sync.
  // Requeue each locally named practice session once so the cloud copy — and
  // therefore Rider App history — receives its venue_name.
  db.exec(`
    CREATE TABLE IF NOT EXISTS _local_data_migrations (
      name       TEXT PRIMARY KEY,
      applied_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    INSERT INTO _write_queue (table_name, record_id, operation)
    SELECT 'practice_sessions', ps.id, 'upsert'
    FROM practice_sessions ps
    WHERE TRIM(COALESCE(ps.venue_name, '')) <> ''
      AND NOT EXISTS (
        SELECT 1
        FROM _write_queue q
        WHERE q.table_name = 'practice_sessions'
          AND q.record_id = ps.id
          AND q.synced_at IS NULL
      )
      AND NOT EXISTS (
        SELECT 1
        FROM _local_data_migrations m
        WHERE m.name = 'requeue-practice-session-track-names'
      );

    INSERT OR IGNORE INTO _local_data_migrations (name)
    VALUES ('requeue-practice-session-track-names');
  `);

  // Tracks added on this desktop before the Track Library synced were numbered
  // from 1, like the cloud's. Move them (once) into the desktop's id range so a
  // pulled cloud track can never land on one, and queue them for the cloud so
  // the first pull doesn't treat them as "removed on the website". Their
  // events and practices follow; that re-pointing isn't a change to push.
  {
    const done = db.prepare("SELECT 1 FROM _local_data_migrations WHERE name = 'renumber-local-tracks'").get();
    if (!done) {
      db.transaction(() => {
        db.prepare("INSERT OR IGNORE INTO _cloud_pull_guard VALUES(1)").run();
        try {
          db.prepare("UPDATE events SET track_id = track_id + 10000000 WHERE track_id IN (SELECT id FROM tracks WHERE id < 10000000)").run();
          db.prepare("UPDATE practice_sessions SET track_id = track_id + 10000000 WHERE track_id IN (SELECT id FROM tracks WHERE id < 10000000)").run();
          db.prepare("UPDATE tracks SET id = id + 10000000 WHERE id < 10000000").run();
        } finally {
          db.prepare("DELETE FROM _cloud_pull_guard").run();
        }
        db.prepare("INSERT INTO _write_queue (table_name, record_id, operation) SELECT 'tracks', id, 'upsert' FROM tracks").run();
        db.prepare("INSERT OR IGNORE INTO _local_data_migrations (name) VALUES ('renumber-local-tracks')").run();
      })();
    }
  }

  // ── Club setup that syncs both ways ──────────────────────────────────────
  // Rental transponder inventory (Admin → Rentals), mirrored from the cloud.
  db.exec(`
    CREATE TABLE IF NOT EXISTS rental_transponders (
      id                 INTEGER PRIMARY KEY,
      club_id            INTEGER NOT NULL,
      transponder_number TEXT NOT NULL,
      label              TEXT,
      missing            INTEGER NOT NULL DEFAULT 0,
      retired            INTEGER NOT NULL DEFAULT 0,
      notes              TEXT,
      created_at         TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE (club_id, transponder_number)
    );
  `);
  // Series, scoring tables, discount categories and codes, sell items and rental
  // units made, changed or removed on the desktop go to the cloud (rows pulled
  // from it are written under _cloud_pull_guard and are not queued back).
  for (const table of ORG_TABLES) {
    db.exec(`
      CREATE TRIGGER IF NOT EXISTS _wq_${table}_insert
      AFTER INSERT ON ${table}
      WHEN NOT EXISTS (SELECT 1 FROM _cloud_pull_guard)
      BEGIN
        INSERT INTO _write_queue (table_name, record_id, operation) VALUES ('${table}', NEW.id, 'upsert');
      END;
      CREATE TRIGGER IF NOT EXISTS _wq_${table}_update
      AFTER UPDATE ON ${table}
      WHEN NOT EXISTS (SELECT 1 FROM _cloud_pull_guard)
      BEGIN
        INSERT INTO _write_queue (table_name, record_id, operation) VALUES ('${table}', NEW.id, 'upsert');
      END;
      CREATE TRIGGER IF NOT EXISTS _wq_${table}_delete
      AFTER DELETE ON ${table}
      WHEN NOT EXISTS (SELECT 1 FROM _cloud_pull_guard)
      BEGIN
        INSERT INTO _write_queue (table_name, record_id, operation) VALUES ('${table}', OLD.id, 'delete');
      END;
    `);
  }
  // Club profile (Dashboard → Club Profile): only the fields an organizer edits.
  // Payment state and retry counters on the same row are not profile edits.
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS _wq_clubs_profile_update
    AFTER UPDATE OF name, state, contact_email, contact_phone, logo_url, website, description,
                    auto_dnf_enabled, auto_dnf_threshold ON clubs
    WHEN NOT EXISTS (SELECT 1 FROM _cloud_pull_guard)
    BEGIN
      INSERT INTO _write_queue (table_name, record_id, operation) VALUES ('clubs', NEW.id, 'upsert');
    END;
  `);
  queueLegacyClubSetup(db);
  // Every transponder a rider owns (several RM TrackRs / stickers), after the riders columns exist.
  ensureRiderTranspondersSchema(db);

  // Seed autoincrement sequences so desktop-created rows start at a high ID range
  // and never collide with cloud-assigned sequential IDs (1, 2, 3...).
  // An already-elevated sequence is never lowered. (practice_sessions has no
  // AUTOINCREMENT, so its row is inert; kept for older databases.)
  raiseAutoincrementFloor(db, "events", 9999999);
  raiseAutoincrementFloor(db, "practice_sessions", 9999999);
  raiseAutoincrementFloor(db, "tracks", 9999999);
}

/**
 * Makes the next AUTOINCREMENT id of `table` at least floor + 1. sqlite_sequence
 * has no unique constraint on name, so this updates the row or inserts one
 * (an earlier INSERT … ON CONFLICT(name) version always failed silently).
 */
function raiseAutoincrementFloor(db: ReturnType<typeof getDb>, table: string, floor: number): void {
  try {
    const updated = db
      .prepare("UPDATE sqlite_sequence SET seq = MAX(seq, ?) WHERE name = ?")
      .run(floor, table);
    if (updated.changes === 0) {
      db.prepare("INSERT INTO sqlite_sequence (name, seq) VALUES (?, ?)").run(table, floor);
    }
  } catch {
    // sqlite_sequence exists once any AUTOINCREMENT table has been created.
  }
}

/**
 * Before club setup synced, a series, scoring table, discount category or code
 * made on this desktop stayed here, numbered right after the rows pulled from
 * the cloud. Once: move each into the desktop's id range (so a pulled row can
 * never land on it), re-point what refers to it, and queue it for the cloud.
 * Such rows are told apart by their timestamp: SQLite's "YYYY-MM-DD HH:MM:SS",
 * where a pulled row carries the cloud's ISO time.
 */
function queueLegacyClubSetup(db: ReturnType<typeof getDb>): void {
  const done = db.prepare("SELECT 1 FROM _local_data_migrations WHERE name = 'queue-local-club-setup'").get();
  if (done) return;
  const madeHere = "created_at NOT LIKE '%T%'";
  const queue = db.prepare("INSERT INTO _write_queue (table_name, record_id, operation) VALUES (?, ?, 'upsert')");
  const jsonIds = (text: unknown): number[] => {
    try { const v = JSON.parse(String(text ?? "[]")); return Array.isArray(v) ? v.map(Number) : []; } catch { return []; }
  };
  db.transaction(() => {
    const requeue = { events: new Set<number>(), series: new Set<number>(), comp_codes: new Set<number>() };
    db.prepare("INSERT OR IGNORE INTO _cloud_pull_guard VALUES(1)").run();
    try {
      for (const table of ["points_tables", "discount_categories", "series", "comp_codes"] as const) {
        const ownOnly = table === "points_tables" ? " AND club_id IS NOT NULL AND is_system_default = 0" : "";
        const rows = db.prepare(`SELECT id FROM ${table} WHERE id < ? AND ${madeHere}${ownOnly}`)
          .all(DESKTOP_ID_FLOOR) as Array<{ id: number }>;
        for (const { id } of rows) {
          const next = newDesktopId(db, table);
          db.prepare(`UPDATE ${table} SET id = ? WHERE id = ?`).run(next, id);
          if (table === "points_tables") {
            for (const e of db.prepare("SELECT id FROM events WHERE scoring_table_id = ?").all(id) as Array<{ id: number }>) requeue.events.add(e.id);
            for (const s of db.prepare("SELECT id FROM series WHERE scoring_table_id = ?").all(id) as Array<{ id: number }>) requeue.series.add(s.id);
            db.prepare("UPDATE events SET scoring_table_id = ? WHERE scoring_table_id = ?").run(next, id);
            db.prepare("UPDATE series SET scoring_table_id = ? WHERE scoring_table_id = ?").run(next, id);
          } else if (table === "discount_categories") {
            for (const e of db.prepare("SELECT id FROM events WHERE entry_fee_category_id = ?").all(id) as Array<{ id: number }>) requeue.events.add(e.id);
            db.prepare("UPDATE events SET entry_fee_category_id = ? WHERE entry_fee_category_id = ?").run(next, id);
            for (const c of db.prepare("SELECT id, category_ids FROM comp_codes").all() as Array<{ id: number; category_ids: string | null }>) {
              const ids = jsonIds(c.category_ids);
              if (!ids.includes(id)) continue;
              db.prepare("UPDATE comp_codes SET category_ids = ? WHERE id = ?").run(JSON.stringify(ids.map(n => (n === id ? next : n))), c.id);
              requeue.comp_codes.add(c.id);
            }
          } else if (table === "series") {
            if (requeue.series.delete(id)) requeue.series.add(next);
            db.prepare("UPDATE series_points SET series_id = ? WHERE series_id = ?").run(next, id);
            const events = db.prepare("SELECT id, race_class_series_map FROM events WHERE race_class_series_map IS NOT NULL")
              .all() as Array<{ id: number; race_class_series_map: string }>;
            for (const e of events) {
              let map: Record<string, unknown>;
              try { map = JSON.parse(e.race_class_series_map); } catch { continue; }
              if (!map || typeof map !== "object") continue;
              let touched = false;
              for (const [cls, ids] of Object.entries(map)) {
                if (!Array.isArray(ids) || !ids.map(Number).includes(id)) continue;
                map[cls] = ids.map(n => (Number(n) === id ? next : n));
                touched = true;
              }
              if (!touched) continue;
              db.prepare("UPDATE events SET race_class_series_map = ? WHERE id = ?").run(JSON.stringify(map), e.id);
              requeue.events.add(e.id);
            }
          } else if (requeue.comp_codes.delete(id)) {
            requeue.comp_codes.add(next);
          }
          queue.run(table, next);
        }
      }
    } finally {
      db.prepare("DELETE FROM _cloud_pull_guard").run();
    }
    // Rows that referred to a renumbered one carry its new id to the cloud.
    const alreadyQueued = db.prepare(
      "SELECT 1 FROM _write_queue WHERE table_name = ? AND record_id = ? AND synced_at IS NULL AND operation != 'delete'",
    );
    for (const [table, ids] of Object.entries(requeue)) {
      for (const id of ids) if (!alreadyQueued.get(table, id)) queue.run(table, id);
    }
    db.prepare("INSERT OR IGNORE INTO _local_data_migrations (name) VALUES ('queue-local-club-setup')").run();
  })();
}
