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

/**
 * Club setup that syncs both ways: scoring tables, series, discount categories
 * and codes, Sell Items and the rental transponder inventory (local-server
 * lib/desktop-ids.ts; cloud lib/desktopOrgPush.ts).
 */
const ORG_TABLES = ["points_tables", "series", "discount_categories", "comp_codes", "club_sell_items", "rental_transponders"] as const;
/** Pushed tables only a cloud with the "org_tables" capability stores (ORG_TABLES and the club profile). */
const ORG_PUSH_TABLES: ReadonlyArray<string> = [...ORG_TABLES, "clubs"];
const ORG_PUSH_CAPABILITY = "org_tables";
/** How long club-setup rows wait before the cloud is asked again whether it stores them. */
const ORG_HOLD_MS = 5 * 60_000;
const sqlList = (names: ReadonlyArray<string>) => names.map((n) => `'${n}'`).join(", ");

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
  private lastRowsChanged = false;
  /** Stable JSON fingerprint of the last successful sync-pull response.
   *  Used to skip upserts (and UI invalidations) on no-op cycles. */
  private lastPullHash: string | null = null;
  /** Rows skipped by upsertPulled() during the current pull because they have
   *  pending local writes. A pull with skipped rows is not cached in
   *  lastPullHash so the same cloud response is re-applied once they push. */
  private pullSkippedPending = 0;
  private sessionCookie: string | null = null;
  private flushTimer: ReturnType<typeof setInterval> | null = null;
  private listeners: StateChangeCallback[] = [];
  private flushPromise: Promise<void> | null = null;
  private pollIntervalMs: number;
  /**
   * Set when the cloud answered a push without the club-setup capability (an
   * older release): until this time those rows stay queued and are left out of
   * pushes, so they are neither lost nor in the way of race-day rows.
   */
  private orgHoldUntil = 0;

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
      CREATE TABLE IF NOT EXISTS _rider_cloud_map (
        local_rider_id INTEGER PRIMARY KEY,
        cloud_rider_id INTEGER,
        client_identity TEXT NOT NULL UNIQUE,
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE TABLE IF NOT EXISTS _rider_profile_dirty (
        rider_id INTEGER NOT NULL,
        field_name TEXT NOT NULL,
        version INTEGER NOT NULL DEFAULT 1,
        updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        PRIMARY KEY (rider_id, field_name)
      );
      DROP TRIGGER IF EXISTS _wq_riders_insert;
      DROP TRIGGER IF EXISTS _wq_riders_update;
      DELETE FROM _write_queue WHERE table_name = 'riders';
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
        `SELECT
           (SELECT COUNT(*) FROM _write_queue
            WHERE synced_at IS NULL AND attempt_count < ?)
           + (SELECT COUNT(*) FROM _rider_profile_dirty) AS cnt`,
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
      rowsChanged: this.lastRowsChanged,
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
    // Reset per-cycle flag so stale "true" from a previous cycle never leaks
    // into a no-data cycle and triggers a spurious queryClient.invalidateQueries().
    this.lastRowsChanged = false;

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
          await this.pushRiderProfiles();
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
      // pullCloud() returns true only when ≥1 SQLite row was actually changed.
      // DesktopSyncWatcher reads this flag and skips queryClient.invalidateQueries()
      // when nothing changed — preventing the 2-second UI jump on idle cycles.
      this.lastRowsChanged = await this.pullCloud();
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
    // Scoring tables and discount categories go first: events, series and codes
    // in the same or a later batch refer to them. Everything else in order.
    const holdOrg = Date.now() < this.orgHoldUntil;
    const rows = this.db
      .prepare(
        `SELECT * FROM _write_queue
         WHERE synced_at IS NULL AND attempt_count < ?
           ${holdOrg ? `AND table_name NOT IN (${sqlList(ORG_PUSH_TABLES)})` : ""}
         ORDER BY CASE WHEN operation != 'delete' AND table_name IN ('points_tables', 'discount_categories') THEN 0 ELSE 1 END, id ASC
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
      if (table === SyncEngine.ENDURO_SETUP_QUEUE) {
        payload[table] = this.buildEnduroSetupSnapshots(ids);
        continue;
      }
      if (table === SyncEngine.MOTO_SNAPSHOT_QUEUE) {
        payload[table] = this.buildMotoRaceSnapshots(ids);
        continue;
      }
      const placeholders = ids.map(() => "?").join(",");
      let tableRows = this.db
        .prepare(`SELECT * FROM ${table} WHERE id IN (${placeholders})`)
        .all(...ids) as Record<string, unknown>[];
      if (
        [
          "checkins",
          "rfid_assignments",
          "registrations",
          "race_results",
          "lap_crossings",
          "practice_crossings",
          "split_crossings",
          "practice_split_crossings",
          "enduro_checkpoint_arrivals",
          "comp_codes",
        ].includes(table)
      ) {
        const cloudIdFor = this.db.prepare(
          "SELECT cloud_rider_id FROM _rider_cloud_map WHERE local_rider_id = ?",
        );
        tableRows = tableRows.map((row) => {
          if (row.rider_id == null) return row;
          const mapped = cloudIdFor.get(Number(row.rider_id)) as
            | { cloud_rider_id: number | null }
            | undefined;
          return mapped?.cloud_rider_id != null
            ? { ...row, rider_id: mapped.cloud_rider_id }
            : row;
        });
      }
      if (table === "addon_payments" || table === "team_members") {
        // The cloud finds the entry by its id, or by the event and its rider
        // when the desktop's registration id differs from the cloud's.
        const regRider = this.db.prepare("SELECT rider_id FROM registrations WHERE id = ?");
        const cloudIdFor = this.db.prepare(
          "SELECT cloud_rider_id FROM _rider_cloud_map WHERE local_rider_id = ?",
        );
        const riderKey = table === "addon_payments" ? "rider_id" : "captain_rider_id";
        tableRows = tableRows
          // Payments pulled from the cloud are already there.
          .filter((row) => table !== "addon_payments" || row.cloud_id == null)
          .map((row) => {
            const reg = regRider.get(Number(row.registration_id)) as { rider_id: number | null } | undefined;
            if (reg?.rider_id == null) return row;
            const mapped = cloudIdFor.get(Number(reg.rider_id)) as { cloud_rider_id: number | null } | undefined;
            return { ...row, [riderKey]: mapped?.cloud_rider_id ?? reg.rider_id };
          });
      }
      // Only this club's profile and setup are the cloud's to store (the
      // placeholder club a new install starts with is not the signed-in club).
      if (table === "clubs") tableRows = tableRows.filter((row) => String(row.id) === String(this.clubId));
      if ((ORG_TABLES as ReadonlyArray<string>).includes(table)) {
        tableRows = tableRows.filter((row) => String(row.club_id) === String(this.clubId));
      }
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

    type IdRemap = { localId: number; cloudId: number };
    type PushResponse = {
      idRemaps?: { events?: IdRemap[]; motos?: IdRemap[] } & Record<string, IdRemap[] | undefined>;
      /** Newer tables this cloud stores; absent on an older cloud, which ignores them. */
      capabilities?: string[];
      // Rows the cloud did not apply, keyed by table (deletes use
      // "<table>_deleted"), identified by the desktop id that was sent.
      skipped?: Record<string, Array<{ id: number | null; reason: string }>>;
    };
    let pushResponse: PushResponse | null = null;
    try { pushResponse = JSON.parse(body) as PushResponse; } catch { /* ignore */ }

    // A 2xx response can still skip individual rows. Those must not be marked
    // synced: count them as a failed attempt with the cloud's reason so they
    // are retried and, after MAX_ATTEMPTS, dead-lettered visibly.
    const skippedReasonByQueueId = new Map<number, string>();
    for (const [key, entries] of Object.entries(pushResponse?.skipped ?? {})) {
      if (!Array.isArray(entries)) continue;
      const isDelete = key.endsWith("_deleted");
      const table = isDelete ? key.slice(0, -"_deleted".length) : key;
      for (const entry of entries) {
        if (entry?.id == null) {
          console.warn(`[sync] Cloud skipped a ${key} row without an id: ${entry?.reason ?? "unknown reason"}`);
          continue;
        }
        for (const row of rows) {
          if (
            row.table_name === table &&
            (row.operation === "delete") === isDelete &&
            Number(row.record_id) === Number(entry.id)
          ) {
            skippedReasonByQueueId.set(row.id, `Cloud skipped: ${entry.reason ?? "unknown reason"}`);
          }
        }
      }
    }

    // An older cloud answers OK without storing club setup. Those rows stay
    // queued (not failed) and are offered again later, when it may be newer.
    const cloudStoresOrg = Array.isArray(pushResponse?.capabilities) && pushResponse.capabilities.includes(ORG_PUSH_CAPABILITY);
    const heldQueueIds = new Set<number>(
      cloudStoresOrg ? [] : rows.filter((r) => ORG_PUSH_TABLES.includes(r.table_name)).map((r) => r.id),
    );
    if (heldQueueIds.size > 0) {
      this.orgHoldUntil = Date.now() + ORG_HOLD_MS;
      console.warn(`[sync] The cloud does not store club setup yet; ${heldQueueIds.size} change(s) stay queued`);
    }

    const syncedRows = rows.filter((r) => !skippedReasonByQueueId.has(r.id) && !heldQueueIds.has(r.id));
    const markResults = this.db.transaction(() => {
      if (syncedRows.length > 0) {
        this.db
          .prepare(
            "UPDATE _write_queue SET synced_at = ?, error = NULL WHERE id IN (" +
              syncedRows.map(() => "?").join(",") +
              ")",
          )
          .run(now, ...syncedRows.map((r) => r.id));
      }
      const markSkipped = this.db.prepare(
        "UPDATE _write_queue SET attempt_count = attempt_count + 1, error = ? WHERE id = ?",
      );
      for (const [queueId, reason] of skippedReasonByQueueId) {
        markSkipped.run(reason, queueId);
      }
    });
    markResults();
    if (skippedReasonByQueueId.size > 0) {
      console.warn(
        `[sync] Cloud skipped ${skippedReasonByQueueId.size} pushed row(s); ` +
        `they stay queued for retry (max ${MAX_ATTEMPTS} attempts)`,
      );
    }

    // Apply any id remaps returned by the cloud (event/moto id collisions).
    // Events first: remapped motos may belong to a remapped event.
    const eventRemaps = pushResponse?.idRemaps?.events ?? [];
    if (eventRemaps.length > 0) {
      this.applyEventIdRemaps(eventRemaps);
    }
    const motoRemaps = pushResponse?.idRemaps?.motos ?? [];
    if (motoRemaps.length > 0) {
      this.applyMotoIdRemaps(motoRemaps);
    }
    for (const table of ORG_TABLES) {
      const remaps = pushResponse?.idRemaps?.[table];
      if (Array.isArray(remaps) && remaps.length > 0) this.applyOrgIdRemaps(table, remaps);
    }
  }

  /** What refers to a club-setup row by id, and how the id is stored there. */
  private static readonly ORG_REFERENCES: Readonly<Record<string, ReadonlyArray<{
    table: string; column: string; kind: "scalar" | "jsonArray" | "jsonMap"; push: boolean;
  }>>> = {
    points_tables: [
      { table: "series", column: "scoring_table_id", kind: "scalar", push: true },
      { table: "events", column: "scoring_table_id", kind: "scalar", push: true },
    ],
    discount_categories: [
      { table: "events", column: "entry_fee_category_id", kind: "scalar", push: true },
      { table: "comp_codes", column: "category_ids", kind: "jsonArray", push: true },
    ],
    series: [
      { table: "events", column: "race_class_series_map", kind: "jsonMap", push: true },
      { table: "series_points", column: "series_id", kind: "scalar", push: false },
    ],
  };

  /**
   * Rewrites every reference to `fromId` in `table.column` and returns the ids
   * of the rows it changed. Must run under _cloud_pull_guard.
   */
  private rewriteReferences(
    ref: { table: string; column: string; kind: "scalar" | "jsonArray" | "jsonMap" },
    fromId: number,
    toId: number,
  ): number[] {
    if (!this.localColumns(ref.table).has(ref.column)) return [];
    if (ref.kind === "scalar") {
      const ids = (this.db.prepare(`SELECT id FROM ${ref.table} WHERE ${ref.column} = ?`).all(fromId) as Array<{ id: number }>).map((r) => r.id);
      if (ids.length > 0) this.db.prepare(`UPDATE ${ref.table} SET ${ref.column} = ? WHERE ${ref.column} = ?`).run(toId, fromId);
      return ids;
    }
    const swap = (list: unknown): unknown[] | null =>
      Array.isArray(list) && list.some((n) => Number(n) === fromId) ? list.map((n) => (Number(n) === fromId ? toId : n)) : null;
    const changed: number[] = [];
    const save = this.db.prepare(`UPDATE ${ref.table} SET ${ref.column} = ? WHERE id = ?`);
    for (const row of this.db.prepare(`SELECT id, ${ref.column} AS value FROM ${ref.table} WHERE ${ref.column} IS NOT NULL`).all() as Array<{ id: number; value: string }>) {
      let parsed: unknown;
      try { parsed = JSON.parse(row.value); } catch { continue; }
      let next: unknown = null;
      if (ref.kind === "jsonArray") {
        next = swap(parsed);
      } else if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        const map = { ...(parsed as Record<string, unknown>) };
        let touched = false;
        for (const [key, list] of Object.entries(map)) {
          const swapped = swap(list);
          if (swapped) { map[key] = swapped; touched = true; }
        }
        next = touched ? map : null;
      }
      if (next == null) continue;
      save.run(JSON.stringify(next), row.id);
      changed.push(row.id);
    }
    return changed;
  }

  /** Queues rows for the cloud (an upsert each) unless one already waits. Safe under the guard. */
  private enqueueUpserts(table: string, ids: number[]): void {
    const hasPending = this.db.prepare(
      `SELECT 1 FROM _write_queue
       WHERE table_name = ? AND record_id = ? AND synced_at IS NULL
         AND attempt_count < ? AND operation != 'delete'
       LIMIT 1`,
    );
    const enqueue = this.db.prepare("INSERT INTO _write_queue (table_name, record_id, operation) VALUES (?, ?, 'upsert')");
    for (const id of ids) if (!hasPending.get(table, id, MAX_ATTEMPTS)) enqueue.run(table, id);
  }

  /**
   * The cloud saved a club-setup row under a different id than the desktop's
   * (the same thing already existed there, or the id was taken). Renumbers the
   * local row, everything that refers to it and its queue entries; rows whose
   * reference changed are pushed again so the cloud has the new id too.
   */
  private applyOrgIdRemaps(table: string, remaps: Array<{ localId: number; cloudId: number }>): void {
    const doRemap = this.db.transaction(() => {
      this.db.prepare("INSERT OR IGNORE INTO _cloud_pull_guard VALUES(1)").run();
      try {
        for (const { localId, cloudId } of remaps) {
          if (!localId || !cloudId || localId === cloudId) continue;
          const mine = this.db.prepare(`SELECT 1 FROM ${table} WHERE id = ?`).get(localId);
          if (mine) {
            // The cloud's row may already be here (pulled): then this copy goes.
            const theirs = this.db.prepare(`SELECT 1 FROM ${table} WHERE id = ?`).get(cloudId);
            if (theirs) this.db.prepare(`DELETE FROM ${table} WHERE id = ?`).run(localId);
            else this.db.prepare(`UPDATE ${table} SET id = ? WHERE id = ?`).run(cloudId, localId);
          }
          for (const ref of SyncEngine.ORG_REFERENCES[table] ?? []) {
            const changed = this.rewriteReferences(ref, localId, cloudId);
            if (ref.push) this.enqueueUpserts(ref.table, changed);
          }
          this.db
            .prepare("UPDATE _write_queue SET record_id = ? WHERE table_name = ? AND record_id = ?")
            .run(cloudId, table, localId);
        }
      } finally {
        this.db.prepare("DELETE FROM _cloud_pull_guard").run();
      }
    });
    doRemap();
  }

  private async pushRiderProfiles(): Promise<void> {
    const dirty = this.db.prepare(`
      SELECT rider_id, field_name, version
      FROM _rider_profile_dirty
      ORDER BY rider_id, field_name
    `).all() as Array<{ rider_id: number; field_name: string; version: number }>;
    if (!dirty.length) return;

    const byRider = new Map<number, Array<{ field: string; version: number }>>();
    for (const row of dirty) {
      const fields = byRider.get(row.rider_id) ?? [];
      fields.push({ field: row.field_name, version: row.version });
      byRider.set(row.rider_id, fields);
    }

    const definitions: Record<string, string> = {
      firstName: "first_name", lastName: "last_name", email: "email", phone: "phone",
      dateOfBirth: "date_of_birth", emergencyContact: "emergency_contact",
      emergencyPhone: "emergency_phone", rfidNumber: "rfid_number",
      streetAddress: "street_address", city: "city", homeState: "home_state",
      zip: "zip", bibNumber: "bib_number", amaNumber: "ama_number",
      bikeManufacturer: "bike_manufacturer", bikeModel: "bike_model",
      bikeYear: "bike_year", sponsors: "sponsors",
      mylapsTransponderId: "mylaps_transponder_id",
    };
    const riderStmt = this.db.prepare("SELECT * FROM riders WHERE id = ?");
    const identityStmt = this.db.prepare(
      "SELECT client_identity, cloud_rider_id FROM _rider_cloud_map WHERE local_rider_id = ?",
    );
    const riders: Record<string, unknown>[] = [];
    for (const [localId, fields] of byRider) {
      const row = riderStmt.get(localId) as Record<string, unknown> | undefined;
      const identity = identityStmt.get(localId) as
        | { client_identity: string; cloud_rider_id: number | null }
        | undefined;
      if (!row || !identity) continue;
      const payload: Record<string, unknown> = {
        id: localId,
        localRiderId: localId,
        clientIdentity: identity.client_identity,
        ...(identity.cloud_rider_id != null
          ? { cloudRiderId: identity.cloud_rider_id }
          : {}),
      };
      for (const { field } of fields) {
        const column = definitions[field];
        if (column) payload[field] = row[column];
      }
      riders.push(payload);
    }
    if (!riders.length) return;

    const res = await fetch(`${this.cloudUrl}/api/clubs/${this.clubId}/sync`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: this.sessionCookie! },
      body: JSON.stringify({ riders }),
    });
    const body = await res.text();
    if (!res.ok) throw new Error(`Rider profile push failed (${res.status}): ${body}`);
    const result = JSON.parse(body) as { riderIdMap?: Record<string, number> };
    if (!result.riderIdMap) return;

    const saveMap = this.db.prepare(`
      UPDATE _rider_cloud_map SET cloud_rider_id = ?, updated_at = datetime('now')
      WHERE local_rider_id = ?
    `);
    const acknowledge = this.db.prepare(`
      DELETE FROM _rider_profile_dirty
      WHERE rider_id = ? AND field_name = ? AND version = ?
    `);
    this.db.transaction(() => {
      for (const [localIdText, cloudId] of Object.entries(result.riderIdMap ?? {})) {
        const localId = Number(localIdText);
        saveMap.run(cloudId, localId);
        for (const field of byRider.get(localId) ?? []) {
          acknowledge.run(localId, field.field, field.version);
        }
      }
    })();
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
    ["split_crossings",   "event_id"],
    ["practice_sessions", "event_id"],
    ["liability_waiver_signatures", "event_id"],
    ["enduro_checkpoint_arrivals",  "event_id"],
    ["team_members",      "event_id"],
    ["addon_payments",    "event_id"],
    ["comp_codes",        "event_id"],
  ];

  /**
   * Write-queue name for an event's enduro setup: its time checks, penalty
   * config and reader assignments. Each is saved as a whole on the desktop
   * (PUT replaces them), so they sync as one snapshot per event whose
   * record_id is the event id (queued by local-server routes/enduro.ts).
   */
  private static readonly ENDURO_SETUP_QUEUE = "event_enduro_setup";

  /** Snapshot tables pushed under ENDURO_SETUP_QUEUE (pull prunes them per event). */
  private static readonly ENDURO_SETUP_TABLES: ReadonlyArray<string> = [
    "enduro_time_checks",
    "event_reader_assignments",
  ];

  /**
   * A lap or a result deleted on the desktop (a crossing removed, a rider's
   * last lap gone, a restart): the race is sent whole, so the cloud's laps and
   * results for it end up the same as here. record_id is the moto id (queued by
   * the delete triggers in local-server db-init.ts).
   */
  private static readonly MOTO_SNAPSHOT_QUEUE = "moto_race_snapshot";

  private buildMotoRaceSnapshots(motoIds: number[]): Record<string, unknown>[] {
    const cloudIdFor = this.db.prepare("SELECT cloud_rider_id FROM _rider_cloud_map WHERE local_rider_id = ?");
    const cloudRider = (id: unknown): unknown => {
      if (id == null) return id;
      const mapped = cloudIdFor.get(Number(id)) as { cloud_rider_id: number | null } | undefined;
      return mapped?.cloud_rider_id ?? id;
    };
    const out: Record<string, unknown>[] = [];
    for (const motoId of [...new Set(motoIds)]) {
      const moto = this.db.prepare("SELECT id, event_id FROM motos WHERE id = ?").get(motoId) as { id: number; event_id: number } | undefined;
      // Race deleted since: its delete is pushed separately; nothing to send.
      if (!moto) continue;
      const crossings = this.db.prepare("SELECT * FROM lap_crossings WHERE moto_id = ? ORDER BY id").all(motoId) as Record<string, unknown>[];
      const resultRiders = this.db.prepare("SELECT rider_id FROM race_results WHERE moto_id = ?").all(motoId) as Array<{ rider_id: number }>;
      out.push({
        id: motoId,
        moto_id: motoId,
        event_id: moto.event_id,
        lap_crossings: crossings.map((c) => ({ ...c, rider_id: cloudRider(c.rider_id) })),
        result_rider_ids: resultRiders.map((r) => cloudRider(r.rider_id)),
      });
    }
    return out;
  }

  private buildEnduroSetupSnapshots(eventIds: number[]): Record<string, unknown>[] {
    const out: Record<string, unknown>[] = [];
    for (const eventId of eventIds) {
      const event = this.db
        .prepare("SELECT id, enduro_penalty_config FROM events WHERE id = ?")
        .get(eventId) as { id: number; enduro_penalty_config: string | null } | undefined;
      // Event deleted since: its delete is pushed separately; nothing to send.
      if (!event) continue;
      let penaltyConfig: unknown = null;
      try { penaltyConfig = event.enduro_penalty_config ? JSON.parse(event.enduro_penalty_config) : null; } catch { /* keep null */ }
      out.push({
        id: eventId,
        event_id: eventId,
        enduro_penalty_config: penaltyConfig,
        time_checks: this.db
          .prepare("SELECT * FROM enduro_time_checks WHERE event_id = ? ORDER BY check_number, id")
          .all(eventId),
        reader_assignments: this.db
          .prepare("SELECT * FROM event_reader_assignments WHERE event_id = ? ORDER BY id")
          .all(eventId),
        // This release keeps the course map (finish + split rows) locally, so
        // the cloud can replace them; older releases must not wipe them.
        course_rows_included: true,
      });
    }
    return out;
  }

  /** Moves an event's (or moto's) enduro setup to a remapped id and re-queues it. */
  private remapEnduroSetup(column: "event_id" | "moto_id", localId: number, cloudId: number): void {
    const eventIds = new Set<number>();
    for (const table of SyncEngine.ENDURO_SETUP_TABLES) {
      if (!this.localColumns(table).has(column)) continue;
      for (const row of this.db
        .prepare(`SELECT DISTINCT event_id FROM ${table} WHERE ${column} = ?`)
        .all(localId) as Array<{ event_id: number }>) {
        eventIds.add(column === "event_id" ? cloudId : row.event_id);
      }
      this.db.prepare(`UPDATE ${table} SET ${column} = ? WHERE ${column} = ?`).run(cloudId, localId);
    }
    if (column === "event_id") {
      this.db
        .prepare("UPDATE _write_queue SET record_id = ? WHERE table_name = ? AND record_id = ?")
        .run(cloudId, SyncEngine.ENDURO_SETUP_QUEUE, localId);
    }
    for (const eventId of eventIds) {
      this.db
        .prepare("INSERT INTO _write_queue (table_name, record_id, operation) VALUES (?, ?, 'upsert')")
        .run(SyncEngine.ENDURO_SETUP_QUEUE, eventId);
    }
  }

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

          // Patch FK columns in all child tables, then re-queue the rewritten
          // children so they push under the new id.
          this.remapChildForeignKeys(SyncEngine.EVENT_CHILD_TABLES, localId, cloudId);
          this.remapEnduroSetup("event_id", localId, cloudId);
          // Series list their events by id.
          this.enqueueUpserts("series", this.rewriteReferences({ table: "series", column: "event_ids", kind: "jsonArray" }, localId, cloudId));

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

  // Child tables that carry a moto_id FK (see local-server db-init.ts).
  private static readonly MOTO_CHILD_TABLES: ReadonlyArray<[string, string]> = [
    ["lap_crossings", "moto_id"],
    ["split_crossings", "moto_id"],
    ["race_results",  "moto_id"],
  ];

  // Write-queue operation each table's insert trigger uses (db-init.ts).
  private static readonly QUEUE_OPERATION: Readonly<Record<string, string>> = {
    lap_crossings: "insert",
    practice_crossings: "insert",
    split_crossings: "insert",
    practice_split_crossings: "insert",
    liability_waiver_signatures: "insert",
    addon_payments: "insert",
  };

  /**
   * Rewrites `fkCol` from localId to cloudId in each child table and enqueues
   * every rewritten row. Must run under _cloud_pull_guard (the UPDATE triggers
   * are suppressed there), so without the explicit enqueue the cloud would
   * keep the children under the stale parent id. Child tables whose FK column
   * does not exist locally are skipped instead of failing the remap.
   */
  private remapChildForeignKeys(
    childTables: ReadonlyArray<[string, string]>,
    localId: number,
    cloudId: number,
  ): void {
    const hasPending = this.db.prepare(
      `SELECT 1 FROM _write_queue
       WHERE table_name = ? AND record_id = ? AND synced_at IS NULL
         AND attempt_count < ? AND operation != 'delete'
       LIMIT 1`,
    );
    const enqueue = this.db.prepare(
      "INSERT INTO _write_queue (table_name, record_id, operation) VALUES (?, ?, ?)",
    );
    for (const [childTable, fkCol] of childTables) {
      if (!this.localColumns(childTable).has(fkCol)) continue;
      const childIds = (
        this.db
          .prepare(`SELECT id FROM ${childTable} WHERE ${fkCol} = ?`)
          .all(localId) as Array<{ id: number }>
      ).map((r) => r.id);
      if (childIds.length === 0) continue;
      this.db
        .prepare(`UPDATE ${childTable} SET ${fkCol} = ? WHERE ${fkCol} = ?`)
        .run(cloudId, localId);
      const operation = SyncEngine.QUEUE_OPERATION[childTable] ?? "upsert";
      for (const id of childIds) {
        // A live pending entry already pushes the current row; don't duplicate.
        if (hasPending.get(childTable, id, MAX_ATTEMPTS)) continue;
        enqueue.run(childTable, id, operation);
      }
    }
  }

  /**
   * Same as applyEventIdRemaps, for motos the cloud stored under a different
   * id: patches motos.id, every moto_id FK, and the motos write-queue rows,
   * then re-queues the rewritten children.
   */
  private applyMotoIdRemaps(
    remaps: Array<{ localId: number; cloudId: number }>,
  ): void {
    if (!remaps.length) return;

    const doRemap = this.db.transaction(() => {
      this.db.prepare("INSERT OR IGNORE INTO _cloud_pull_guard VALUES(1)").run();
      try {
        for (const { localId, cloudId } of remaps) {
          if (localId === cloudId) continue;
          // If a different local moto already holds the cloud id, rewriting the
          // primary key would fail and roll back every remap in this batch.
          const occupied = this.db
            .prepare("SELECT 1 FROM motos WHERE id = ?")
            .get(cloudId);
          if (occupied) {
            console.warn(
              `[sync] Moto id remap ${localId} -> ${cloudId} skipped: ` +
              `a local moto already uses id ${cloudId}`,
            );
            continue;
          }

          this.db
            .prepare("UPDATE motos SET id = ? WHERE id = ?")
            .run(cloudId, localId);

          this.remapChildForeignKeys(SyncEngine.MOTO_CHILD_TABLES, localId, cloudId);
          this.remapEnduroSetup("moto_id", localId, cloudId);

          this.db
            .prepare(
              "UPDATE _write_queue SET record_id = ? WHERE table_name IN ('motos', 'moto_race_snapshot') AND record_id = ?",
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

  private async pullCloud(): Promise<boolean> {
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

    // Read as text first so we can build a stable hash for change detection.
    // ON CONFLICT DO UPDATE always counts as a SQLite "change" even when values
    // are identical, so we compare a sorted fingerprint of the response to skip
    // upserts entirely on no-op cycles — keeping rowsChanged === false and
    // preventing DesktopSyncWatcher from calling invalidateQueries every 2 s.
    const responseText = await res.text();
    const rawData = JSON.parse(responseText) as Record<string, unknown[]>;

    // Sort each array by id for a stable comparison that is order-independent
    // (PostgreSQL does not guarantee heap-scan order across calls).
    const stableHash = JSON.stringify(
      Object.keys(rawData)
        .sort()
        .reduce<Record<string, unknown[]>>((acc, key) => {
          const arr = rawData[key];
          acc[key] = Array.isArray(arr)
            ? [...arr].sort((a: any, b: any) => (a.id ?? 0) - (b.id ?? 0))
            : arr;
          return acc;
        }, {}),
    );

    if (stableHash === this.lastPullHash) {
      // Identical response — nothing to upsert, nothing changed.
      return false;
    }

    const data = rawData as {
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
      splitCrossings?: Record<string, unknown>[];
      practiceSplitCrossings?: Record<string, unknown>[];
      clubSettings?: Record<string, unknown>[];
      liabilityWaiverSignatures?: Record<string, unknown>[];
      enduroTimeChecks?: Record<string, unknown>[];
      enduroCheckpointArrivals?: Record<string, unknown>[];
      eventReaderAssignments?: Record<string, unknown>[];
      teamMembers?: Record<string, unknown>[];
      clubSellItems?: Record<string, unknown>[];
      rentalTransponders?: Record<string, unknown>[];
      readers?: Record<string, unknown>[];
      addonPayments?: Record<string, unknown>[];
      tracks?: Record<string, unknown>[];
      eventPublication?: Record<string, unknown>[];
    };

    const now = new Date().toISOString();

    // Upsert all tables inside one transaction and advance watermarks atomically.
    // The _cloud_pull_guard flag prevents SQLite triggers from re-enqueueing
    // cloud-originated rows back into _write_queue (echo suppression).
    let totalChanged = 0;
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
          ["comp_codes",          this.localizeCompCodeRiders(data.compCodes ?? [])],
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
          ["club_settings",       data.clubSettings        ?? []],
          ["liability_waiver_signatures", data.liabilityWaiverSignatures ?? []],
          ["enduro_time_checks",  data.enduroTimeChecks    ?? []],
          ["enduro_checkpoint_arrivals", data.enduroCheckpointArrivals ?? []],
          ["event_reader_assignments", data.eventReaderAssignments ?? []],
          ["club_sell_items",     data.clubSellItems       ?? []],
          ["rental_transponders", this.pulledRentalUnits(data.rentalTransponders ?? [])],
          ["readers",             data.readers             ?? []],
          ["tracks",              data.tracks              ?? []],
        ];

        for (const [table, rows] of tableMap) {
          totalChanged += this.upsertPulled(table, rows);
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
        this.pruneEnduroRows(data);
        // Club setup removed on the website (a cloud that sends the rental inventory sends all of it).
        if (Array.isArray(data.rentalTransponders)) totalChanged += this.pruneOrgTables(data);
        if (Array.isArray(data.readers)) {
          // Readers the club removed on the website.
          const keep = new Set(data.readers.map((r) => Number(r["id"])));
          const remove = this.db.prepare("DELETE FROM readers WHERE id = ?");
          for (const { id } of this.db.prepare("SELECT id FROM readers").all() as Array<{ id: number }>) {
            if (!keep.has(id)) remove.run(id);
          }
        }
        if (Array.isArray(data.tracks)) {
          // Track Library rows removed on the website (ones waiting to be pushed stay).
          const keep = new Set(data.tracks.map((t) => Number(t["id"])));
          const pending = new Set(
            (this.db
              .prepare("SELECT record_id FROM _write_queue WHERE table_name = 'tracks' AND synced_at IS NULL AND attempt_count < ?")
              .all(MAX_ATTEMPTS) as Array<{ record_id: number }>).map((r) => r.record_id),
          );
          const remove = this.db.prepare("DELETE FROM tracks WHERE id = ?");
          for (const { id } of this.db.prepare("SELECT id FROM tracks").all() as Array<{ id: number }>) {
            if (!keep.has(id) && !pending.has(id)) totalChanged += remove.run(id).changes;
          }
        }
        if (Array.isArray(data.eventPublication)) {
          // Whether each event's results are official (one row per event, keyed by the event).
          const save = this.db.prepare(
            `INSERT INTO event_publication (event_id, published, published_at, updated_at)
             VALUES (?, ?, ?, ?)
             ON CONFLICT(event_id) DO UPDATE SET
               published = excluded.published, published_at = excluded.published_at, updated_at = excluded.updated_at
             WHERE event_publication.published IS NOT excluded.published
                OR event_publication.published_at IS NOT excluded.published_at`,
          );
          const pendingMotoEvents = new Set(
            (this.db
              .prepare(
                `SELECT DISTINCT m.event_id AS event_id FROM _write_queue q JOIN motos m ON m.id = q.record_id
                 WHERE q.table_name = 'motos' AND q.synced_at IS NULL AND q.attempt_count < ?`,
              )
              .all(MAX_ATTEMPTS) as Array<{ event_id: number }>).map((r) => r.event_id),
          );
          for (const row of data.eventPublication) {
            const eventId = Number(row["eventId"]);
            // A race finalized here and not pushed yet keeps the desktop's state.
            if (!eventId || pendingMotoEvents.has(eventId)) continue;
            const at = row["publishedAt"] != null ? String(row["publishedAt"]) : null;
            totalChanged += save.run(eventId, row["published"] ? 1 : 0, at, String(row["updatedAt"] ?? now)).changes;
          }
        }
        if (Array.isArray(data.teamMembers)) totalChanged += this.upsertPulledTeamMembers(data.teamMembers);
        if (Array.isArray(data.addonPayments)) totalChanged += this.upsertPulledAddonPayments(data.addonPayments);
        if (Array.isArray(data.splitCrossings)) totalChanged += this.upsertPulledSplits("split_crossings", "moto_id", data.splitCrossings);
        if (Array.isArray(data.practiceSplitCrossings)) totalChanged += this.upsertPulledSplits("practice_split_crossings", "session_id", data.practiceSplitCrossings);
      } finally {
        // Always clear the guard, even if an upsert threw.
        this.db.prepare("DELETE FROM _cloud_pull_guard").run();
      }
    });

    this.pullSkippedPending = 0;
    upsertAll();

    // Cache the fingerprint only after the upsert transaction committed, and
    // only when every row was applied. If rows were skipped because of pending
    // local writes, an identical response must still be upserted next cycle.
    this.lastPullHash = this.pullSkippedPending === 0 ? stableHash : null;

    // Return whether any SQLite rows were actually inserted or updated.
    // The caller (_flush) stores this in lastRowsChanged so DesktopSyncWatcher
    // can skip queryClient.invalidateQueries() on no-op cycles.
    const rowsChanged = totalChanged > 0;

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

    return rowsChanged;
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
   * The cloud replaces an event's time checks and reader assignments wholesale
   * (new ids each save) and deletes arrivals, so rows the cloud no longer has
   * would otherwise linger locally. For each event in this pull, removes local
   * rows missing from the cloud response unless they still wait to be pushed.
   * Older cloud servers that don't send these tables are left alone. Runs
   * under _cloud_pull_guard, so the deletes are not queued back to the cloud.
   */
  private pruneEnduroRows(data: {
    events?: Record<string, unknown>[];
    enduroTimeChecks?: Record<string, unknown>[];
    enduroCheckpointArrivals?: Record<string, unknown>[];
    eventReaderAssignments?: Record<string, unknown>[];
  }): void {
    const eventIds = (data.events ?? []).map((e) => Number(e["id"])).filter((n) => n > 0);
    if (eventIds.length === 0) return;
    const pendingSetup = new Set(
      (this.db
        .prepare(
          `SELECT record_id FROM _write_queue
           WHERE table_name = ? AND synced_at IS NULL AND attempt_count < ?`,
        )
        .all(SyncEngine.ENDURO_SETUP_QUEUE, MAX_ATTEMPTS) as Array<{ record_id: number }>).map((r) => r.record_id),
    );
    const pendingArrivals = new Set(
      (this.db
        .prepare(
          `SELECT record_id FROM _write_queue
           WHERE table_name = 'enduro_checkpoint_arrivals' AND synced_at IS NULL AND attempt_count < ?`,
        )
        .all(MAX_ATTEMPTS) as Array<{ record_id: number }>).map((r) => r.record_id),
    );
    const sets: Array<[string, Record<string, unknown>[] | undefined, (eventId: number, rowId: number) => boolean]> = [
      ["enduro_time_checks", data.enduroTimeChecks, (eventId) => pendingSetup.has(eventId)],
      ["event_reader_assignments", data.eventReaderAssignments, (eventId) => pendingSetup.has(eventId)],
      ["enduro_checkpoint_arrivals", data.enduroCheckpointArrivals, (_eventId, rowId) => pendingArrivals.has(rowId)],
    ];
    for (const [table, rows, isPending] of sets) {
      if (!Array.isArray(rows) || !this.localColumns(table).has("event_id")) continue;
      const cloudIds = new Set(rows.map((r) => Number(r["id"])));
      const select = this.db.prepare(`SELECT id, event_id FROM ${table} WHERE event_id = ?`);
      const del = this.db.prepare(`DELETE FROM ${table} WHERE id = ?`);
      for (const eventId of eventIds) {
        for (const row of select.all(eventId) as Array<{ id: number; event_id: number }>) {
          if (cloudIds.has(row.id) || isPending(row.event_id, row.id)) continue;
          del.run(row.id);
        }
      }
    }
  }

  /**
   * Upserts cloud rows into the local SQLite table.
   * - Converts camelCase cloud keys to snake_case.
   * - Filters out any cloud-side columns that don't exist locally (avoids
   *   "table has no column" errors when cloud schema is ahead of local schema).
   * - Throws on genuine SQL errors so the caller can mark sync state as error.
   */
  /**
   * Club setup the website no longer has: scoring tables, series, discount
   * categories and codes, sell items and rental units missing from the cloud's
   * answer are removed here too. A row with anything still queued for the
   * cloud stays (made or changed here and not sent yet, or refused: its error
   * shows in the sync status), so nothing made on the desktop is dropped unseen.
   * Runs under _cloud_pull_guard, so the removals are not queued back.
   */
  private pruneOrgTables(data: Record<string, unknown>): number {
    // Rows made here before club setup synced are queued by the offline server
    // at startup (local-server db-init queueLegacyClubSetup); never prune before that.
    try {
      if (!this.db.prepare("SELECT 1 FROM _local_data_migrations WHERE name = 'queue-local-club-setup'").get()) return 0;
    } catch {
      return 0;
    }
    const sets: Array<[string, unknown]> = [
      ["comp_codes", data["compCodes"]],
      ["series", data["series"]],
      ["discount_categories", data["discountCategories"]],
      ["points_tables", data["pointsTables"]],
      ["club_sell_items", data["clubSellItems"]],
      ["rental_transponders", data["rentalTransponders"]],
    ];
    let removed = 0;
    for (const [table, rows] of sets) {
      if (!Array.isArray(rows) || !this.localColumns(table).has("id")) continue;
      const keep = new Set(rows.map((r) => Number((r as Record<string, unknown>)["id"])));
      const queued = new Set(
        (this.db
          .prepare("SELECT record_id FROM _write_queue WHERE table_name = ? AND synced_at IS NULL")
          .all(table) as Array<{ record_id: number }>).map((r) => r.record_id),
      );
      // The RM TrackR and RFID Tag always exist: a club that hasn't opened Sell
      // Items on the website has none there yet, and keeps the ones made here.
      const cloudKinds = table === "club_sell_items"
        ? new Set(rows.map((r) => String((r as Record<string, unknown>)["kind"])))
        : null;
      const local = this.db
        .prepare(`SELECT id, club_id${cloudKinds ? ", kind" : ""} FROM ${table}`)
        .all() as Array<{ id: number; club_id: number | null; kind?: string }>;
      const remove = this.db.prepare(`DELETE FROM ${table} WHERE id = ?`);
      for (const row of local) {
        if (keep.has(row.id) || queued.has(row.id)) continue;
        // Only this club's rows (and the built-in scoring tables) mirror the cloud.
        const mirrored = String(row.club_id) === String(this.clubId) || (table === "points_tables" && row.club_id == null);
        if (!mirrored) continue;
        if (cloudKinds && row.kind !== "custom" && !cloudKinds.has(String(row.kind))) continue;
        removed += remove.run(row.id).changes;
      }
    }
    return removed;
  }

  /**
   * Discount codes for one rider carry the cloud's rider id; here the rider may
   * have another id (made on this desktop). Uses the desktop's id, and keeps
   * the one the local code already has when it is the same rider.
   */
  private localizeCompCodeRiders(rows: Record<string, unknown>[]): Record<string, unknown>[] {
    if (!rows.some((r) => r["riderId"] != null) || !this.localColumns("comp_codes").has("rider_id")) return rows;
    const localFor = this.db.prepare(
      "SELECT local_rider_id FROM _rider_cloud_map WHERE cloud_rider_id = ? ORDER BY local_rider_id LIMIT 1",
    );
    const cloudFor = this.db.prepare("SELECT cloud_rider_id FROM _rider_cloud_map WHERE local_rider_id = ?");
    const current = this.db.prepare("SELECT rider_id FROM comp_codes WHERE id = ?");
    return rows.map((r) => {
      if (r["riderId"] == null) return r;
      const cloudRider = Number(r["riderId"]);
      const mine = current.get(Number(r["id"])) as { rider_id: number | null } | undefined;
      if (mine?.rider_id != null) {
        const known = cloudFor.get(mine.rider_id) as { cloud_rider_id: number | null } | undefined;
        if (known?.cloud_rider_id === cloudRider) return { ...r, riderId: mine.rider_id };
      }
      const mapped = localFor.get(cloudRider) as { local_rider_id: number } | undefined;
      return mapped ? { ...r, riderId: mapped.local_rider_id } : r;
    });
  }

  /**
   * Rental units are one per number. A unit listed here under another id (added
   * on this desktop, or at check-in) is the same unit: one still waiting to be
   * pushed keeps the desktop's row for now (the push pairs the two); otherwise
   * the cloud's row replaces it.
   */
  private pulledRentalUnits(rows: Record<string, unknown>[]): Record<string, unknown>[] {
    if (rows.length === 0 || !this.localColumns("rental_transponders").has("transponder_number")) return [];
    const twin = this.db.prepare("SELECT id FROM rental_transponders WHERE club_id = ? AND transponder_number = ? AND id != ?");
    const queued = this.db.prepare("SELECT 1 FROM _write_queue WHERE table_name = 'rental_transponders' AND record_id = ? AND synced_at IS NULL LIMIT 1");
    const remove = this.db.prepare("DELETE FROM rental_transponders WHERE id = ?");
    return rows.filter((r) => {
      const mine = twin.get(Number(r["clubId"]), String(r["transponderNumber"]), Number(r["id"])) as { id: number } | undefined;
      if (!mine) return true;
      if (queued.get(mine.id)) { this.pullSkippedPending++; return false; }
      remove.run(mine.id);
      return true;
    });
  }

  private pendingIds(table: string): Set<number> {
    return new Set(
      (this.db
        .prepare("SELECT record_id FROM _write_queue WHERE table_name = ? AND synced_at IS NULL AND attempt_count < ?")
        .all(table, MAX_ATTEMPTS) as Array<{ record_id: number }>).map((r) => r.record_id),
    );
  }

  /**
   * Group race rosters. A member is identified by (registration, position), not
   * by id: the desktop numbers its own rows. A member edited here and not yet
   * pushed keeps the desktop's version.
   */
  private upsertPulledTeamMembers(rows: Record<string, unknown>[]): number {
    const pending = this.pendingIds("team_members");
    const find = this.db.prepare("SELECT id FROM team_members WHERE registration_id = ? AND position = ?");
    const upsert = this.db.prepare(
      `INSERT INTO team_members (event_id, registration_id, position, rider_id, first_name, last_name, email,
                                 rfid_number, trackr_number, trackr_choice, rfid_purchased)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(registration_id, position) DO UPDATE SET
         event_id = excluded.event_id, rider_id = excluded.rider_id,
         first_name = excluded.first_name, last_name = excluded.last_name, email = excluded.email,
         rfid_number = excluded.rfid_number, trackr_number = excluded.trackr_number,
         trackr_choice = excluded.trackr_choice, rfid_purchased = excluded.rfid_purchased,
         updated_at = datetime('now')
       WHERE COALESCE(team_members.rider_id, 0) != COALESCE(excluded.rider_id, 0)
          OR team_members.first_name != excluded.first_name OR team_members.last_name != excluded.last_name
          OR COALESCE(team_members.email, '') != COALESCE(excluded.email, '')
          OR COALESCE(team_members.rfid_number, '') != COALESCE(excluded.rfid_number, '')
          OR COALESCE(team_members.trackr_number, '') != COALESCE(excluded.trackr_number, '')
          OR COALESCE(team_members.trackr_choice, '') != COALESCE(excluded.trackr_choice, '')
          OR team_members.rfid_purchased != excluded.rfid_purchased`,
    );
    const text = (v: unknown) => (v == null || v === "" ? null : String(v));
    let changed = 0;
    for (const r of rows) {
      const registrationId = Number(r["registrationId"]);
      const position = Number(r["position"]);
      if (!registrationId || !position || !r["firstName"] || !r["lastName"]) continue;
      const local = find.get(registrationId, position) as { id: number } | undefined;
      if (local && pending.has(local.id)) { this.pullSkippedPending++; continue; }
      changed += upsert.run(
        Number(r["eventId"]), registrationId, position, r["riderId"] == null ? null : Number(r["riderId"]),
        String(r["firstName"]), String(r["lastName"]), text(r["email"]),
        text(r["rfidNumber"]), text(r["trackrNumber"]), text(r["trackrChoice"]), r["rfidPurchased"] ? 1 : 0,
      ).changes;
    }
    return changed;
  }

  /**
   * Split reads (course sector times) for motos and practices. A split is
   * identified as in the cloud, by its moto (or practice session), tag, split
   * and lap, not by id: the desktop numbers its own rows. One recorded here and
   * not yet pushed keeps the desktop's version. The cloud's rider id becomes
   * the desktop's own id for that rider where the two differ. Tables or
   * columns an older local database lacks are skipped.
   */
  private upsertPulledSplits(
    table: "split_crossings" | "practice_split_crossings",
    parentCol: "moto_id" | "session_id",
    rows: Record<string, unknown>[],
  ): number {
    const known = this.localColumns(table);
    if (!known.has(parentCol) || rows.length === 0) return 0;
    const toSnake = (k: string) => k.replace(/([A-Z])/g, "_$1").toLowerCase();
    const keyCols = [parentCol, "rfid_number", "split_sequence", "lap_number"];
    const dataCols = ["event_id", "assignment_id", "reader_id", "label", "rider_id", "crossing_time"].filter((c) => known.has(c));
    const cols = [...keyCols, ...dataCols];
    const pending = this.pendingIds(table);
    const find = this.db.prepare(
      `SELECT id FROM ${table} WHERE ${keyCols.map((c) => `${c} = ?`).join(" AND ")}`,
    );
    const upsert = this.db.prepare(
      `INSERT INTO ${table} (${cols.join(", ")})
       VALUES (${cols.map(() => "?").join(", ")})
       ON CONFLICT(${keyCols.join(", ")}) DO UPDATE SET
         ${dataCols.map((c) => `${c} = excluded.${c}`).join(", ")}
       WHERE ${dataCols.map((c) => `${table}.${c} IS NOT excluded.${c}`).join(" OR ")}`,
    );
    const localRiderFor = this.db.prepare(
      "SELECT local_rider_id FROM _rider_cloud_map WHERE cloud_rider_id = ? ORDER BY local_rider_id LIMIT 1",
    );
    let changed = 0;
    for (const r of rows) {
      const row: Record<string, string | number | null> = {};
      for (const [k, v] of Object.entries(r)) {
        row[toSnake(k)] = v == null ? null : typeof v === "number" ? v : String(v);
      }
      if (row.rider_id != null) {
        const mapped = localRiderFor.get(Number(row.rider_id)) as { local_rider_id: number } | undefined;
        if (mapped) row.rider_id = mapped.local_rider_id;
      }
      const key = [Number(row[parentCol]), row.rfid_number == null ? "" : String(row.rfid_number), Number(row.split_sequence), Number(row.lap_number)];
      if (!key[0] || !key[1] || !key[2] || !Number.isFinite(key[3] as number) || row.crossing_time == null) continue;
      const local = find.get(...key) as { id: number } | undefined;
      if (local && pending.has(local.id)) { this.pullSkippedPending++; continue; }
      changed += upsert.run(...key, ...dataCols.map((c) => row[c] ?? null)).changes;
    }
    return changed;
  }

  /**
   * Paid check-in add-ons. A payment taken on this desktop comes back from the
   * cloud with its desktop ref ("<club id>:<uid>") and is matched to the local
   * row instead of being added twice.
   */
  private upsertPulledAddonPayments(rows: Record<string, unknown>[]): number {
    const byUid = this.db.prepare("SELECT id, cloud_id FROM addon_payments WHERE uid = ?");
    const link = this.db.prepare("UPDATE addon_payments SET cloud_id = ? WHERE id = ?");
    const upsert = this.db.prepare(
      `INSERT INTO addon_payments (uid, cloud_id, event_id, registration_id, item, amount, quantity, method, status,
                                   cash_tendered, cash_change, created_at, paid_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(cloud_id) DO UPDATE SET
         event_id = excluded.event_id, registration_id = excluded.registration_id, item = excluded.item,
         amount = excluded.amount, quantity = excluded.quantity, method = excluded.method, status = excluded.status,
         cash_tendered = excluded.cash_tendered, cash_change = excluded.cash_change, paid_at = excluded.paid_at
       WHERE addon_payments.registration_id != excluded.registration_id OR addon_payments.item != excluded.item
          OR addon_payments.amount != excluded.amount OR addon_payments.quantity != excluded.quantity
          OR addon_payments.method != excluded.method OR addon_payments.status != excluded.status`,
    );
    const num = (v: unknown) => (v == null || v === "" ? null : Number(v));
    const prefix = `${this.clubId}:`;
    const seen = new Set<number>();
    let changed = 0;
    for (const r of rows) {
      const cloudId = Number(r["id"]);
      if (!cloudId) continue;
      seen.add(cloudId);
      const ref = typeof r["desktopRef"] === "string" ? (r["desktopRef"] as string) : "";
      const uid = ref.startsWith(prefix) ? ref.slice(prefix.length) : `cloud:${cloudId}`;
      const mine = byUid.get(uid) as { id: number; cloud_id: number | null } | undefined;
      if (mine) {
        if (mine.cloud_id !== cloudId) changed += link.run(cloudId, mine.id).changes;
        continue;
      }
      changed += upsert.run(
        uid, cloudId, Number(r["eventId"]), Number(r["registrationId"]), String(r["item"]),
        Number(r["amount"]) || 0, Math.max(1, Number(r["quantity"]) || 1), String(r["method"]), String(r["status"]),
        num(r["cashTendered"]), num(r["cashChange"]),
        r["createdAt"] == null ? new Date().toISOString() : String(r["createdAt"]),
        r["paidAt"] == null ? null : String(r["paidAt"]),
      ).changes;
    }
    // Payments the cloud no longer has (removed there): drop the mirrored copy.
    const mirrored = this.db.prepare("SELECT id, cloud_id FROM addon_payments WHERE cloud_id IS NOT NULL").all() as Array<{ id: number; cloud_id: number }>;
    const remove = this.db.prepare("DELETE FROM addon_payments WHERE id = ?");
    for (const m of mirrored) if (!seen.has(m.cloud_id)) changed += remove.run(m.id).changes;
    return changed;
  }

  private upsertPulled(
    table: string,
    rows: Record<string, unknown>[],
  ): number {
    if (!rows.length) return 0;

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
    // Snapshot tables are queued per event: skip every row of a pending event.
    const pendingSetupEvents = SyncEngine.ENDURO_SETUP_TABLES.includes(table)
      ? new Set(
          (this.db
            .prepare(
              `SELECT record_id FROM _write_queue
               WHERE table_name = ? AND synced_at IS NULL AND attempt_count < ?`,
            )
            .all(SyncEngine.ENDURO_SETUP_QUEUE, MAX_ATTEMPTS) as Array<{ record_id: number }>).map((r) => r.record_id),
        )
      : null;
    if (table === "riders") {
      for (const row of this.db
        .prepare("SELECT DISTINCT rider_id FROM _rider_profile_dirty")
        .all() as Array<{ rider_id: number }>) {
        pendingIds.add(row.rider_id);
      }
    }

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

    let changed = 0;

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
      if (
        pendingIds.has(snakeRow.id as number) ||
        (pendingSetupEvents && pendingSetupEvents.has(Number(snakeRow.event_id)))
      ) {
        this.pullSkippedPending++;
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
      const result = this.db
        .prepare(
          `INSERT INTO ${table} (${cols.join(", ")})
           VALUES (${placeholders})
           ON CONFLICT(id) DO UPDATE SET ${assignments}`,
        )
        .run(...vals);
      if (table === "riders" && snakeRow.id != null) {
        this.db.prepare(`
          INSERT INTO _rider_cloud_map (local_rider_id, cloud_rider_id, client_identity)
          VALUES (?, ?, lower(hex(randomblob(16))))
          ON CONFLICT(local_rider_id) DO UPDATE SET
            cloud_rider_id = COALESCE(_rider_cloud_map.cloud_rider_id, excluded.cloud_rider_id),
            updated_at = datetime('now')
        `).run(Number(snakeRow.id), Number(snakeRow.id));
      }
      changed += result.changes;
    }

    return changed;
  }

  destroy(): void {
    this.stop();
    this.db.close();
  }
}
