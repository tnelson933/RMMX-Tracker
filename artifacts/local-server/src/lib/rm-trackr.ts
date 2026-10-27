import type Database from "better-sqlite3";

/** Mirrors the cloud constants in lib/db/src/schema/events.ts. */
export const RM_TRACKR_OPTION_ID = "rm-trackr";
export const RM_TRACKR_NAME = "RM TrackR";
export const RM_TRACKR_PRICE = 40;

/** True when a list of purchase options (ids or `{ id }` objects) includes the RM TrackR. */
export function includesRmTrackr(options: unknown): boolean {
  if (!Array.isArray(options)) return false;
  return options.some((o) => {
    const id = typeof o === "string" || typeof o === "number"
      ? String(o)
      : o && typeof o === "object" && "id" in o ? String((o as { id: unknown }).id) : null;
    return id === RM_TRACKR_OPTION_ID;
  });
}

/** Mark every active registration of a rider at an event as having bought an RM TrackR. */
export function markRmTrackrPurchased(db: Database.Database, eventId: number, riderId: number): void {
  db.prepare(
    `UPDATE registrations SET rm_trackr_purchased = 1
     WHERE event_id = ? AND rider_id = ? AND COALESCE(status, 'confirmed') != 'void'`,
  ).run(eventId, riderId);
}

/**
 * Fulfil a rider's outstanding RM TrackR purchase for an event once staff assign
 * them a transponder. No-op when the rider bought none or it's already fulfilled.
 * Mirrors fulfillRmTrackr in the cloud's lib/rmTrackr.ts.
 */
export function fulfillRmTrackr(
  db: Database.Database,
  eventId: number,
  riderId: number,
  transponder: string | null | undefined,
): void {
  const number = typeof transponder === "string" ? transponder.trim() : "";
  if (!number) return;
  db.prepare(
    `UPDATE registrations SET rm_trackr_fulfilled_at = ?, rm_trackr_transponder = ?
     WHERE event_id = ? AND rider_id = ? AND rm_trackr_purchased = 1 AND rm_trackr_fulfilled_at IS NULL`,
  ).run(new Date().toISOString(), number, eventId, riderId);
}
