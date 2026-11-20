import type Database from "better-sqlite3";
import { normalizeActiveTransponderIdentifier } from "@workspace/api-zod";

/**
 * Every transponder a rider owns, offline: the SQLite copy of the cloud's
 * rider_transponders (deploy/migrations/0046-rider-transponders.sql). RM TrackR
 * active transponders and RFID stickers, e.g. one per bike; a read of any of
 * them times the rider. A number belongs to one rider at a time, stored
 * trimmed and lower-case.
 *
 * riders.mylaps_transponder_id / rfid_number stay each kind's primary (oldest)
 * number, kept in step with the list by the triggers below exactly like the
 * cloud's, so every older code path that reads or writes the single fields
 * keeps working. Same rules as artifacts/api-server/src/lib/riderTransponderRules.ts.
 */

type Db = Database.Database;
export type TransponderKind = "trackr" | "rfid";

export const TRANSPONDER_KIND_NAMES: Record<TransponderKind, string> = {
  trackr: "RM TrackR",
  rfid: "RFID sticker",
};

/** _rider_profile_dirty field name for "this rider's list changed offline". */
export const TRANSPONDERS_DIRTY_FIELD = "transponders";

export function normalizeTransponderNumber(value: string | null | undefined): string | null {
  const v = typeof value === "string" ? value.trim().toLowerCase() : "";
  return v || null;
}

// Expressions for the triggers: a profile field as a list number.
const norm = (col: string) => `lower(trim(coalesce(${col}, '')))`;

/** Profile field -> list (rename / add / remove), for one kind. */
function profileFieldTrigger(column: string, kind: TransponderKind): string {
  const o = norm(`OLD.${column}`);
  const n = norm(`NEW.${column}`);
  return `
    CREATE TRIGGER _rt_riders_${kind}_update
    AFTER UPDATE OF ${column} ON riders
    WHEN ${o} <> ${n}
    BEGIN
      UPDATE rider_transponders SET transponder_number = ${n}, updated_at = datetime('now')
       WHERE rider_id = NEW.id AND transponder_number = ${o} AND ${o} <> '' AND ${n} <> ''
         AND NOT EXISTS (SELECT 1 FROM rider_transponders WHERE transponder_number = ${n});
      INSERT INTO rider_transponders (rider_id, transponder_number, kind)
        SELECT NEW.id, ${n}, '${kind}' WHERE ${n} <> ''
           AND NOT EXISTS (SELECT 1 FROM rider_transponders WHERE transponder_number = ${n});
      DELETE FROM rider_transponders WHERE rider_id = NEW.id AND transponder_number = ${o} AND ${o} <> '';
    END;`;
}

/** List -> profile field: point it at the oldest listed number of that kind unless it already names one. */
function primaryRefresh(rowRef: "NEW" | "OLD", kind: TransponderKind): string {
  const column = kind === "trackr" ? "mylaps_transponder_id" : "rfid_number";
  return `
      UPDATE riders
         SET ${column} = (SELECT transponder_number FROM rider_transponders
                           WHERE rider_id = ${rowRef}.rider_id AND kind = '${kind}' ORDER BY id LIMIT 1)
       WHERE id = ${rowRef}.rider_id AND ${rowRef}.kind = '${kind}'
         AND NOT EXISTS (SELECT 1 FROM rider_transponders t
                          WHERE t.rider_id = riders.id AND t.kind = '${kind}' AND t.transponder_number = ${norm(`riders.${column}`)})
         AND ${column} IS NOT (SELECT transponder_number FROM rider_transponders
                                WHERE rider_id = ${rowRef}.rider_id AND kind = '${kind}' ORDER BY id LIMIT 1);`;
}

/**
 * Create the table and triggers, then copy in every profile number (re-runnable).
 *
 * Trigger inserts are guarded with NOT EXISTS rather than INSERT OR IGNORE:
 * SQLite applies the conflict policy of the statement that fired the trigger
 * (e.g. the sync engine's INSERT … ON CONFLICT DO UPDATE upsert of riders),
 * which would turn a taken number into an abort.
 */
