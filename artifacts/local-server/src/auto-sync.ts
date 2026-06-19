import { getDb } from "./db";
import fs from "fs/promises";
import path from "path";

const UPLOADS_DIR = path.join(process.cwd(), ".uploads");

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

// Convert a value to something SQLite can store
function toSQLiteScalar(v: unknown): string | number | null {
  if (v === null || v === undefined) return null;
  if (typeof v === "boolean") return v ? 1 : 0;
  if (v instanceof Date) return v.toISOString();
  if (Array.isArray(v) || (typeof v === "object")) return JSON.stringify(v);
  return v as string | number;
}

function toDateStr(v: unknown): string | null {
  if (!v) return null;
  if (v instanceof Date) return v.toISOString();
  return String(v);
}

function toJsonStr(v: unknown, fallback = "{}"): string {
  if (v === null || v === undefined) return fallback;
  if (typeof v === "string") return v;
  return JSON.stringify(v);
}

// ─── Auth ─────────────────────────────────────────────────────────────────────

async function getAuthHeader(): Promise<Record<string, string>> {
  if (SYNC_TOKEN) {
    return { Authorization: `Bearer ${SYNC_TOKEN}` };
  }

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
  return { Cookie: cookieValue };
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

// ─── Event gate ───────────────────────────────────────────────────────────────
// Allow sync once registration opens so cloud-registered riders appear on
// the desktop before race day begins.

function hasActiveOrCompletedEvent(): boolean {
  const db  = getDb();
  const row = db
    .prepare("SELECT COUNT(*) as cnt FROM events WHERE status IN ('registration_open', 'race_day', 'completed')")
    .get() as { cnt: number };
  return row.cnt > 0;
}

// ─── Push sync (local → cloud) ───────────────────────────────────────────────

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

  const authHeader = await getAuthHeader();

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

// ─── Pull sync (cloud → local) ───────────────────────────────────────────────
// Calls the cloud sync-pull endpoint and upserts the returned rows into local
// SQLite.  All writes are wrapped in _cloud_pull_guard so the write-queue
// triggers are suppressed — pulled cloud rows must never be re-pushed.

type PullRegistration = {
  id: number; eventId: number; riderId: number; raceClass: string;
  status?: string | null; paymentStatus?: string | null; paymentMethod?: string | null;
  amountPaid?: string | null; bibNumber?: string | null; amaNumber?: string | null;
  clubIdNumber?: string | null; bikeBrand?: string | null; bikeModel?: string | null;
  bikeYear?: string | null; sponsors?: string | null;
  statsEmailOptIn?: boolean | number | null; transponderRental?: boolean | number | null;
  myLapsTransponderNumber?: string | null;
  selectedPurchaseOptions?: string | unknown[] | null;
  compCode?: string | null; compDiscount?: string | null;
  displayFirstName?: string | null; displayLastName?: string | null;
  createdAt?: string | Date | null;
};

type PullRider = {
  id: number; firstName?: string | null; lastName?: string | null; rfidNumber?: string | null;
};

type PullEvent = Record<string, unknown>;
type PullMoto  = Record<string, unknown>;
type PullCheckin = Record<string, unknown>;
type PullRfid  = Record<string, unknown>;

type PullRiderAccount = { id: number; email: string };
type PullRiderPushToken = { id: number; riderAccountId: number; expoPushToken: string };

type PullResponse = {
  registrations?: PullRegistration[];
  riders?:        PullRider[];
  events?:        PullEvent[];
  motos?:         PullMoto[];
  checkins?:      PullCheckin[];
  rfidAssignments?: PullRfid[];
  riderAccounts?: PullRiderAccount[];
  riderPushTokens?: PullRiderPushToken[];
  clubs?:         Record<string, unknown>[];
};

export async function runPull(): Promise<{ ok: boolean; rows: Record<string, number> }> {
  const db = getDb();
  const authHeader = await getAuthHeader();

  const pullRes = await fetch(`${CLOUD_URL}/api/clubs/${CLUB_ID}/sync-pull`, {
    method:  "POST",
    headers: { "Content-Type": "application/json", ...authHeader },
    body:    JSON.stringify({}),
  });

  if (!pullRes.ok) {
    const body = await pullRes.text();
    throw new Error(`Pull failed (${pullRes.status}): ${body}`);
  }

  const data = await pullRes.json() as PullResponse;

  const rows: Record<string, number> = {
    registrationsPulled: 0,
    ridersPulled:        0,
    eventsPulled:        0,
    motosPulled:         0,
    checkinsPulled:      0,
    rfidPulled:          0,
  };

  // Suppress write-queue triggers so pulled cloud rows are not re-queued
  db.prepare("INSERT OR REPLACE INTO _cloud_pull_guard (active) VALUES (1)").run();

  try {
    // ── Registrations ──────────────────────────────────────────────────────────
    const regStmt = db.prepare(`
      INSERT INTO registrations (
        id, event_id, rider_id, race_class, status, payment_status,
        payment_method, amount_paid, bib_number, ama_number, club_id_number,
        bike_brand, bike_model, bike_year, sponsors, stats_email_opt_in,
        transponder_rental, mylaps_transponder_number, selected_purchase_options,
        comp_code, comp_discount, display_first_name, display_last_name, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        status                    = excluded.status,
        payment_status            = excluded.payment_status,
        payment_method            = excluded.payment_method,
        amount_paid               = excluded.amount_paid,
        bib_number                = excluded.bib_number,
        ama_number                = excluded.ama_number,
        club_id_number            = excluded.club_id_number,
        bike_brand                = excluded.bike_brand,
        bike_model                = excluded.bike_model,
        bike_year                 = excluded.bike_year,
        sponsors                  = excluded.sponsors,
        stats_email_opt_in        = excluded.stats_email_opt_in,
        transponder_rental        = excluded.transponder_rental,
        mylaps_transponder_number = excluded.mylaps_transponder_number,
        selected_purchase_options = excluded.selected_purchase_options,
        comp_code                 = excluded.comp_code,
        comp_discount             = excluded.comp_discount,
        display_first_name        = excluded.display_first_name,
        display_last_name         = excluded.display_last_name
    `);

    for (const reg of data.registrations ?? []) {
      const spo = reg.selectedPurchaseOptions;
      regStmt.run(
        reg.id, reg.eventId, reg.riderId, reg.raceClass,
        reg.status ?? "confirmed", reg.paymentStatus ?? "unpaid",
        reg.paymentMethod ?? null, reg.amountPaid ?? null,
        reg.bibNumber ?? null, reg.amaNumber ?? null, reg.clubIdNumber ?? null,
        reg.bikeBrand ?? null, reg.bikeModel ?? null, reg.bikeYear ?? null,
        reg.sponsors ?? null,
        reg.statsEmailOptIn ? 1 : 0,
        reg.transponderRental ? 1 : 0,
        reg.myLapsTransponderNumber ?? null,
        Array.isArray(spo) ? JSON.stringify(spo) : (spo ?? "[]"),
        reg.compCode ?? null, reg.compDiscount ?? null,
        reg.displayFirstName ?? null, reg.displayLastName ?? null,
        toDateStr(reg.createdAt) ?? new Date().toISOString(),
      );
      rows.registrationsPulled++;
    }

    // ── Riders (minimal: id, first_name, last_name, rfid_number) ──────────────
    // The sync-pull endpoint only returns id/name/rfid for privacy reasons; the
    // email field is required NOT NULL so we store '' for new cloud-only riders.
    const riderStmt = db.prepare(`
      INSERT INTO riders (id, email, first_name, last_name, rfid_number)
      VALUES (?, '', ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        first_name  = excluded.first_name,
        last_name   = excluded.last_name,
        rfid_number = excluded.rfid_number
    `);

    for (const rider of data.riders ?? []) {
      riderStmt.run(
        rider.id, rider.firstName ?? "", rider.lastName ?? "", rider.rfidNumber ?? null,
      );
      rows.ridersPulled++;
    }

    // ── Events ─────────────────────────────────────────────────────────────────
    const eventStmt = db.prepare(`
      INSERT INTO events (
        id, club_id, name, date, end_date, state, status, location, description,
        track_name, race_classes, registration_open, registration_close,
        payment_enabled, require_ama, entry_fee, max_riders,
        race_class_limits, purchase_options, image_url, timing_technology,
        transponder_rental_enabled, transponder_rental_fee,
        no_duplicate_bibs, require_club_id, scoring_table_id,
        entry_fee_category_id, min_lap_ms, ama_event_id, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        name                       = excluded.name,
        date                       = excluded.date,
        end_date                   = excluded.end_date,
        state                      = excluded.state,
        status                     = excluded.status,
        location                   = excluded.location,
        description                = excluded.description,
        track_name                 = excluded.track_name,
        race_classes               = excluded.race_classes,
        registration_open          = excluded.registration_open,
        registration_close         = excluded.registration_close,
        payment_enabled            = excluded.payment_enabled,
        require_ama                = excluded.require_ama,
        entry_fee                  = excluded.entry_fee,
        max_riders                 = excluded.max_riders,
        race_class_limits          = excluded.race_class_limits,
        purchase_options           = excluded.purchase_options,
        image_url                  = excluded.image_url,
        timing_technology          = excluded.timing_technology,
        transponder_rental_enabled = excluded.transponder_rental_enabled,
        transponder_rental_fee     = excluded.transponder_rental_fee,
        no_duplicate_bibs          = excluded.no_duplicate_bibs,
        require_club_id            = excluded.require_club_id,
        scoring_table_id           = excluded.scoring_table_id,
        entry_fee_category_id      = excluded.entry_fee_category_id,
        min_lap_ms                 = excluded.min_lap_ms,
        ama_event_id               = excluded.ama_event_id
    `);

    for (const ev of data.events ?? []) {
      eventStmt.run(
        toSQLiteScalar(ev.id), toSQLiteScalar(ev.clubId),
        toSQLiteScalar(ev.name), toDateStr(ev.date),
        toSQLiteScalar((ev as any).endDate) ?? null,
        toSQLiteScalar(ev.state) ?? "", toSQLiteScalar(ev.status) ?? "draft",
        toSQLiteScalar(ev.location) ?? null, toSQLiteScalar(ev.description) ?? null,
        toSQLiteScalar(ev.trackName) ?? null,
        toJsonStr(ev.raceClasses, "[]"),
        toDateStr(ev.registrationOpen), toDateStr(ev.registrationClose),
        ev.paymentEnabled ? 1 : 0, ev.requireAma ? 1 : 0,
        toSQLiteScalar(ev.entryFee) ?? null, toSQLiteScalar(ev.maxRiders) ?? null,
        toJsonStr(ev.raceClassLimits), toJsonStr(ev.purchaseOptions, "[]"),
        toSQLiteScalar(ev.imageUrl) ?? null,
        toSQLiteScalar(ev.timingTechnology) ?? "rfid",
        ev.transponderRentalEnabled ? 1 : 0,
        toSQLiteScalar(ev.transponderRentalFee) ?? null,
        ev.noDuplicateBibs ? 1 : 0, ev.requireClubId ? 1 : 0,
        toSQLiteScalar(ev.scoringTableId) ?? null,
        toSQLiteScalar(ev.entryFeeCategoryId) ?? null,
        toSQLiteScalar(ev.minLapMs) ?? null,
        toSQLiteScalar(ev.amaEventId) ?? null,
        toDateStr(ev.createdAt) ?? new Date().toISOString(),
      );
      rows.eventsPulled++;
    }

    // ── Motos ──────────────────────────────────────────────────────────────────
    const motoStmt = db.prepare(`
      INSERT INTO motos (
        id, event_id, name, type, status, race_class, race_classes,
        scheduled_time, lap_count, time_limit_ms, practice_mode,
        countdown_seconds, staggered_group_id, staggered_order, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        name                   = excluded.name,
        type                   = excluded.type,
        status                 = excluded.status,
        race_class             = excluded.race_class,
        race_classes           = excluded.race_classes,
        scheduled_time         = excluded.scheduled_time,
        lap_count              = excluded.lap_count,
        time_limit_ms          = excluded.time_limit_ms,
        practice_mode          = excluded.practice_mode,
        countdown_seconds      = excluded.countdown_seconds,
        staggered_group_id     = excluded.staggered_group_id,
        staggered_order        = excluded.staggered_order
    `);

    for (const m of data.motos ?? []) {
      motoStmt.run(
        toSQLiteScalar(m.id), toSQLiteScalar(m.eventId),
        toSQLiteScalar(m.name) ?? "", toSQLiteScalar(m.type) ?? "moto",
        toSQLiteScalar(m.status) ?? "pending",
        toSQLiteScalar(m.raceClass) ?? null, toJsonStr(m.raceClasses, "[]"),
        toDateStr(m.scheduledTime), toSQLiteScalar(m.lapCount) ?? null,
        toSQLiteScalar(m.timeLimitMs) ?? null,
        toSQLiteScalar(m.practiceMode) ?? null,
        toSQLiteScalar(m.countdownSeconds) ?? null,
        toSQLiteScalar(m.staggeredGroupId) ?? null,
        toSQLiteScalar(m.staggeredOrder) ?? null,
        toDateStr(m.createdAt) ?? new Date().toISOString(),
      );
      rows.motosPulled++;
    }

    // ── Checkins ───────────────────────────────────────────────────────────────
    const checkinStmt = db.prepare(`
      INSERT INTO checkins (
        id, event_id, rider_id, race_class, bib_number, checked_in,
        checked_in_at, rfid_number, rfid_linked, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        bib_number    = excluded.bib_number,
        checked_in    = excluded.checked_in,
        checked_in_at = excluded.checked_in_at,
        rfid_number   = excluded.rfid_number,
        rfid_linked   = excluded.rfid_linked
    `);

    for (const c of data.checkins ?? []) {
      checkinStmt.run(
        toSQLiteScalar(c.id), toSQLiteScalar(c.eventId), toSQLiteScalar(c.riderId),
        toSQLiteScalar(c.raceClass) ?? "",
        toSQLiteScalar(c.bibNumber) ?? null,
        c.checkedIn ? 1 : 0,
        toDateStr(c.checkedInAt),
        toSQLiteScalar(c.rfidNumber) ?? null,
        c.rfidLinked ? 1 : 0,
        toDateStr(c.createdAt) ?? new Date().toISOString(),
      );
      rows.checkinsPulled++;
    }

    // ── RFID Assignments ───────────────────────────────────────────────────────
    const rfidStmt = db.prepare(`
      INSERT INTO rfid_assignments (id, rider_id, event_id, rfid_number, assigned_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        rfid_number = excluded.rfid_number,
        assigned_at = excluded.assigned_at
    `);

    for (const r of data.rfidAssignments ?? []) {
      rfidStmt.run(
        toSQLiteScalar(r.id), toSQLiteScalar(r.riderId),
        toSQLiteScalar(r.eventId) ?? null,
        toSQLiteScalar(r.rfidNumber) ?? null,
        toDateStr(r.assignedAt) ?? new Date().toISOString(),
      );
      rows.rfidPulled++;
    }

    // ── Rider Accounts (email-only — needed for push token resolution) ─────────
    const riderAccountStmt = db.prepare(`
      INSERT INTO rider_accounts (id, email)
      VALUES (?, ?)
      ON CONFLICT(id) DO UPDATE SET email = excluded.email
    `);

    let riderAccountsPulled = 0;
    for (const a of data.riderAccounts ?? []) {
      riderAccountStmt.run(a.id, a.email);
      riderAccountsPulled++;
    }
    rows.riderAccountsPulled = riderAccountsPulled;

    // ── Rider Push Tokens ──────────────────────────────────────────────────────
    const pushTokenStmt = db.prepare(`
      INSERT INTO rider_push_tokens (id, rider_account_id, expo_push_token)
      VALUES (?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        rider_account_id = excluded.rider_account_id,
        expo_push_token  = excluded.expo_push_token
    `);

    let pushTokensPulled = 0;
    for (const t of data.riderPushTokens ?? []) {
      pushTokenStmt.run(t.id, t.riderAccountId, t.expoPushToken);
      pushTokensPulled++;
    }
    rows.pushTokensPulled = pushTokensPulled;

    // ── Clubs (stripe status + config) ────────────────────────────────────────
    const clubStmt = db.prepare(`
      INSERT INTO clubs (
        id, name, state, contact_email, contact_phone, logo_url,
        website, description, auto_dnf_enabled, auto_dnf_threshold,
        stripe_account_id, stripe_onboarding_complete
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        name                       = excluded.name,
        state                      = excluded.state,
        contact_email              = excluded.contact_email,
        contact_phone              = excluded.contact_phone,
        website                    = excluded.website,
        description                = excluded.description,
        auto_dnf_enabled           = excluded.auto_dnf_enabled,
        auto_dnf_threshold         = excluded.auto_dnf_threshold,
        stripe_account_id          = excluded.stripe_account_id,
        stripe_onboarding_complete = excluded.stripe_onboarding_complete
    `);
    let clubsPulled = 0;
    for (const club of data.clubs ?? []) {
      clubStmt.run(
        toSQLiteScalar(club.id),
        toSQLiteScalar(club.name) ?? "",
        toSQLiteScalar(club.state) ?? "",
        toSQLiteScalar(club.contactEmail) ?? null,
        toSQLiteScalar(club.contactPhone) ?? null,
        toSQLiteScalar(club.logoUrl) ?? null,
        toSQLiteScalar(club.website) ?? null,
        toSQLiteScalar(club.description) ?? null,
        club.autoDnfEnabled ? 1 : 0,
        toSQLiteScalar(club.autoDnfThreshold) ?? 75,
        toSQLiteScalar(club.stripeAccountId) ?? null,
        club.stripeOnboardingComplete ? 1 : 0,
      );
      clubsPulled++;
    }
    rows.clubsPulled = clubsPulled;

  } finally {
    db.prepare("DELETE FROM _cloud_pull_guard WHERE active = 1").run();
  }

  return { ok: true, rows };
}

// ─── Image sync (local uploads → cloud object storage) ───────────────────────

const LOCAL_UPLOAD_PREFIX = "/api/storage/uploads/";
const IMAGE_SYNC_MAX_ATTEMPTS = 5;

async function runImageSync(): Promise<{ imagesUploaded: number }> {
  const db = getDb();
  const authHeader = await getAuthHeader();
  let imagesUploaded = 0;

  // Events with locally-stored image_url that haven't hit the retry cap
  const events = db
    .prepare(`SELECT id, image_url, image_sync_attempts FROM events WHERE image_url LIKE '${LOCAL_UPLOAD_PREFIX}%' AND image_sync_attempts < ${IMAGE_SYNC_MAX_ATTEMPTS}`)
    .all() as { id: number; image_url: string; image_sync_attempts: number }[];

  // Clubs with locally-stored logo_url that haven't hit the retry cap
  const clubs = db
    .prepare(`SELECT id, logo_url, image_sync_attempts FROM clubs WHERE logo_url LIKE '${LOCAL_UPLOAD_PREFIX}%' AND image_sync_attempts < ${IMAGE_SYNC_MAX_ATTEMPTS}`)
    .all() as { id: number; logo_url: string; image_sync_attempts: number }[];

  for (const ev of events) {
    const filename = ev.image_url.slice(LOCAL_UPLOAD_PREFIX.length);
    const filepath = path.join(UPLOADS_DIR, filename);
    try {
      const buffer = await fs.readFile(filepath);
      const ext = path.extname(filename) || ".png";
      const contentType = ext === ".png" ? "image/png" : ext === ".jpg" || ext === ".jpeg" ? "image/jpeg" : "image/png";

      const uploadRes = await fetch(`${CLOUD_URL}/api/storage/uploads/file`, {
        method: "POST",
        headers: {
          "Content-Type": contentType,
          "x-file-name": filename,
          "x-content-type": contentType,
          ...authHeader,
        },
        body: buffer,
      });
      if (!uploadRes.ok) {
        const nextAttempts = ev.image_sync_attempts + 1;
        db.prepare("UPDATE events SET image_sync_attempts = ? WHERE id = ?").run(nextAttempts, ev.id);
        if (nextAttempts >= IMAGE_SYNC_MAX_ATTEMPTS) {
          console.warn(`[image-sync] Event ${ev.id} image upload failed ${nextAttempts} times — giving up (${uploadRes.status})`);
        } else {
          console.warn(`[image-sync] Failed to upload event ${ev.id} image (${uploadRes.status}); attempt ${nextAttempts}/${IMAGE_SYNC_MAX_ATTEMPTS}`);
        }
        continue;
      }
      const { objectPath } = await uploadRes.json() as { objectPath: string };
      const newImageUrl = `/api/storage${objectPath}`;

      const patchRes = await fetch(`${CLOUD_URL}/api/events/${ev.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", ...authHeader },
        body: JSON.stringify({ imageUrl: newImageUrl }),
      });
      if (!patchRes.ok) {
        const nextAttempts = ev.image_sync_attempts + 1;
        db.prepare("UPDATE events SET image_sync_attempts = ? WHERE id = ?").run(nextAttempts, ev.id);
        if (nextAttempts >= IMAGE_SYNC_MAX_ATTEMPTS) {
          console.warn(`[image-sync] Event ${ev.id} imageUrl cloud patch failed ${nextAttempts} times — giving up (${patchRes.status})`);
        } else {
          console.warn(`[image-sync] Failed to update event ${ev.id} imageUrl on cloud (${patchRes.status}); attempt ${nextAttempts}/${IMAGE_SYNC_MAX_ATTEMPTS}`);
        }
        continue;
      }

      db.prepare("UPDATE events SET image_url = ?, image_sync_attempts = 0 WHERE id = ?").run(newImageUrl, ev.id);
      console.log(`[image-sync] ✓ Event ${ev.id} image synced → ${newImageUrl}`);
      imagesUploaded++;
    } catch (err) {
      const nextAttempts = ev.image_sync_attempts + 1;
      db.prepare("UPDATE events SET image_sync_attempts = ? WHERE id = ?").run(nextAttempts, ev.id);
      if (nextAttempts >= IMAGE_SYNC_MAX_ATTEMPTS) {
        console.warn(`[image-sync] Event ${ev.id} image sync failed ${nextAttempts} times — giving up: ${err instanceof Error ? err.message : String(err)}`);
      } else {
        console.warn(`[image-sync] Event ${ev.id} image error (attempt ${nextAttempts}/${IMAGE_SYNC_MAX_ATTEMPTS}): ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  for (const club of clubs) {
    const filename = club.logo_url.slice(LOCAL_UPLOAD_PREFIX.length);
    const filepath = path.join(UPLOADS_DIR, filename);
    try {
      const buffer = await fs.readFile(filepath);
      const ext = path.extname(filename) || ".png";
      const contentType = ext === ".png" ? "image/png" : ext === ".jpg" || ext === ".jpeg" ? "image/jpeg" : "image/png";

      const uploadRes = await fetch(`${CLOUD_URL}/api/storage/uploads/file`, {
        method: "POST",
        headers: {
          "Content-Type": contentType,
          "x-file-name": filename,
          "x-content-type": contentType,
          ...authHeader,
        },
        body: buffer,
      });
      if (!uploadRes.ok) {
        const nextAttempts = club.image_sync_attempts + 1;
        db.prepare("UPDATE clubs SET image_sync_attempts = ? WHERE id = ?").run(nextAttempts, club.id);
        if (nextAttempts >= IMAGE_SYNC_MAX_ATTEMPTS) {
          console.warn(`[image-sync] Club ${club.id} logo upload failed ${nextAttempts} times — giving up (${uploadRes.status})`);
        } else {
          console.warn(`[image-sync] Failed to upload club ${club.id} logo (${uploadRes.status}); attempt ${nextAttempts}/${IMAGE_SYNC_MAX_ATTEMPTS}`);
        }
        continue;
      }
      const { objectPath } = await uploadRes.json() as { objectPath: string };
      const newLogoUrl = `/api/storage${objectPath}`;

      const patchRes = await fetch(`${CLOUD_URL}/api/clubs/${club.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", ...authHeader },
        body: JSON.stringify({ logoUrl: newLogoUrl }),
      });
      if (!patchRes.ok) {
        const nextAttempts = club.image_sync_attempts + 1;
        db.prepare("UPDATE clubs SET image_sync_attempts = ? WHERE id = ?").run(nextAttempts, club.id);
        if (nextAttempts >= IMAGE_SYNC_MAX_ATTEMPTS) {
          console.warn(`[image-sync] Club ${club.id} logoUrl cloud patch failed ${nextAttempts} times — giving up (${patchRes.status})`);
        } else {
          console.warn(`[image-sync] Failed to update club ${club.id} logoUrl on cloud (${patchRes.status}); attempt ${nextAttempts}/${IMAGE_SYNC_MAX_ATTEMPTS}`);
        }
        continue;
      }

      db.prepare("UPDATE clubs SET logo_url = ?, image_sync_attempts = 0 WHERE id = ?").run(newLogoUrl, club.id);
      console.log(`[image-sync] ✓ Club ${club.id} logo synced → ${newLogoUrl}`);
      imagesUploaded++;
    } catch (err) {
      const nextAttempts = club.image_sync_attempts + 1;
      db.prepare("UPDATE clubs SET image_sync_attempts = ? WHERE id = ?").run(nextAttempts, club.id);
      if (nextAttempts >= IMAGE_SYNC_MAX_ATTEMPTS) {
        console.warn(`[image-sync] Club ${club.id} logo sync failed ${nextAttempts} times — giving up: ${err instanceof Error ? err.message : String(err)}`);
      } else {
        console.warn(`[image-sync] Club ${club.id} logo error (attempt ${nextAttempts}/${IMAGE_SYNC_MAX_ATTEMPTS}): ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  return { imagesUploaded };
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
    console.log("[auto-sync] No active or open events — skipping sync");
    getDb()
      .prepare("UPDATE _sync_state SET last_error = NULL WHERE id = 1")
      .run();
    return;
  }

  console.log("[auto-sync] Cloud reachable and open/active event found — syncing…");
  try {
    const pushResult = await runSync();
    const pullResult = await runPull();
    const imageResult = await runImageSync();
    const r = pushResult.results;
    writeSyncSuccess({
      checkinsUpdated:       r.checkinsUpdated,
      checkinsInserted:      r.checkinsInserted,
      rfidUpserted:          r.rfidUpserted,
      registrationsUpdated:  r.registrationsUpdated,
      registrationsInserted: r.registrationsInserted,
      ridersUpdated:         r.ridersUpdated,
      skipped:               r.skipped,
      imagesUploaded:        imageResult.imagesUploaded,
      ...pullResult.rows,
    });
    console.log(`[auto-sync] ✓ Sync complete (pushed + pulled + ${imageResult.imagesUploaded} images)`);
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
