import type Database from "better-sqlite3";

/**
 * Ids for club-setup rows made on this desktop (series, scoring tables,
 * discount categories and codes, sell items, rental units). The cloud numbers
 * its rows from 1; a row made here gets a random id from 10,000,000 up, so it
 * can't land on a row pulled from the cloud and the cloud can keep it. The
 * cloud's serial numbering is never moved into this range.
 */
export const DESKTOP_ID_FLOOR = 10_000_000;
const DESKTOP_ID_CEILING = 2_000_000_000;

/** The club-setup tables whose rows sync both ways through the write queue. */
export const ORG_TABLES = ["points_tables", "series", "discount_categories", "comp_codes", "club_sell_items", "rental_transponders"] as const;

export function newDesktopId(db: Database.Database, table: (typeof ORG_TABLES)[number]): number {
  const taken = db.prepare(`SELECT 1 FROM ${table} WHERE id = ?`);
  // A row removed here may still wait in the queue to be removed in the cloud.
  const queued = db.prepare("SELECT 1 FROM _write_queue WHERE table_name = ? AND record_id = ? AND synced_at IS NULL");
  for (;;) {
    const id = DESKTOP_ID_FLOOR + Math.floor(Math.random() * (DESKTOP_ID_CEILING - DESKTOP_ID_FLOOR));
    if (!taken.get(id) && !queued.get(table, id)) return id;
  }
}
