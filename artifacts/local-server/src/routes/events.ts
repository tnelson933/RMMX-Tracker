import { Router } from "express";
import { getDb, parseBool, parseJsonArr, parseJson } from "../db";

const router = Router();

function deserializeEvent(e: Record<string, unknown>) {
  return {
    id: e.id,
    clubId: e.club_id,
    name: e.name,
    date: e.date,
    state: e.state,
    location: e.location,
    trackName: e.track_name,
    raceClasses: parseJsonArr<string>(e.race_classes as string),
    registrationOpen: e.registration_open,
    registrationClose: e.registration_close,
    status: e.status,
    paymentEnabled: parseBool(e.payment_enabled as number),
    requireAma: parseBool(e.require_ama as number),
    entryFee: e.entry_fee,
    maxRiders: e.max_riders,
    raceClassLimits: parseJson<Record<string, number | null>>(
      e.race_class_limits as string,
      {},
    ),
    purchaseOptions: parseJsonArr(e.purchase_options as string),
    imageUrl: e.image_url,
    timingTechnology: e.timing_technology ?? "rfid",
    transponderRentalEnabled: parseBool(e.transponder_rental_enabled as number),
    transponderRentalFee: e.transponder_rental_fee,
    noDuplicateBibs: parseBool(e.no_duplicate_bibs as number),
    requireClubId: parseBool(e.require_club_id as number),
    scoringTableId: e.scoring_table_id,
    minLapTimes: parseJson<Record<string, number>>(e.min_lap_times as string, {}),
    amaEventId: e.ama_event_id,
    createdAt: e.created_at,
  };
}

router.get("/clubs/:clubId/events", (req, res) => {
  const userId = (req.session as any).userId;
  if (!userId) return res.status(401).json({ error: "Not authenticated" });

  const clubId = Number(req.params.clubId);
  const db = getDb();
  const events = db
    .prepare("SELECT * FROM events WHERE club_id = ? ORDER BY date DESC")
    .all(clubId) as Record<string, unknown>[];

  return res.json(events.map(deserializeEvent));
});

router.get("/events/:eventId", (req, res) => {
  const userId = (req.session as any).userId;
  if (!userId) return res.status(401).json({ error: "Not authenticated" });

  const eventId = Number(req.params.eventId);
  const db = getDb();
  const event = db
    .prepare("SELECT * FROM events WHERE id = ?")
    .get(eventId) as Record<string, unknown> | undefined;

  if (!event) return res.status(404).json({ error: "Event not found" });
  return res.json(deserializeEvent(event));
});

router.get("/events/:eventId/race-day-summary", (req, res) => {
  const userId = (req.session as any).userId;
  if (!userId) return res.status(401).json({ error: "Not authenticated" });

  const eventId = Number(req.params.eventId);
  const db = getDb();

  const totalRegs = (
    db
      .prepare(
        "SELECT COUNT(*) as cnt FROM registrations WHERE event_id = ? AND status != 'void'",
      )
      .get(eventId) as any
  ).cnt;

  const checkedIn = (
    db
      .prepare(
        "SELECT COUNT(*) as cnt FROM checkins WHERE event_id = ? AND checked_in = 1",
      )
      .get(eventId) as any
  ).cnt;

  const rfidLinked = (
    db
      .prepare(
        "SELECT COUNT(*) as cnt FROM checkins WHERE event_id = ? AND rfid_linked = 1",
      )
      .get(eventId) as any
  ).cnt;

  const classCounts = db
    .prepare(
      `SELECT r.race_class, COUNT(*) as total,
        SUM(CASE WHEN c.checked_in = 1 THEN 1 ELSE 0 END) as checked_in
       FROM registrations r
       LEFT JOIN checkins c ON c.event_id = r.event_id AND c.rider_id = r.rider_id
       WHERE r.event_id = ? AND r.status != 'void'
       GROUP BY r.race_class
       ORDER BY r.race_class`,
    )
    .all(eventId) as { race_class: string; total: number; checked_in: number }[];

  return res.json({
    eventId,
    totalRegistrations: totalRegs,
    checkedIn,
    rfidLinked,
    byClass: classCounts.map((c) => ({
      raceClass: c.race_class,
      total: c.total,
      checkedIn: c.checked_in,
    })),
  });
});

export default router;
