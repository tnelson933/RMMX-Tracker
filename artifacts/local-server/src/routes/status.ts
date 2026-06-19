import { Router } from "express";
import { getDb } from "../db";
import { readSyncState, AUTO_SYNC_ENABLED, CLOUD_URL, CLUB_ID, runPull } from "../auto-sync";

const router = Router();

// POST /api/admin/sync/pull — trigger an immediate cloud→local pull
// Requires an active session (desktop organizer must be logged in).
router.post("/admin/sync/pull", async (req, res) => {
  const userId = (req.session as any).userId;
  if (!userId) return res.status(401).json({ error: "Unauthorized" });

  if (!AUTO_SYNC_ENABLED) {
    return res.status(503).json({
      ok: false,
      error: "Cloud sync not configured — CLOUD_URL and CLUB_ID must be set",
    });
  }

  try {
    const result = await runPull();
    return res.json({ ok: true, rows: result.rows });
  } catch (err: any) {
    return res.status(500).json({ ok: false, error: String(err?.message ?? err) });
  }
});

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
