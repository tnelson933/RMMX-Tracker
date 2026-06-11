import { getDb } from "./db";

// ─── Config ───────────────────────────────────────────────────────────────────

export const CLOUD_URL   = (process.env.CLOUD_URL    ?? "").replace(/\/$/, "");
export const CLUB_ID     = process.env.CLUB_ID       ?? "";
export const SYNC_TOKEN  = process.env.SYNC_TOKEN    ?? "";
export const EMAIL       = process.env.CLOUD_EMAIL   ?? "";
export const PASSWORD    = process.env.CLOUD_PASSWORD ?? "";

export const AUTO_SYNC_ENABLED = !!(CLOUD_URL && CLUB_ID && (SYNC_TOKEN || (EMAIL && PASSWORD)));

const POLL_INTERVAL_MS = 2 * 60 * 1000;

// ─── Types ────────────────────────────────────────────────────────────────────

export type SyncState = {
  lastAttemptAt: string | null;
  lastSuccessAt: string | null;
  lastError:     string | null;
  rowsSynced:    Record<string, number>;
};

type WatermarkRow = { table_name: string; max_imported_id: number };

// ─── State helpers ────────────────────────────────────────────────────────────

function readSyncState(): SyncState {
  const db  = getDb();
  const row = db.prepare("SELECT * FROM _sync_state WHERE id = 1").get() as {
    last_attempt_at: string | null;
    last_success_at: string | null;
    last_error:      string | null;
    rows_synced:     string;
  } | undefined;

  if (!row) return { lastAttemptAt: null, lastSuccessAt: null, lastError: null, rowsSynced: {} };

  let rowsSynced: Record<string, number> = {};
  try { rowsSynced = JSON.parse(row.rows_synced); } catch { /* ignore */ }

  return {
    lastAttemptAt: row.last_attempt_at,
    lastSuccessAt: row.last_success_at,
    lastError:     row.last_error,
    rowsSynced,
  };
}

function writeSyncAttempt() {
  const db  = getDb();
  const now = new Date().toISOString();
  db.prepare(
    "UPDATE _sync_state SET last_attempt_at = ? WHERE id = 1",
  ).run(now);
}

function writeSyncSuccess(rowsSynced: Record<string, number>) {
  const db  = getDb();
  const now = new Date().toISOString();
  db.prepare(
    "UPDATE _sync_state SET last_success_at = ?, last_error = NULL, rows_synced = ? WHERE id = 1",
  ).run(now, JSON.stringify(rowsSynced));
}

function writeSyncError(err: string) {
  const db = getDb();
  db.prepare(
    "UPDATE _sync_state SET last_error = ? WHERE id = 1",
  ).run(err);
}

export { readSyncState };

// ─── Helpers ──────────────────────────────────────────────────────────────────

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

// ─── Connectivity probe ───────────────────────────────────────────────────────

async function isCloudReachable(): Promise<boolean> {
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 8_000);
    const res = await fetch(`${CLOUD_URL}/api/healthz`, { signal: ctrl.signal });
    clearTimeout(timer);
    return res.ok;
  } catch {
    return false;
  }
}

// ─── Completed-event gate ─────────────────────────────────────────────────────

function hasActiveOrCompletedEvent(): boolean {
  const db  = getDb();
  const row = db
    .prepare("SELECT COUNT(*) as cnt FROM events WHERE status IN ('race_day', 'completed')")
    .get() as { cnt: number };
  return row.cnt > 0;
}

// ─── Core sync logic (shared with CLI sync.ts) ───────────────────────────────

type SyncResult = {
  ok: boolean;
  syncedAt: string;
  results: {
    checkinsUpdated:       number;
    checkinsInserted:      number;
    rfidUpserted:          number;
    registrationsUpdated:  number;
    registrationsInserted: number;
    ridersUpdated:         number;
    skipped:               number;
  };
};

export async function runSync(): Promise<SyncResult> {
  const db = getDb();

  const watermarkRows = db
    .prepare("SELECT table_name, max_imported_id FROM _sync_watermarks")
    .all() as WatermarkRow[];

  const watermarks: Record<string, number> = {};
  for (const w of watermarkRows) watermarks[w.table_name] = w.max_imported_id;

  const checkins        = normalizeRows(db.prepare("SELECT * FROM checkins").all()         as Record<string, unknown>[]);
  const rfidAssignments = normalizeRows(db.prepare("SELECT * FROM rfid_assignments").all() as Record<string, unknown>[]);
  const registrations   = normalizeRows(db.prepare("SELECT * FROM registrations").all()   as Record<string, unknown>[]);
  const riders          = normalizeRows(db.prepare("SELECT * FROM riders").all()           as Record<string, unknown>[]);

  let authHeader: Record<string, string>;

  if (SYNC_TOKEN) {
    authHeader = { Authorization: `Bearer ${SYNC_TOKEN}` };
  } else {
    const loginRes = await fetch(`${CLOUD_URL}/api/auth/login`, {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify({ email: EMAIL, password: PASSWORD }),
    });

    if (!loginRes.ok) {
      const body = await loginRes.text();
      throw new Error(`Login failed (${loginRes.status}): ${body}`);
    }

    const rawSetCookie = loginRes.headers.get("set-cookie") ?? "";
    const cookieValue = rawSetCookie
      .split(",")
      .map((c) => c.trim().split(";")[0].trim())
      .filter(Boolean)
      .join("; ");

    if (!cookieValue) throw new Error("Login succeeded but no session cookie received");
    authHeader = { Cookie: cookieValue };
  }

  const syncRes = await fetch(`${CLOUD_URL}/api/clubs/${CLUB_ID}/sync`, {
    method:  "POST",
    headers: { "Content-Type": "application/json", ...authHeader },
    body:    JSON.stringify({ watermarks, checkins, rfidAssignments, registrations, riders }),
  });

  if (!syncRes.ok) {
    const body = await syncRes.text();
    throw new Error(`Sync failed (${syncRes.status}): ${body}`);
  }

  return syncRes.json() as Promise<SyncResult>;
}

// ─── Auto-sync loop ───────────────────────────────────────────────────────────

async function syncOnce() {
  writeSyncAttempt();

  const reachable = await isCloudReachable();
  if (!reachable) {
    writeSyncError("Cloud not reachable");
    console.log("[auto-sync] Cloud not reachable — will retry in 2 min");
    return;
  }

  if (!hasActiveOrCompletedEvent()) {
    console.log("[auto-sync] No active or completed events — skipping sync");
    getDb()
      .prepare("UPDATE _sync_state SET last_error = NULL WHERE id = 1")
      .run();
    return;
  }

  console.log("[auto-sync] Cloud reachable and completed event found — syncing…");
  try {
    const result = await runSync();
    const r = result.results;
    const rowsSynced = {
      checkinsUpdated:       r.checkinsUpdated,
      checkinsInserted:      r.checkinsInserted,
      rfidUpserted:          r.rfidUpserted,
      registrationsUpdated:  r.registrationsUpdated,
      registrationsInserted: r.registrationsInserted,
      ridersUpdated:         r.ridersUpdated,
      skipped:               r.skipped,
    };
    writeSyncSuccess(rowsSynced);
    console.log(`[auto-sync] ✓ Sync complete (${result.syncedAt})`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    writeSyncError(msg);
    console.error(`[auto-sync] ✗ Sync error: ${msg}`);
  }
}

export function startAutoSync() {
  if (!AUTO_SYNC_ENABLED) return;

  void syncOnce();
  setInterval(() => { void syncOnce(); }, POLL_INTERVAL_MS);
}