export function ensureRiderTranspondersSchema(db: Db): void {
  db.exec(`
    -- Recreated on every start so a changed definition always applies.
    DROP TRIGGER IF EXISTS _rt_riders_insert;
    DROP TRIGGER IF EXISTS _rt_riders_trackr_update;
    DROP TRIGGER IF EXISTS _rt_riders_rfid_update;
    DROP TRIGGER IF EXISTS _rt_list_insert;
    DROP TRIGGER IF EXISTS _rt_list_delete;
    DROP TRIGGER IF EXISTS _rt_list_update;
    CREATE TABLE IF NOT EXISTS rider_transponders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      rider_id INTEGER NOT NULL REFERENCES riders(id) ON DELETE CASCADE,
      transponder_number TEXT NOT NULL,
      kind TEXT NOT NULL DEFAULT 'trackr',
      label TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE UNIQUE INDEX IF NOT EXISTS rider_transponders_number_idx ON rider_transponders (transponder_number);
    CREATE INDEX IF NOT EXISTS rider_transponders_rider_idx ON rider_transponders (rider_id);

    -- Backfill before the triggers: lower rider id keeps a number two profiles share.
    INSERT OR IGNORE INTO rider_transponders (rider_id, transponder_number, kind)
      SELECT id, ${norm("mylaps_transponder_id")}, 'trackr' FROM riders
       WHERE ${norm("mylaps_transponder_id")} <> '' ORDER BY id;
    INSERT OR IGNORE INTO rider_transponders (rider_id, transponder_number, kind)
      SELECT id, ${norm("rfid_number")}, 'rfid' FROM riders
       WHERE ${norm("rfid_number")} <> '' ORDER BY id;

    CREATE TRIGGER _rt_riders_insert
    AFTER INSERT ON riders
    BEGIN
      INSERT INTO rider_transponders (rider_id, transponder_number, kind)
        SELECT NEW.id, ${norm("NEW.mylaps_transponder_id")}, 'trackr' WHERE ${norm("NEW.mylaps_transponder_id")} <> ''
           AND NOT EXISTS (SELECT 1 FROM rider_transponders WHERE transponder_number = ${norm("NEW.mylaps_transponder_id")});
      INSERT INTO rider_transponders (rider_id, transponder_number, kind)
        SELECT NEW.id, ${norm("NEW.rfid_number")}, 'rfid' WHERE ${norm("NEW.rfid_number")} <> ''
           AND NOT EXISTS (SELECT 1 FROM rider_transponders WHERE transponder_number = ${norm("NEW.rfid_number")});
    END;
    ${profileFieldTrigger("mylaps_transponder_id", "trackr")}
    ${profileFieldTrigger("rfid_number", "rfid")}

    CREATE TRIGGER _rt_list_insert
    AFTER INSERT ON rider_transponders
    BEGIN ${primaryRefresh("NEW", "trackr")} ${primaryRefresh("NEW", "rfid")}
    END;
    CREATE TRIGGER _rt_list_delete
    AFTER DELETE ON rider_transponders
    BEGIN ${primaryRefresh("OLD", "trackr")} ${primaryRefresh("OLD", "rfid")}
    END;
    CREATE TRIGGER _rt_list_update
    AFTER UPDATE ON rider_transponders
    BEGIN ${primaryRefresh("NEW", "trackr")} ${primaryRefresh("NEW", "rfid")} ${primaryRefresh("OLD", "trackr")} ${primaryRefresh("OLD", "rfid")}
    END;
  `);
}

/**
 * The rider who owns this number: the list, then the single profile fields
 * (kept for the transition). Event-level matches come first in the callers.
 */
export function riderIdForTransponder(db: Db, tag: string): number | null {
  const number = normalizeTransponderNumber(tag);
  if (!number) return null;
  const listed = db.prepare("SELECT rider_id FROM rider_transponders WHERE transponder_number = ? LIMIT 1").get(number) as
    | { rider_id: number } | undefined;
  if (listed) return listed.rider_id;
  const legacy = db.prepare(
    "SELECT id FROM riders WHERE mylaps_transponder_id = ? COLLATE NOCASE OR rfid_number = ? COLLATE NOCASE ORDER BY id LIMIT 1",
  ).get(number, number) as { id: number } | undefined;
  return legacy?.id ?? null;
}

export interface RiderTransponderView {
  id: number;
  number: string;
  kind: TransponderKind;
  kindName: string;
  label: string | null;
  primary: boolean;
  createdAt: string | null;
}

type Row = { id: number; rider_id: number; transponder_number: string; kind: string; label: string | null; created_at: string | null };

