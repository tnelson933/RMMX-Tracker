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
  private flushing = false;
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
    // Default: check for pending writes every 5 s so local changes are pushed
    // within seconds rather than waiting a full 30-second interval.
    this.pollIntervalMs = opts.pollIntervalMs ?? 5_000;

    this.db = new Database(opts.dbPath, { readonly: false });
    this.db.pragma("journal_mode = WAL");
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

  async flush(): Promise<void> {
    if (this.flushing) return;
    this.flushing = true;

    const reachable = await this.probe();
    if (!reachable) {
      this.wasOffline = true;
      this.setStatus("offline");
      this.flushing = false;
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

    const pending = this.getPendingCount();
    this.setStatus(pending > 0 ? "syncing" : "idle");

    try {
      await this.ensureSession();
      // Always push pending writes first, then pull cloud changes.
      // pullCloud() runs unconditionally so web-portal changes (e.g. new
      // registrations added online) are synced down on every online cycle,
      // not only when there is a local write pending.
      if (pending > 0) {
        await this.pushQueue();
      }
      await this.pullCloud();
      this.lastSyncedAt = new Date().toISOString();
      this.setStatus("idle", "");
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.setStatus("error", msg);
    } finally {
      this.flushing = false;
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

    const grouped: Record<string, number[]> = {};
    for (const row of rows) {
      if (!grouped[row.table_name]) grouped[row.table_name] = [];
      grouped[row.table_name].push(row.record_id);
    }

    const payload: Record<string, unknown[]> = {};

    for (const [table, ids] of Object.entries(grouped)) {
      const placeholders = ids.map(() => "?").join(",");
      const tableRows = this.db
        .prepare(`SELECT * FROM ${table} WHERE id IN (${placeholders})`)
        .all(...ids) as Record<string, unknown>[];
      payload[table] = tableRows;
    }

    const res = await fetch(
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

    const now = new Date().toISOString();

    if (!res.ok) {
      const body = await res.text();
      const errMsg = `Push failed (${res.status}): ${body}`;
      this.db
        .prepare(
          "UPDATE _write_queue SET attempt_count = attempt_count + 1, error = ? WHERE id IN (" +
            rows.map(() => "?").join(",") +
            ")",
        )
        .run(errMsg, ...rows.map((r) => r.id));
      throw new Error(errMsg);
    }

    this.db
      .prepare(
        "UPDATE _write_queue SET synced_at = ?, error = NULL WHERE id IN (" +
          rows.map(() => "?").join(",") +
          ")",
      )
      .run(now, ...rows.map((r) => r.id));
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

    if (!res.ok) return;

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
          ["registrations",    data.registrations   ?? []],
          ["checkins",         data.checkins         ?? []],
          ["riders",           data.riders           ?? []],
          ["rfid_assignments", data.rfidAssignments  ?? []],
          ["events",           data.events           ?? []],
          ["motos",            data.motos            ?? []],
          ["lap_crossings",    data.lapCrossings      ?? []],
          ["race_results",     data.raceResults       ?? []],
          ["users",            data.users            ?? []],
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

    const toSnake = (s: string) =>
      s.replace(/([A-Z])/g, "_$1").toLowerCase();

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
        const col = toSnake(k);
        if (knownCols.has(col)) snakeRow[col] = normalize(v);
      }

      const cols = Object.keys(snakeRow);
      if (!cols.includes("id") || cols.length < 2) continue; // can't upsert without id

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
