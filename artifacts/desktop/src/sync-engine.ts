import Database from "better-sqlite3";
import type { SyncState, SyncStatus } from "./ipc-types";

type StateChangeCallback = (state: SyncState) => void;

type WriteQueueRow = {
  id: number;
  table_name: string;
  record_id: number;
  operation: string;
  created_at: string;
  synced_at: string | null;
  error: string | null;
  attempt_count: number;
};

const MAX_ATTEMPTS = 5;
const PROBE_TIMEOUT_MS = 8_000;

export class SyncEngine {
  private db: Database.Database;
  private cloudUrl: string;
  private clubId: string;
  private email: string;
  private password: string;
  private loadCachedCookie: (() => string | null) | null;
  private saveCachedCookie: ((cookie: string) => void) | null;
  private clearCachedCookie: (() => void) | null;

  private status: SyncStatus = "idle";
  private wasOffline = false;
  private lastSyncedAt: string | null = null;
  private lastError: string | null = null;
  private sessionCookie: string | null = null;
  private flushTimer: ReturnType<typeof setInterval> | null = null;
  private listeners: StateChangeCallback[] = [];
  private flushPromise: Promise<void> | null = null;
  private pollIntervalMs: number;

  constructor(opts: {
    dbPath: string;
    cloudUrl: string;
    clubId: string;
    email: string;
    password: string;
    pollIntervalMs?: number;
    /** Optional hooks for persisting the session cookie across restarts */
    loadCachedCookie?: () => string | null;
    saveCachedCookie?: (cookie: string) => void;
    clearCachedCookie?: () => void;
  }) {
    this.cloudUrl = opts.cloudUrl.replace(/\/$/, "");
    this.clubId = opts.clubId;
    this.email = opts.email;
    this.password = opts.password;
    this.loadCachedCookie  = opts.loadCachedCookie  ?? null;
    this.saveCachedCookie  = opts.saveCachedCookie  ?? null;
    this.clearCachedCookie = opts.clearCachedCookie ?? null;
    // Default: check for pending writes every 2 s so lap crossings reach the
    // cloud (and SSE subscribers) within ~2 s of the RFID read.
    this.pollIntervalMs = opts.pollIntervalMs ?? 2_000;

    this.db = new Database(opts.dbPath, { readonly: false });
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("busy_timeout = 5000");
    this.ensureQueueSchema();
  }

  private ensureQueueSchema(): void {
    this.db.exec(`
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

      -- Guard flag: set by the sync-engine during cloud-pull upserts so that
      -- SQLite triggers do not re-enqueue cloud-originated rows into _write_queue.
      CREATE TABLE IF NOT EXISTS _cloud_pull_guard (
        active INTEGER PRIMARY KEY
      );
      -- Ensure guard is clear on startup (guard is always cleared after pull, but
      -- clear defensively in case the process crashed while guard was set).
      DELETE FROM _cloud_pull_guard;

      -- Tracks the last time each table was successfully pulled from cloud.
      CREATE TABLE IF NOT EXISTS _sync_watermarks (
        table_name    TEXT PRIMARY KEY,
        last_pulled_at TEXT NOT NULL DEFAULT '1970-01-01T00:00:00.000Z',
        updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
      );
    `);
  }

  start(): void {
    // Reset rows that hit the attempt cap on a previous run so they are
    // retried on this startup cycle instead of being permanently stranded.
    // (The reconnect-cycle reset only fires when the app goes offline then
    //  back online; it never fires for errors that happen while always-online.)
    this.db
      .prepare(
        "UPDATE _write_queue SET attempt_count = 0, error = NULL WHERE synced_at IS NULL AND attempt_count >= ?",
      )
      .run(MAX_ATTEMPTS);

    void this.flush();
    this.flushTimer = setInterval(() => void this.flush(), this.pollIntervalMs);
  }