function toViews(rows: Row[]): RiderTransponderView[] {
  const seen = new Set<string>();
  return [...rows].sort((a, b) => a.id - b.id).map((r) => {
    const kind: TransponderKind = r.kind === "rfid" ? "rfid" : "trackr";
    const primary = !seen.has(kind);
    seen.add(kind);
    return {
      id: r.id,
      number: r.transponder_number.toUpperCase(),
      kind,
      kindName: TRANSPONDER_KIND_NAMES[kind],
      label: r.label ?? null,
      primary,
      createdAt: r.created_at ? new Date(r.created_at.replace(" ", "T") + (r.created_at.includes("Z") ? "" : "Z")).toISOString() : null,
    };
  });
}

export function listRiderTransponders(db: Db, riderId: number): RiderTransponderView[] {
  return toViews(db.prepare("SELECT * FROM rider_transponders WHERE rider_id = ? ORDER BY id").all(riderId) as Row[]);
}

export function listTranspondersForRiders(db: Db, riderIds: number[]): Map<number, RiderTransponderView[]> {
  const out = new Map<number, RiderTransponderView[]>(riderIds.map((id) => [id, []]));
  if (riderIds.length === 0) return out;
  const rows = db.prepare(`SELECT * FROM rider_transponders WHERE rider_id IN (${riderIds.map(() => "?").join(",")}) ORDER BY id`)
    .all(...riderIds) as Row[];
  const grouped = new Map<number, Row[]>();
  for (const r of rows) grouped.set(r.rider_id, [...(grouped.get(r.rider_id) ?? []), r]);
  for (const [id, list] of grouped) out.set(id, toViews(list));
  return out;
}

export type TransponderInput =
  | { ok: true; number: string; kind: TransponderKind; label: string | null }
  | { ok: false; error: string };

export function parseTransponderInput(body: { number?: unknown; transponderNumber?: unknown; kind?: unknown; label?: unknown }): TransponderInput {
  const kind: TransponderKind | null = body.kind == null || body.kind === "" ? "trackr" : body.kind === "trackr" || body.kind === "rfid" ? body.kind : null;
  if (!kind) return { ok: false, error: "Choose RM TrackR or RFID sticker." };
  const raw = String(body.number ?? body.transponderNumber ?? "").trim();
  if (!raw) return { ok: false, error: `Enter the number printed on the ${TRANSPONDER_KIND_NAMES[kind]}.` };
  let number: string | null;
  if (kind === "trackr") {
    number = normalizeActiveTransponderIdentifier(raw);
    if (!number) return { ok: false, error: "Enter the ID printed on the RM TrackR (up to 9 numbers or letters A–F)." };
  } else {
    number = /^[A-Za-z0-9-]{1,64}$/.test(raw) ? raw.toLowerCase() : null;
    if (!number) return { ok: false, error: "Enter the number printed on the RFID sticker (letters and numbers only)." };
  }
  const label = typeof body.label === "string" ? body.label.trim().slice(0, 60) : "";
  return { ok: true, number, kind, label: label || null };
}

export type AddResult =
  | { ok: true; created: boolean; transponders: RiderTransponderView[] }
  | { ok: false; error: string; ownerRiderId: number };

/** Organizer adds a transponder (offline only organizers use this). A taken number says whose it is. */
export function addRiderTransponder(db: Db, riderId: number, input: { number: string; kind: TransponderKind; label: string | null }): AddResult {
  const number = normalizeTransponderNumber(input.number)!;
  const owner = db.prepare(
    `SELECT t.rider_id, r.first_name, r.last_name FROM rider_transponders t LEFT JOIN riders r ON r.id = t.rider_id
      WHERE t.transponder_number = ?`,
  ).get(number) as { rider_id: number; first_name: string | null; last_name: string | null } | undefined;
  if (owner && owner.rider_id !== riderId) {
    const name = [owner.first_name, owner.last_name].filter(Boolean).join(" ") || `rider #${owner.rider_id}`;
    return {
      ok: false,
      ownerRiderId: owner.rider_id,
      error: `${TRANSPONDER_KIND_NAMES[input.kind]} ${number.toUpperCase()} is already assigned to ${name} (rider #${owner.rider_id}). Remove it from their profile first if it changed hands.`,
    };
  }
  let created = false;
  if (owner) {
    if (input.label !== null) {
      db.prepare("UPDATE rider_transponders SET label = ?, updated_at = datetime('now') WHERE rider_id = ? AND transponder_number = ?")
        .run(input.label, riderId, number);
    }
  } else {
    created = db.prepare("INSERT OR IGNORE INTO rider_transponders (rider_id, transponder_number, kind, label) VALUES (?, ?, ?, ?)")
      .run(riderId, number, input.kind, input.label).changes > 0;
  }
  return { ok: true, created, transponders: listRiderTransponders(db, riderId) };
}

