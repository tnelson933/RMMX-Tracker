import { Router } from "express";
import { getDb } from "../db";

const router = Router();

// GET /dashboard/club/:clubId
router.get("/dashboard/club/:clubId", (req, res) => {
  const session = req.session as any;
  if (!session?.userId) return res.status(401).json({ error: "Unauthorized" });

  const db = getDb();
  const clubId = Number(req.params.clubId);

  const totalEvents = (db.prepare("SELECT COUNT(*) as cnt FROM events WHERE club_id = ?").get(clubId) as any).cnt;

  const upcomingEvents = (db.prepare(
    "SELECT COUNT(*) as cnt FROM events WHERE club_id = ? AND status != 'completed'"
  ).get(clubId) as any).cnt;

  const totalRiders = (db.prepare("SELECT COUNT(*) as cnt FROM riders").get() as any).cnt;

  const eventRows = db.prepare("SELECT id FROM events WHERE club_id = ?").all(clubId) as any[];
  const eventIds = eventRows.map((e: any) => e.id);

  let totalRegistrations = 0;
  let uniqueRegistrations = 0;
  let checkedInToday = 0;
  let recentActivity: { type: string; description: string; timestamp: string }[] = [];

  if (eventIds.length > 0) {
    const ph = eventIds.map(() => "?").join(",");

    totalRegistrations = (db.prepare(
      `SELECT COUNT(*) as cnt FROM registrations WHERE event_id IN (${ph})`
    ).get(...eventIds) as any).cnt;

    uniqueRegistrations = (db.prepare(
      `SELECT COUNT(DISTINCT rider_id) as cnt FROM registrations WHERE event_id IN (${ph})`
    ).get(...eventIds) as any).cnt;

    checkedInToday = (db.prepare(
      `SELECT COUNT(*) as cnt FROM checkins WHERE event_id IN (${ph}) AND checked_in = 1`
    ).get(...eventIds) as any).cnt;

    const recentRegs = db.prepare(`
      SELECT reg.race_class, reg.created_at,
             r.first_name, r.last_name, e.name as event_name
      FROM registrations reg
      LEFT JOIN riders r ON reg.rider_id = r.id
      LEFT JOIN events e ON reg.event_id = e.id
      WHERE reg.event_id IN (${ph})
      ORDER BY reg.created_at DESC
      LIMIT 5
    `).all(...eventIds) as any[];

    const recentCheckins = db.prepare(`
      SELECT c.race_class, c.checked_in_at,
             r.first_name, r.last_name, e.name as event_name
      FROM checkins c
      LEFT JOIN riders r ON c.rider_id = r.id
      LEFT JOIN events e ON c.event_id = e.id
      WHERE c.event_id IN (${ph}) AND c.checked_in = 1
      ORDER BY c.checked_in_at DESC
      LIMIT 5
    `).all(...eventIds) as any[];

    const activityItems = [
      ...recentRegs.map((r: any) => ({
        type: "registration",
        description: `${r.first_name ?? ""} ${r.last_name ?? ""} registered for ${r.event_name} — ${r.race_class}`,
        timestamp: r.created_at ?? new Date().toISOString(),
      })),
      ...recentCheckins.map((c: any) => ({
        type: "checkin",
        description: `${c.first_name ?? ""} ${c.last_name ?? ""} checked in at ${c.event_name} — ${c.race_class}`,
        timestamp: c.checked_in_at ?? new Date().toISOString(),
      })),
    ];
    recentActivity = activityItems
      .sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime())
      .slice(0, 10);
  }

  const upcomingEventList = db.prepare(`
    SELECT id, club_id, name, date, state, location, track_name,
           race_classes, registration_open, registration_close,
           status, payment_enabled, entry_fee, max_riders, created_at
    FROM events
    WHERE club_id = ? AND status != 'completed'
    ORDER BY date ASC
    LIMIT 5
  `).all(clubId) as any[];

  return res.json({
    totalEvents,
    upcomingEvents,
    totalRiders,
    totalRegistrations,
    uniqueRegistrations,
    checkedInToday,
    recentActivity,
    upcomingEventList: upcomingEventList.map((e: any) => ({
      id: e.id,
      clubId: e.club_id,
      name: e.name,
      date: e.date,
      state: e.state ?? "",
      location: e.location ?? null,
      trackName: e.track_name ?? null,
      raceClasses: (() => { try { return JSON.parse(e.race_classes || "[]"); } catch { return []; } })(),
      registrationOpen: e.registration_open ?? null,
      registrationClose: e.registration_close ?? null,
      status: e.status,
      paymentEnabled: e.payment_enabled === 1,
      entryFee: e.entry_fee ? Number(e.entry_fee) : null,
      maxRiders: e.max_riders ?? null,
      createdAt: e.created_at,
      clubName: null,
    })),
  });
});