  stop(): void {
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }
  }

  setInterval(ms: number): void {
    this.pollIntervalMs = ms;
    this.stop();
    this.start();
  }

  getPendingCount(): number {
    const row = this.db
      .prepare(
        "SELECT COUNT(*) as cnt FROM _write_queue WHERE synced_at IS NULL AND attempt_count < ?",
      )
      .get(MAX_ATTEMPTS) as { cnt: number };
    return row.cnt;
  }

  getState(): SyncState {
    return {
      status: this.status,
      pendingCount: this.getPendingCount(),
      lastSyncedAt: this.lastSyncedAt,
      lastError: this.lastError,
      cloudUrl: this.cloudUrl,
      clubId: this.clubId,
    };
  }

  onChange(cb: StateChangeCallback): () => void {
    this.listeners.push(cb);
    return () => {
      this.listeners = this.listeners.filter((l) => l !== cb);
    };
  }

  private emit(): void {
    const state = this.getState();
    for (const cb of this.listeners) cb(state);
  }

  private setStatus(s: SyncStatus, error?: string): void {
    this.status = s;
    if (error !== undefined) this.lastError = error;
    this.emit();
  }

  /**
   * Trigger a sync cycle. If a cycle is already in flight, returns the same
   * promise so every caller waits for the same real completion — this is the
   * fix for the race condition where setCredentials starts a flush and the
   * modal's subsequent flush() call previously returned immediately.
   */
  flush(): Promise<void> {
    if (this.flushPromise) return this.flushPromise;
    this.flushPromise = this._flush().finally(() => {
      this.flushPromise = null;
    });
    return this.flushPromise;
  }

  private async _flush(): Promise<void> {
    const reachable = await this.probe();
    if (!reachable) {
      this.wasOffline = true;
      this.setStatus("offline");
      return;
    }

    // On reconnect, reset stranded rows so the queue drains automatically.
    // Rows are only throttled by MAX_ATTEMPTS between reconnect cycles; they
    // are never permanently dead-lettered.
    if (this.wasOffline) {
      this.wasOffline = false;
      this.db
        .prepare(
          "UPDATE _write_queue SET attempt_count = 0, error = NULL WHERE synced_at IS NULL AND attempt_count >= ?",
        )
        .run(MAX_ATTEMPTS);
    }

    // Always set "syncing" — even when there are no pending local writes we
    // still call pullCloud(), so the cycle is never a no-op.  This guarantees
    // the syncing→idle transition that DesktopSyncWatcher uses to call
    // queryClient.invalidateQueries() and refresh the UI after cloud pulls.
    this.setStatus("syncing");

    let pushErrorMsg: string | undefined;

    try {
      await this.ensureSession();
      // Check pending count AFTER ensureSession() so we don't miss writes
      // that arrived while waiting for the network round-trip to verify the
      // session cookie.  A stale count of 0 would skip pushQueue() and the
      // subsequent pullCloud() would overwrite the unsaved local change.
      const pending = this.getPendingCount();
      if (pending > 0) {
        try {
          await this.pushQueue();
        } catch (pushErr) {
          // Push failed — capture the error but do NOT re-throw.
          // pullCloud() is always safe to run even with pending local writes
          // because upsertPulled() skips rows whose ids are in _write_queue
          // (pendingIds guard), so local changes are never overwritten.
          // Blocking the pull on push failures means cloud-created events
          // (or any web-portal changes) can never appear on the desktop
          // while a push is stuck — that is the bug this fixes.
          pushErrorMsg = pushErr instanceof Error ? pushErr.message : String(pushErr);
        }
      }
      await this.pullCloud();
      this.lastSyncedAt = new Date().toISOString();
      if (pushErrorMsg) {
        // Pull succeeded but push has outstanding failures — stay in error so
        // the sync bar keeps showing the push problem until it clears.
        this.setStatus("error", pushErrorMsg);
      } else {
        this.setStatus("idle", "");
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.setStatus("error", msg);
    }
  }

  private async probe(): Promise<boolean> {
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), PROBE_TIMEOUT_MS);
      const res = await fetch(`${this.cloudUrl}/api/healthz`, {
        signal: ctrl.signal,
      });
      clearTimeout(timer);
      return res.ok;
    } catch {
      return false;
    }
  }

  private async ensureSession(): Promise<void> {
    // 1) Try in-memory session cookie (valid for current process lifetime)
    if (this.sessionCookie) {
      const ok = await this.verifySession();
      if (ok) return;
      this.sessionCookie = null;
    }

    // 2) Try the persisted session cookie from disk (survives app restarts)
    if (!this.sessionCookie && this.loadCachedCookie) {
      const cached = this.loadCachedCookie();
      if (cached) {
        this.sessionCookie = cached;
        const ok = await this.verifySession();
        if (ok) return;
        // Stale — discard and fall through to password login
        this.sessionCookie = null;
        this.clearCachedCookie?.();
      }
    }

    // 3) Full login with email + password
    const res = await fetch(`${this.cloudUrl}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: this.email, password: this.password }),
    });

    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Login failed (${res.status}): ${body}`);
    }

    const rawCookie = res.headers.get("set-cookie") ?? "";
    const cookie = rawCookie
      .split(",")
      .map((c) => c.trim().split(";")[0].trim())
      .filter(Boolean)
      .join("; ");

    if (!cookie) throw new Error("Login succeeded but no session cookie");
    this.sessionCookie = cookie;
    // Persist the new cookie so the next app restart skips the password flow
    this.saveCachedCookie?.(cookie);
  }

  private async verifySession(): Promise<boolean> {
    try {
      const res = await fetch(`${this.cloudUrl}/api/auth/me`, {
        headers: { Cookie: this.sessionCookie! },
      });
      return res.ok;
    } catch {
      return false;
    }
  }

  /**
   * Makes an authenticated request to the cloud API.
   * Handles session refresh automatically — callers never need to manage cookies.
   */
  async cloudFetch(
    path: string,
    options: { method?: string; body?: unknown } = {},
  ): Promise<{ ok: boolean; status: number; data: unknown }> {
    await this.ensureSession();
    const res = await fetch(`${this.cloudUrl}${path}`, {
      method: options.method ?? "GET",
      headers: {
        "Content-Type": "application/json",
        Cookie: this.sessionCookie!,
      },
      ...(options.body !== undefined
        ? { body: JSON.stringify(options.body) }
        : {}),
    });
    const text = await res.text();
    let data: unknown;
    try {
      data = JSON.parse(text);
    } catch {
      data = text;
    }
    return { ok: res.ok, status: res.status, data };
  }

  private async pushQueue(): Promise<void> {
    const rows = this.db
      .prepare(
        `SELECT * FROM _write_queue
         WHERE synced_at IS NULL AND attempt_count < ?
         ORDER BY id ASC
         LIMIT 100`,
      )
      .all(MAX_ATTEMPTS) as WriteQueueRow[];

    if (rows.length === 0) return;

    // Separate deletes from upserts — deleted rows are gone from SQLite,
    // so we can't SELECT them; we just forward their IDs to the cloud.
    const deletesByTable: Record<string, number[]> = {};
    const grouped: Record<string, number[]> = {};
    for (const row of rows) {
      if (row.operation === "delete") {
        if (!deletesByTable[row.table_name]) deletesByTable[row.table_name] = [];
        deletesByTable[row.table_name].push(row.record_id);
      } else {
        if (!grouped[row.table_name]) grouped[row.table_name] = [];
        grouped[row.table_name].push(row.record_id);
      }
    }

    const payload: Record<string, unknown> = {};

    for (const [table, ids] of Object.entries(grouped)) {
      const placeholders = ids.map(() => "?").join(",");
      const tableRows = this.db
        .prepare(`SELECT * FROM ${table} WHERE id IN (${placeholders})`)
        .all(...ids) as Record<string, unknown>[];
      payload[table] = tableRows;
    }

    if (Object.keys(deletesByTable).length > 0) {
      payload["_deletes"] = deletesByTable;
    }

    // Helper to mark all queued rows as failed (increments attempt_count).
    // Called for both HTTP-level errors and network-level fetch() throws so
    // that rows are eventually dead-lettered and no longer block the pull.
    const markFailed = (errMsg: string) => {
      this.db
        .prepare(
          "UPDATE _write_queue SET attempt_count = attempt_count + 1, error = ? WHERE id IN (" +
            rows.map(() => "?").join(",") +
            ")",
        )
        .run(errMsg, ...rows.map((r) => r.id));
    };

    let res: Response;
    try {
      res = await fetch(
        `${this.cloudUrl}/api/clubs/${this.clubId}/desktop-push`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Cookie: this.sessionCookie!,
          },
          body: JSON.stringify(payload),
        },
      );
    } catch (fetchErr) {
      // Network-level error (ECONNREFUSED, timeout, etc.) — increment attempt
      // counts so rows are eventually dead-lettered after MAX_ATTEMPTS and
      // no longer block pullCloud().
      const errMsg = `Push network error: ${fetchErr instanceof Error ? fetchErr.message : String(fetchErr)}`;
      markFailed(errMsg);
      throw new Error(errMsg);
    }

    const now = new Date().toISOString();
    const body = await res.text();

    if (!res.ok) {
      const errMsg = `Push failed (${res.status}): ${body}`;
      markFailed(errMsg);
      throw new Error(errMsg);
    }

    this.db
      .prepare(
        "UPDATE _write_queue SET synced_at = ?, error = NULL WHERE id IN (" +
          rows.map(() => "?").join(",") +
          ")",
      )
      .run(now, ...rows.map((r) => r.id));

    // Apply any id remaps returned by the cloud (e.g. event id collisions).
    type PushResponse = { idRemaps?: { events?: Array<{ localId: number; cloudId: number }> } };
    let pushResponse: PushResponse | null = null;
    try { pushResponse = JSON.parse(body) as PushResponse; } catch { /* ignore */ }
    const eventRemaps = pushResponse?.idRemaps?.events ?? [];
    if (eventRemaps.length > 0) {
      this.applyEventIdRemaps(eventRemaps);
    }
  }

  // Child tables that carry an event_id FK and must be updated when
  // a desktop event id is remapped to a cloud-assigned id.
  private static readonly EVENT_CHILD_TABLES: ReadonlyArray<[string, string]> = [
    ["motos",             "event_id"],
    ["registrations",     "event_id"],
    ["checkins",          "event_id"],
    ["rfid_assignments",  "event_id"],
    ["race_results",      "event_id"],
    ["lap_crossings",     "event_id"],
    ["practice_sessions", "event_id"],
  ];

  /**
   * When a desktop-created event collides with an existing cloud event from a
   * different club, the cloud assigns a new Postgres id and returns the mapping.
   * This method patches the local SQLite event id and all child FK columns to
   * match the cloud-assigned id, then restamps the write-queue row.
   *
   * Runs inside a _cloud_pull_guard transaction so the UPDATE on the events
   * table does not re-enqueue the row into _write_queue.
   */
  private applyEventIdRemaps(
    remaps: Array<{ localId: number; cloudId: number }>,
  ): void {
    if (!remaps.length) return;

    const doRemap = this.db.transaction(() => {
      this.db.prepare("INSERT OR IGNORE INTO _cloud_pull_guard VALUES(1)").run();
      try {
        for (const { localId, cloudId } of remaps) {
          // Patch the event's primary key.
          this.db
            .prepare("UPDATE events SET id = ? WHERE id = ?")
            .run(cloudId, localId);

          // Patch FK columns in all child tables.
          for (const [childTable, fkCol] of SyncEngine.EVENT_CHILD_TABLES) {
            this.db
              .prepare(`UPDATE ${childTable} SET ${fkCol} = ? WHERE ${fkCol} = ?`)
              .run(cloudId, localId);
          }

          // Keep the write-queue entry pointing at the new id.
          this.db
            .prepare(
              "UPDATE _write_queue SET record_id = ? WHERE table_name = 'events' AND record_id = ?",
            )
            .run(cloudId, localId);
        }
      } finally {
        this.db.prepare("DELETE FROM _cloud_pull_guard").run();
      }
    });

    doRemap();
  }

  /**
   * After a pull, verify that every local event owned by this club also appears
   * in the cloud response.  If an event is missing (e.g. it was silently dropped
   * by a previous push due to an id collision that predates this fix), reset or
   * insert its write-queue entry so the next push cycle retries it.
   */
  private recoverMissingClubEvents(cloudEventIds: Set<number>): void {
    const clubId = Number(this.clubId);
    if (!clubId) return;

    const localClubEvents = this.db
      .prepare("SELECT id FROM events WHERE club_id = ?")
      .all(clubId) as Array<{ id: number }>;

    for (const { id: localId } of localClubEvents) {
      if (cloudEventIds.has(localId)) continue;

      // Event exists locally but is missing from cloud — ensure it gets pushed.
      const existing = this.db
        .prepare(
          "SELECT id, synced_at FROM _write_queue WHERE table_name = 'events' AND record_id = ? ORDER BY id DESC LIMIT 1",
        )
        .get(localId) as { id: number; synced_at: string | null } | undefined;

      if (existing && existing.synced_at !== null) {
        // Was falsely marked synced (silent push failure) — reset for retry.
        this.db
          .prepare(
            "UPDATE _write_queue SET synced_at = NULL, attempt_count = 0, error = NULL WHERE id = ?",
          )
          .run(existing.id);
      } else if (!existing) {
        // No write-queue entry at all — create one.
        this.db
          .prepare(
            "INSERT INTO _write_queue (table_name, record_id, operation) VALUES ('events', ?, 'upsert')",
          )
          .run(localId);
      }
      // If existing and synced_at IS NULL — already queued for retry, no action needed.
    }
  }

  private async pullCloud(): Promise<void> {
    // Send last_pulled_at per table so the server can log/filter in the future,
    // but the server currently returns ALL club rows so that edits to existing
    // rows (not just new inserts) are always applied to the local DB.
    const watermarkRows = this.db
      .prepare("SELECT table_name, last_pulled_at FROM _sync_watermarks")
      .all() as Array<{ table_name: string; last_pulled_at: string }>;

    const lastPulledAt: Record<string, string> = {};
    for (const w of watermarkRows) lastPulledAt[w.table_name] = w.last_pulled_at;

    const res = await fetch(
      `${this.cloudUrl}/api/clubs/${this.clubId}/sync-pull`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Cookie: this.sessionCookie!,
        },
        body: JSON.stringify({ lastPulledAt }),
      },
    );

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`sync-pull failed (${res.status}): ${body}`);
    }

    const data = (await res.json()) as {
      registrations?: Record<string, unknown>[];
      checkins?: Record<string, unknown>[];
      riders?: Record<string, unknown>[];
      rfidAssignments?: Record<string, unknown>[];
      events?: Record<string, unknown>[];
      motos?: Record<string, unknown>[];
      lapCrossings?: Record<string, unknown>[];
      raceResults?: Record<string, unknown>[];
      users?: Record<string, unknown>[];
      clubs?: Record<string, unknown>[];
      series?: Record<string, unknown>[];
      seriesPoints?: Record<string, unknown>[];
      pointsTables?: Record<string, unknown>[];
      discountCategories?: Record<string, unknown>[];
      compCodes?: Record<string, unknown>[];
      practiceSessions?: Record<string, unknown>[];
      practiceCrossings?: Record<string, unknown>[];
    };

    const now = new Date().toISOString();

    // Upsert all tables inside one transaction and advance watermarks atomically.
    // The _cloud_pull_guard flag prevents SQLite triggers from re-enqueueing
    // cloud-originated rows back into _write_queue (echo suppression).
    const upsertAll = this.db.transaction(() => {
      // Set guard: triggers will skip enqueue while this row exists.
      this.db.prepare("INSERT OR IGNORE INTO _cloud_pull_guard VALUES(1)").run();

      try {
        const tableMap: Array<[string, Record<string, unknown>[]]> = [
          ["clubs",               data.clubs               ?? []],
          ["points_tables",       data.pointsTables        ?? []],
          ["series",              data.series              ?? []],
          ["series_points",       data.seriesPoints        ?? []],
          ["discount_categories", data.discountCategories  ?? []],
          ["comp_codes",          data.compCodes           ?? []],
          ["practice_sessions",   data.practiceSessions    ?? []],
          ["practice_crossings",  data.practiceCrossings   ?? []],
          ["registrations",       data.registrations       ?? []],
          ["checkins",            data.checkins            ?? []],
          ["riders",              data.riders              ?? []],
          ["rfid_assignments",    data.rfidAssignments     ?? []],
          ["events",              data.events              ?? []],
          ["motos",               data.motos               ?? []],
          ["lap_crossings",       data.lapCrossings        ?? []],
          ["race_results",        data.raceResults         ?? []],
          ["users",               data.users               ?? []],
        ];

        for (const [table, rows] of tableMap) {
          this.upsertPulled(table, rows);
          this.db
            .prepare(
              `INSERT INTO _sync_watermarks (table_name, last_pulled_at, updated_at)
               VALUES (?, ?, datetime('now'))
               ON CONFLICT(table_name) DO UPDATE
                 SET last_pulled_at = excluded.last_pulled_at,
                     updated_at     = excluded.updated_at`,
            )
            .run(table, now);
        }
      } finally {
        // Always clear the guard, even if an upsert threw.
        this.db.prepare("DELETE FROM _cloud_pull_guard").run();
      }
    });

    upsertAll();

    const pulledEventIds = new Set<number>(
      (data.events ?? [])
        .map((ev) => Number(ev["id"]))
        .filter((n) => n > 0),
    );

    // ── Clear stuck write-queue entries for cloud-confirmed events ────────────
    // Write-queue entries accumulate when:
    //   (a) a desktop event was created with a low ID that collides with a cloud
    //       event ID (Postgres serial starts at 1), or
    //   (b) the GET /events auto-status update fired without the _cloud_pull_guard
    //       active (now fixed), stuffing the event ID back into the queue.
    //
    // These stuck entries appear in pendingIds inside upsertPulled and prevent
    // upsertAll() from applying the canonical cloud version.  We break the cycle
    // here: if the cloud just told us it has event ID=X, any failed write-queue
    // entry for that same ID is stale — clear it so the NEXT pull can upsert.
    //
    // Safety: only entries with attempt_count > 0 are cleared.  A fresh,
    // un-attempted entry (attempt_count = 0) represents a locally-created event
    // that has never been pushed; we preserve those so the push queue can still
    // send them to the cloud.
    if (pulledEventIds.size > 0) {
      const idList = Array.from(pulledEventIds).join(",");
      const cleared = this.db
        .prepare(
          `DELETE FROM _write_queue
           WHERE table_name  = 'events'
             AND record_id   IN (${idList})
             AND synced_at   IS NULL
             AND attempt_count > 0`,
        )
        .run();
      if (cleared.changes > 0) {
        console.log(
          `[sync] Cleared ${cleared.changes} stuck write-queue entry(s) for ` +
          `cloud-confirmed event IDs — they will be re-upserted on next pull`,
        );
      }
    }

    // After every pull, verify that every local event owned by this club also
    // exists in the cloud response.  Any that are missing were silently dropped
    // by a previous push (e.g. an id collision); re-queue them for retry.
    this.recoverMissingClubEvents(pulledEventIds);
  }

  /**
   * Returns the set of column names that actually exist in a local SQLite table.
   * Results are cached per table so PRAGMA queries aren't repeated every row.
   */
  private readonly _localCols = new Map<string, Set<string>>();

  private localColumns(table: string): Set<string> {
    if (this._localCols.has(table)) return this._localCols.get(table)!;
    const rows = this.db
      .prepare(`PRAGMA table_info(${table})`)
      .all() as Array<{ name: string }>;
    const cols = new Set(rows.map((r) => r.name));
    this._localCols.set(table, cols);
    return cols;
  }

  /**
   * Upserts cloud rows into the local SQLite table.
   * - Converts camelCase cloud keys to snake_case.
   * - Filters out any cloud-side columns that don't exist locally (avoids
   *   "table has no column" errors when cloud schema is ahead of local schema).
   * - Throws on genuine SQL errors so the caller can mark sync state as error.
   */
  private upsertPulled(
    table: string,
    rows: Record<string, unknown>[],
  ): void {
    if (!rows.length) return;

    // Never overwrite rows that have unsynced local writes.  Without this
    // guard, a write that arrived after getPendingCount() was sampled (but
    // before pullCloud() ran) would be silently reverted by the pull upsert.
    const pendingIds = new Set<number>(
      (
        this.db
          .prepare(
            `SELECT record_id FROM _write_queue
             WHERE table_name = ? AND synced_at IS NULL AND attempt_count < ?`,
          )
          .all(table, MAX_ATTEMPTS) as Array<{ record_id: number }>
      ).map((r) => r.record_id),
    );

    const toSnake = (s: string) =>
      s.replace(/([A-Z])/g, "_$1").toLowerCase();

    // Overrides for camelCase→snake_case conversions that don't match the
    // local SQLite column names (e.g. acronyms stored as a single word).
    const colOverrides: Record<string, string> = {
      my_laps_transponder_number: "mylaps_transponder_number",
    };

    // Normalize a value to a type better-sqlite3 can bind:
    //   array/object → JSON string, boolean → 0/1, Date → ISO string,
    //   null/undefined → null, number/string → pass through.
    const normalize = (v: unknown): string | number | null => {
      if (v === null || v === undefined) return null;
      if (typeof v === "boolean") return v ? 1 : 0;
      if (typeof v === "number") return v;
      if (typeof v === "string") return v;
      if (v instanceof Date) return v.toISOString();
      // Array or object (e.g. Postgres JSON columns, lineup, lapTimes, raceClasses)
      return JSON.stringify(v);
    };

    const knownCols = this.localColumns(table);

    for (const row of rows) {
      // Convert camelCase → snake_case, normalize values, and drop columns the
      // local schema doesn't know.
      const snakeRow: Record<string, string | number | null> = {};
      for (const [k, v] of Object.entries(row)) {
        const col = colOverrides[toSnake(k)] ?? toSnake(k);
        if (knownCols.has(col)) snakeRow[col] = normalize(v);
      }

      const cols = Object.keys(snakeRow);
      if (!cols.includes("id") || cols.length < 2) continue; // can't upsert without id

      // Skip rows with a pending local write — their local version wins until
      // successfully pushed to the cloud.
      if (pendingIds.has(snakeRow.id as number)) {
        if (table === "events") {
          console.warn(
            `[sync] upsertPulled: skipping cloud event id=${snakeRow.id as number} ` +
            `— blocked by pending local write-queue entry`,
          );
        }
        continue;
      }

      const vals = Object.values(snakeRow);
      const placeholders = cols.map(() => "?").join(", ");
      const assignments = cols
        .filter((c) => c !== "id")
        .map((c) => `${c} = excluded.${c}`)
        .join(", ");

      // Let errors propagate — caller wraps in transaction; any failure rolls
      // back the whole pull cycle and sets sync status to "error".
      this.db
        .prepare(
          `INSERT INTO ${table} (${cols.join(", ")})
           VALUES (${placeholders})
           ON CONFLICT(id) DO UPDATE SET ${assignments}`,
        )
        .run(...vals);
    }
  }

  destroy(): void {
    this.stop();
    this.db.close();
  }
}
