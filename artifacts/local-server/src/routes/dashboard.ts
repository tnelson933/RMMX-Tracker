import { Router } from "express";
import { getDb } from "../db";
import { isoTime } from "../lib/cloud-shape";

const router = Router();

// GET /dashboard/club/:clubId — same numbers, lists and order as the website
// (api-server routes/dashboard.ts).
router.get("/dashboard/club/:clubId", (req, res) => {
  const session = req.session as any;
  if (!session?.userId) return res.status(401).json({ error: "You're signed out. Sign in again, then try once more." });

  const db = getDb();
  const clubId = Number(req.params.clubId);
  const now = new Date();
  const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
  const UPCOMING = "substr(COALESCE(end_date, date), 1, 10) >= ?";

  const totalEvents = (db.prepare("SELECT COUNT(*) as cnt FROM events WHERE club_id = ?").get(clubId) as any).cnt;
  const upcomingEvents = (db.prepare(`SELECT COUNT(*) as cnt FROM events WHERE club_id = ? AND ${UPCOMING}`).get(clubId, today) as any).cnt;

  const IN_CLUB = "event_id IN (SELECT id FROM events WHERE club_id = ?)";
  const totalRegistrations = (db.prepare(`SELECT COUNT(*) as cnt FROM registrations WHERE ${IN_CLUB}`).get(clubId) as any).cnt;
  // People, by their email (a rider with two class entries counts once).
  const uniqueRegistrations = (db.prepare(
    `SELECT COUNT(DISTINCT r.email) as cnt FROM registrations reg JOIN riders r ON r.id = reg.rider_id WHERE reg.${IN_CLUB}`,
  ).get(clubId) as any).cnt;
  const checkedInToday = (db.prepare(`SELECT COUNT(*) as cnt FROM checkins WHERE ${IN_CLUB} AND checked_in = 1`).get(clubId) as any).cnt;
  const totalRiders = (db.prepare(`SELECT COUNT(DISTINCT rider_id) as cnt FROM registrations WHERE ${IN_CLUB}`).get(clubId) as any).cnt;

  const upcomingEventList = db.prepare(
    `SELECT * FROM events WHERE club_id = ? AND ${UPCOMING} ORDER BY date ASC, id ASC LIMIT 5`,
  ).all(clubId, today) as any[];

  const nextEvent = upcomingEventList[0] ?? null;
  let nextEventSnapshot: Record<string, unknown> | null = null;
  const actionItems: Array<{ type: string; label: string; count: number; href: string; severity: string }> = [];
  if (nextEvent) {
    const regs = db.prepare(
      `SELECT reg.*, EXISTS (SELECT 1 FROM liability_waiver_signatures s WHERE s.registration_id = reg.id) AS liability_signed
       FROM registrations reg WHERE reg.event_id = ? AND reg.status <> 'void'`,
    ).all(nextEvent.id) as any[];
    const weekAgo = now.getTime() - 7 * 24 * 60 * 60 * 1000;
    const count = (test: (r: any) => boolean) => regs.filter(test).length;
    const unpaidCount = nextEvent.payment_enabled === 1 ? count(r => r.payment_status === "unpaid") : 0;
    const missingWaiversCount = nextEvent.require_liability_waiver === 1
      ? count(r => !r.liability_signed)
      : nextEvent.require_waiver === 1 ? count(r => r.waiver_acknowledged_at == null) : 0;
    // Riders renting or buying one get it at check-in, so they aren't missing one.
    const missingTranspondersCount = nextEvent.require_transponder === 1
      ? count(r => !String(r.mylaps_transponder_number ?? "").trim() && r.transponder_rental !== 1 && r.rm_trackr_purchased !== 1)
      : 0;
    const href = `/events/${nextEvent.id}/registrations`;
    if (unpaidCount > 0) actionItems.push({ type: "unpaid", label: "Unpaid registrations", count: unpaidCount, href, severity: "urgent" });
    if (missingWaiversCount > 0) actionItems.push({ type: "waiver", label: "Missing waivers", count: missingWaiversCount, href, severity: "urgent" });
    if (missingTranspondersCount > 0) actionItems.push({ type: "transponder", label: "Missing transponder numbers", count: missingTranspondersCount, href, severity: "warning" });
    nextEventSnapshot = {
      id: nextEvent.id,
      name: nextEvent.name,
      date: nextEvent.date,
      location: nextEvent.location ?? null,
      trackName: nextEvent.track_name ?? null,
      registrationClose: nextEvent.registration_close ?? null,
      maxRiders: nextEvent.max_riders ?? null,
      registrationCount: regs.length,
      newRegistrationsLast7Days: count(r => new Date(isoTime(r.created_at) ?? 0).getTime() >= weekAgo),
      paidCount: count(r => r.payment_status === "paid"),
      unpaidCount,
      missingWaiversCount,
      missingTranspondersCount,
    };
  }

  // The last 10 registrations and check-ins across the club's events.
  const recentRegs = db.prepare(`
    SELECT reg.race_class, reg.created_at, r.first_name, r.last_name, e.name as event_name
    FROM registrations reg
    JOIN riders r ON reg.rider_id = r.id
    JOIN events e ON reg.event_id = e.id
    WHERE e.club_id = ?
  `).all(clubId) as any[];
  const recentCheckins = db.prepare(`
    SELECT c.race_class, c.checked_in_at, r.first_name, r.last_name, e.name as event_name
    FROM checkins c
    JOIN riders r ON c.rider_id = r.id
    JOIN events e ON c.event_id = e.id
    WHERE e.club_id = ? AND c.checked_in = 1
  `).all(clubId) as any[];
  const newest = <T extends { timestamp: string }>(items: T[]) =>
    items.sort((x, y) => new Date(y.timestamp).getTime() - new Date(x.timestamp).getTime()).slice(0, 10);
  const recentActivity = newest([
    ...newest(recentRegs.map((r: any) => ({
      type: "registration",
      description: `${r.first_name} ${r.last_name} registered for ${r.event_name} — ${r.race_class}`,
      timestamp: isoTime(r.created_at) ?? new Date().toISOString(),
    }))),
    ...newest(recentCheckins.map((c: any) => ({
      type: "checkin",
      description: `${c.first_name} ${c.last_name} checked in at ${c.event_name} — ${c.race_class}`,
      timestamp: isoTime(c.checked_in_at) ?? new Date().toISOString(),
    }))),
  ]);

  return res.json({
    totalEvents,
    upcomingEvents,
    totalRiders,
    totalRegistrations,
    uniqueRegistrations,
    checkedInToday,
    recentActivity,
    nextEventSnapshot,
    actionItems,
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
      trackLat: e.track_lat ?? null,
      trackLng: e.track_lng ?? null,
      status: e.status,
      paymentEnabled: e.payment_enabled === 1,
      requireWaiver: e.require_waiver === 1,
      requireLiabilityWaiver: e.require_liability_waiver === 1,
      requireTransponder: e.require_transponder === 1,
      groupRace: e.group_race === 1,
      ridersPerGroup: e.riders_per_group ?? null,
      entryFee: e.entry_fee ? Number(e.entry_fee) : null,
      maxRiders: e.max_riders ?? null,
      endDate: e.end_date ?? null,
      createdAt: isoTime(e.created_at),
      clubName: null,
    })),
  });
});

// GET /reports/event/:eventId
router.get("/reports/event/:eventId", (req, res) => {
  const session = req.session as any;
  if (!session?.userId) return res.status(401).json({ error: "You're signed out. Sign in again, then try once more." });

  const db = getDb();
  const eventId = Number(req.params.eventId);

  const event = db.prepare("SELECT id, name FROM events WHERE id = ?").get(eventId) as any;
  if (!event) return res.status(404).json({ error: "That item couldn't be found. It may have been deleted. Refresh the page and try again." });

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
