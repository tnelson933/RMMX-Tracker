import { Router } from "express";
import { getDb } from "../db";
import { readSyncState, AUTO_SYNC_ENABLED, CLOUD_URL, CLUB_ID } from "../auto-sync";

const router = Router();

router.get("/status", (_req, res) => {
  const db = getDb();

  const events = db
    .prepare("SELECT status, COUNT(*) as count FROM events GROUP BY status")
    .all() as Array<{ status: string; count: number }>;

  const eventSummary: Record<string, number> = {};
  let totalEvents = 0;
  for (const row of events) {
    eventSummary[row.status] = row.count;
    totalEvents += row.count;
  }

  const rowCounts = {
    checkins:        (db.prepare("SELECT COUNT(*) as c FROM checkins").get()        as { c: number }).c,
    rfidAssignments: (db.prepare("SELECT COUNT(*) as c FROM rfid_assignments").get() as { c: number }).c,
    registrations:   (db.prepare("SELECT COUNT(*) as c FROM registrations").get()   as { c: number }).c,
    riders:          (db.prepare("SELECT COUNT(*) as c FROM riders").get()           as { c: number }).c,
  };

  const syncState = readSyncState();

  res.json({
    ok: true,
    uptime: Math.floor(process.uptime()),
    database: process.env.SQLITE_FILE ?? "./race_data.db",
    events: {
      total: totalEvents,
      byStatus: eventSummary,
    },
    rows: rowCounts,
    autoSync: {
      enabled:        AUTO_SYNC_ENABLED,
      cloudUrl:       CLOUD_URL || null,
      clubId:         AUTO_SYNC_ENABLED ? CLUB_ID   : null,
      lastAttemptAt:  syncState.lastAttemptAt,
      lastSuccessAt:  syncState.lastSuccessAt,
      lastError:      syncState.lastError,
      rowsSynced:     syncState.rowsSynced,
    },
  });
});

export default router;