/** Add a number the rider used (registration, check-in) when nobody owns it yet. Never takes one from another rider. */
export function addRiderTransponderIfFree(db: Db, riderId: number, rawNumber: string | null | undefined, kind: TransponderKind): boolean {
  const number = normalizeTransponderNumber(rawNumber);
  if (!number) return false;
  return db.prepare("INSERT OR IGNORE INTO rider_transponders (rider_id, transponder_number, kind) VALUES (?, ?, ?)")
    .run(riderId, number, kind).changes > 0;
}

export function removeRiderTransponder(db: Db, riderId: number, transponderId: number): RiderTransponderView[] | null {
  const removed = db.prepare("DELETE FROM rider_transponders WHERE id = ? AND rider_id = ?").run(transponderId, riderId).changes;
  return removed ? listRiderTransponders(db, riderId) : null;
}

/** The list as the cloud sync takes it. */
export function transpondersForSync(db: Db, riderId: number): Array<{ number: string; kind: TransponderKind; label: string | null }> {
  return (db.prepare("SELECT transponder_number, kind, label FROM rider_transponders WHERE rider_id = ? ORDER BY id").all(riderId) as Row[])
    .map((r) => ({ number: r.transponder_number, kind: r.kind === "rfid" ? "rfid" : "trackr", label: r.label ?? null }));
}

/**
 * Make each pulled rider's list match the cloud's (pull rows: riderId = cloud
 * id). A rider with unpushed profile edits keeps its local list until they
 * reach the cloud; a number the cloud gives this rider is taken from another
 * local rider only when that rider has no unpushed edits. Same as the desktop
 * sync engine's applyPulledTransponders.
 */
export function applyPulledRiderTransponders(
  db: Db,
  localIdForCloud: Map<number, number>,
  rows: Array<{ riderId?: unknown; transponderNumber?: unknown; kind?: unknown; label?: unknown }>,
): number {
  const dirty = new Set(
    (db.prepare("SELECT DISTINCT rider_id FROM _rider_profile_dirty").all() as Array<{ rider_id: number }>).map((r) => r.rider_id),
  );
  const byCloud = new Map<number, Map<string, { kind: TransponderKind; label: string | null }>>();
  for (const r of rows) {
    const number = normalizeTransponderNumber(typeof r.transponderNumber === "string" ? r.transponderNumber : null);
    if (!number) continue;
    const m = byCloud.get(Number(r.riderId)) ?? new Map();
    m.set(number, { kind: r.kind === "rfid" ? "rfid" : "trackr", label: typeof r.label === "string" ? r.label : null });
    byCloud.set(Number(r.riderId), m);
  }
  const current = db.prepare("SELECT id, transponder_number, kind, label FROM rider_transponders WHERE rider_id = ?");
  const remove = db.prepare("DELETE FROM rider_transponders WHERE id = ?");
  const owner = db.prepare("SELECT id, rider_id FROM rider_transponders WHERE transponder_number = ?");
  const insert = db.prepare("INSERT OR IGNORE INTO rider_transponders (rider_id, transponder_number, kind, label) VALUES (?, ?, ?, ?)");
  const relabel = db.prepare("UPDATE rider_transponders SET label = ?, kind = ?, updated_at = datetime('now') WHERE id = ?");
  let changed = 0;
  for (const [cloudId, localId] of localIdForCloud) {
    if (dirty.has(localId)) continue;
    const wanted = byCloud.get(cloudId) ?? new Map();
    const have = current.all(localId) as Row[];
    for (const h of have) {
      const w = wanted.get(h.transponder_number);
      if (!w) changed += remove.run(h.id).changes;
      else if (w.label !== h.label || w.kind !== h.kind) changed += relabel.run(w.label, w.kind, h.id).changes;
    }
    const haveNumbers = new Set(have.map((h) => h.transponder_number));
    for (const [number, w] of wanted) {
      if (haveNumbers.has(number)) continue;
      const taken = owner.get(number) as { id: number; rider_id: number } | undefined;
      if (taken && taken.rider_id !== localId) {
        if (dirty.has(taken.rider_id)) continue;
        remove.run(taken.id);
      }
      changed += insert.run(localId, number, w.kind, w.label).changes;
    }
  }
  return changed;
}