// GET /reports/event/:eventId
router.get("/reports/event/:eventId", (req, res) => {
  const session = req.session as any;
  if (!session?.userId) return res.status(401).json({ error: "Unauthorized" });

  const db = getDb();
  const eventId = Number(req.params.eventId);

  const event = db.prepare("SELECT id, name FROM events WHERE id = ?").get(eventId) as any;
  if (!event) return res.status(404).json({ error: "Not found" });

  const totalRegistrations = (db.prepare(
    "SELECT COUNT(*) as cnt FROM registrations WHERE event_id = ?"
  ).get(eventId) as any).cnt;

  const totalCheckedIn = (db.prepare(
    "SELECT COUNT(*) as cnt FROM checkins WHERE event_id = ? AND checked_in = 1"
  ).get(eventId) as any).cnt;

  const rfidLinked = (db.prepare(
    "SELECT COUNT(*) as cnt FROM checkins WHERE event_id = ? AND rfid_linked = 1"
  ).get(eventId) as any).cnt;

  const motosScheduled = (db.prepare(
    "SELECT COUNT(*) as cnt FROM motos WHERE event_id = ? AND type != 'practice'"
  ).get(eventId) as any).cnt;

  const motosCompleted = (db.prepare(
    "SELECT COUNT(*) as cnt FROM motos WHERE event_id = ? AND type != 'practice' AND status = 'completed'"
  ).get(eventId) as any).cnt;

  const regByClass = db.prepare(
    "SELECT race_class, COUNT(*) as cnt FROM registrations WHERE event_id = ? GROUP BY race_class"
  ).all(eventId) as any[];

  const checkinByClass = db.prepare(
    "SELECT race_class, COUNT(*) as cnt FROM checkins WHERE event_id = ? AND checked_in = 1 GROUP BY race_class"
  ).all(eventId) as any[];

  const motosByClass = db.prepare(
    "SELECT race_class, status, COUNT(*) as cnt FROM motos WHERE event_id = ? AND type != 'practice' GROUP BY race_class, status"
  ).all(eventId) as any[];

  const checkinMap: Record<string, number> = {};
  for (const row of checkinByClass) checkinMap[row.race_class] = row.cnt;

  const motoScheduledMap: Record<string, number> = {};
  const motoCompletedMap: Record<string, number> = {};
  for (const row of motosByClass) {
    motoScheduledMap[row.race_class] = (motoScheduledMap[row.race_class] ?? 0) + row.cnt;
    if (row.status === "completed") {
      motoCompletedMap[row.race_class] = (motoCompletedMap[row.race_class] ?? 0) + row.cnt;
    }
  }

  const classSummary = regByClass.map((row: any) => {
    const registered = row.cnt;
    const checkedIn = checkinMap[row.race_class] ?? 0;
    return {
      className: row.race_class,
      registered,
      checkedIn,
      noShow: registered - checkedIn,
      motosScheduled: motoScheduledMap[row.race_class] ?? 0,
      motosCompleted: motoCompletedMap[row.race_class] ?? 0,
    };
  });

  return res.json({
    eventId,
    eventName: event.name,
    type: "summary",
    generatedAt: new Date().toISOString(),
    data: {
      totalRegistrations,
      totalCheckedIn,
      rfidLinked,
      noShow: totalRegistrations - totalCheckedIn,
      motosScheduled,
      motosCompleted,
      classSummary,
    },
  });
});

export default router;
