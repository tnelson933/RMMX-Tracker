import { Router } from "express";
import { db } from "@workspace/db";
import { clubsTable, eventsTable, ridersTable, registrationsTable, checkinsTable, motosTable, raceResultsTable, eventPublicationTable } from "@workspace/db";
import { eq, and, ne, count, countDistinct, sql, inArray, desc, asc } from "drizzle-orm";
import { buildLeaderboard } from "./timing";

const router = Router();

router.get("/dashboard/club/:clubId", async (req, res) => {
  const clubId = Number(req.params.clubId);

  // Staff club scoping: reject if requesting another club's dashboard
  const staffCId = res.locals.staffClubId;
  if (typeof staffCId === "number" && staffCId !== clubId) {
    return res.status(403).json({ error: "Forbidden" });
  }

  const [eventsCount] = await db.select({ count: count() }).from(eventsTable).where(eq(eventsTable.clubId, clubId));
  const [upcomingCount] = await db.select({ count: count() }).from(eventsTable).where(
    and(eq(eventsTable.clubId, clubId), sql`${eventsTable.status} IN ('draft','registration_open','registration_closed','race_day')`)
  );

  const clubEvents = await db.select({ id: eventsTable.id }).from(eventsTable).where(eq(eventsTable.clubId, clubId));
  const eventIdList = clubEvents.map(e => e.id);

  let totalRegistrations = 0;
  let uniqueRegistrations = 0;
  let checkedInToday = 0;
  if (eventIdList.length > 0) {
    const regCount = await db.select({ count: count() }).from(registrationsTable)
      .where(inArray(registrationsTable.eventId, eventIdList));
    totalRegistrations = regCount[0]?.count || 0;

    const [uqRow] = await db.select({
      count: sql<number>`COUNT(DISTINCT ${ridersTable.email})`,
    }).from(registrationsTable)
      .innerJoin(ridersTable, eq(registrationsTable.riderId, ridersTable.id))
      .where(inArray(registrationsTable.eventId, eventIdList));
    uniqueRegistrations = Number(uqRow?.count || 0);

    const checkinCount = await db.select({ count: count() }).from(checkinsTable)
      .where(and(
        inArray(checkinsTable.eventId, eventIdList),
        eq(checkinsTable.checkedIn, true),
      ));
    checkedInToday = checkinCount[0]?.count || 0;
  }

  let ridersCount = { count: 0 };
  if (eventIdList.length > 0) {
    const [row] = await db.select({ count: countDistinct(registrationsTable.riderId) })
      .from(registrationsTable)
      .where(inArray(registrationsTable.eventId, eventIdList));
    ridersCount = { count: Number(row?.count || 0) };
  }

  const upcomingEvents = await db.select({
    id: eventsTable.id,
    clubId: eventsTable.clubId,
    name: eventsTable.name,
    date: eventsTable.date,
    state: eventsTable.state,
    location: eventsTable.location,
    trackName: eventsTable.trackName,
    raceClasses: eventsTable.raceClasses,
    registrationOpen: eventsTable.registrationOpen,
    registrationClose: eventsTable.registrationClose,
    status: eventsTable.status,
    paymentEnabled: eventsTable.paymentEnabled,
    entryFee: eventsTable.entryFee,
    maxRiders: eventsTable.maxRiders,
    endDate: eventsTable.endDate,
    createdAt: eventsTable.createdAt,
  }).from(eventsTable)
    .where(and(eq(eventsTable.clubId, clubId), sql`${eventsTable.status} != 'completed'`))
    .orderBy(eventsTable.date)
    .limit(5);

  // Real recent activity: last 10 registrations + check-ins across club events
  let recentActivity: { type: string; description: string; timestamp: string }[] = [];
  if (eventIdList.length > 0) {
    const recentRegs = await db
      .select({
        id: registrationsTable.id,
        raceClass: registrationsTable.raceClass,
        createdAt: registrationsTable.createdAt,
        firstName: ridersTable.firstName,
        lastName: ridersTable.lastName,
        eventName: eventsTable.name,
      })
      .from(registrationsTable)
      .innerJoin(ridersTable, eq(registrationsTable.riderId, ridersTable.id))
      .innerJoin(eventsTable, eq(registrationsTable.eventId, eventsTable.id))
      .where(inArray(registrationsTable.eventId, eventIdList))
      .orderBy(desc(registrationsTable.createdAt))
      .limit(10);

    const recentCheckins = await db
      .select({
        id: checkinsTable.id,
        raceClass: checkinsTable.raceClass,
        checkedInAt: checkinsTable.checkedInAt,
        firstName: ridersTable.firstName,
        lastName: ridersTable.lastName,
        eventName: eventsTable.name,
      })
      .from(checkinsTable)
      .innerJoin(ridersTable, eq(checkinsTable.riderId, ridersTable.id))
      .innerJoin(eventsTable, eq(checkinsTable.eventId, eventsTable.id))
      .where(and(inArray(checkinsTable.eventId, eventIdList), eq(checkinsTable.checkedIn, true)))
      .orderBy(desc(checkinsTable.checkedInAt))
      .limit(10);

    const activityItems = [
      ...recentRegs.map(r => ({
        type: "registration" as const,
        description: `${r.firstName} ${r.lastName} registered for ${r.eventName} — ${r.raceClass}`,
        timestamp: r.createdAt.toISOString(),
      })),
      ...recentCheckins.map(c => ({
        type: "checkin" as const,
        description: `${c.firstName} ${c.lastName} checked in at ${c.eventName} — ${c.raceClass}`,
        timestamp: c.checkedInAt ? c.checkedInAt.toISOString() : new Date().toISOString(),
      })),
    ];
    recentActivity = activityItems
      .sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime())
      .slice(0, 10);
  }

  return res.json({
    totalEvents: eventsCount.count,
    upcomingEvents: upcomingCount.count,
    totalRiders: ridersCount.count,
    totalRegistrations,
    uniqueRegistrations,
    checkedInToday,
    recentActivity,
    upcomingEventList: upcomingEvents.map(e => ({
      ...e,
      entryFee: e.entryFee ? Number(e.entryFee) : null,
      createdAt: e.createdAt.toISOString(),
      clubName: null,
    })),
  });
});

router.get("/events/:eventId/raceday-summary", async (req, res) => {
  const eventId = Number(req.params.eventId);
  const events = await db.select().from(eventsTable).where(eq(eventsTable.id, eventId));
  if (!events[0]) return res.status(404).json({ error: "Not found" });

  const [regCount] = await db.select({ count: count() }).from(registrationsTable).where(and(eq(registrationsTable.eventId, eventId), ne(registrationsTable.status, "void")));
  // Count registrations (not checkin rows) whose rider is checked in — so multi-class
  // riders (1 checkin row, N registration rows) are counted once per class entry.
  const [checkedInCount] = await db.select({ count: count() })
    .from(registrationsTable)
    .innerJoin(checkinsTable, and(
      eq(checkinsTable.riderId, registrationsTable.riderId),
      eq(checkinsTable.eventId, registrationsTable.eventId),
    ))
    .where(and(
      eq(registrationsTable.eventId, eventId),
      ne(registrationsTable.status, "void"),
      eq(checkinsTable.checkedIn, true),
    ));
  const [rfidCount] = await db.select({ count: count() }).from(checkinsTable).where(and(eq(checkinsTable.eventId, eventId), eq(checkinsTable.rfidLinked, true)));
  const [uniqueRegCount] = await db.select({ count: countDistinct(registrationsTable.riderId) }).from(registrationsTable).where(and(eq(registrationsTable.eventId, eventId), ne(registrationsTable.status, "void")));
  const [uniqueCheckinCount] = await db.select({ count: countDistinct(checkinsTable.riderId) }).from(checkinsTable).where(and(eq(checkinsTable.eventId, eventId), eq(checkinsTable.checkedIn, true)));
  const [motosTotal] = await db.select({ count: count() }).from(motosTable).where(eq(motosTable.eventId, eventId));
  const [motosCompleted] = await db.select({ count: count() }).from(motosTable).where(and(eq(motosTable.eventId, eventId), eq(motosTable.status, "completed")));

  const total = regCount.count;
  const checkedIn = checkedInCount.count;

  // Class summary
  const classData = await db.select({
    raceClass: registrationsTable.raceClass,
    total: count(),
  }).from(registrationsTable).where(eq(registrationsTable.eventId, eventId))
    .groupBy(registrationsTable.raceClass);

  const classSummary = await Promise.all(classData.map(async (cls) => {
    // Join registrations → checkins so multi-class riders count once per class.
    const [checkinCls] = await db.select({ count: count() })
      .from(registrationsTable)
      .innerJoin(checkinsTable, and(
        eq(checkinsTable.riderId, registrationsTable.riderId),
        eq(checkinsTable.eventId, registrationsTable.eventId),
      ))
      .where(and(
        eq(registrationsTable.eventId, eventId),
        eq(registrationsTable.raceClass, cls.raceClass),
        ne(registrationsTable.status, "void"),
        eq(checkinsTable.checkedIn, true),
      ));
    return {
      className: cls.raceClass,
      registered: cls.total,
      checkedIn: checkinCls.count,
    };
  }));

  // Payment summary — aggregate by method; NULL method treated as "card"
  const paymentRows = await db.select({
    paymentMethod: sql<string>`COALESCE(${registrationsTable.paymentMethod}, 'card')`,
    total: sql<string>`COALESCE(SUM(${registrationsTable.amountPaid}), 0)`,
    cnt: count(),
  }).from(registrationsTable)
    .where(and(eq(registrationsTable.eventId, eventId), eq(registrationsTable.paymentStatus, "paid")))
    .groupBy(sql`COALESCE(${registrationsTable.paymentMethod}, 'card')`);

  let cardTotal = 0, cashTotal = 0, cardCount = 0, cashCount = 0;
  for (const row of paymentRows) {
    if (row.paymentMethod === "card") { cardTotal = Number(row.total); cardCount = row.cnt; }
    else if (row.paymentMethod === "cash") { cashTotal = Number(row.total); cashCount = row.cnt; }
  }

  return res.json({
    eventId,
    eventName: events[0].name,
    totalRegistered: total,
    checkedIn,
    notCheckedIn: total - checkedIn,
    uniqueRegistrants: uniqueRegCount.count,
    uniqueCheckedIn: uniqueCheckinCount.count,
    rfidLinked: rfidCount.count,
    motosScheduled: motosTotal.count,
    motosCompleted: motosCompleted.count,
    classSummary,
    paymentSummary: {
      cardTotal,
      cashTotal,
      totalCollected: cardTotal + cashTotal,
      cardCount,
      cashCount,
    },
  });
});

router.get("/public/states", async (req, res) => {
  const stateData = await db.select({
    state: eventsTable.state,
    count: count(),
  }).from(eventsTable)
    .where(eq(eventsTable.status, 'completed'))
    .groupBy(eventsTable.state)
    .orderBy(eventsTable.state);

  return res.json(stateData.map(s => ({ state: s.state, eventCount: s.count })));
});

// ── Status auto-advancement helpers (mirrors events.ts) ──────────────────────
function _computeAutoStatus(event: { id: number; date: string; status: string; registrationOpen: string | null; registrationClose: string | null }): string | null {
  const now = new Date();
  const { status, registrationOpen, registrationClose } = event;
  if (status === "draft") {
    if (registrationOpen && now >= new Date(registrationOpen)) return "registration_open";
  }
  if (status === "registration_open") {
    if (registrationClose && now >= new Date(registrationClose)) return "registration_closed";
  }
  if (status === "registration_closed") {
    const todayStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
    const eventDateStr = event.date ? String(event.date).substring(0, 10) : null;
    if (eventDateStr && eventDateStr <= todayStr) return "race_day";
  }
  return null;
}

async function _advanceStatuses(events: Array<{ id: number; date: string; status: string; registrationOpen: string | null; registrationClose: string | null }>): Promise<Map<number, string>> {
  const updates = new Map<number, string>();
  for (const e of events) {
    const next = _computeAutoStatus(e);
    if (next) updates.set(e.id, next);
  }
  if (updates.size > 0) {
    await Promise.all(
      [...updates.entries()].map(([id, status]) =>
        db.update(eventsTable).set({ status }).where(eq(eventsTable.id, id))
      )
    );
  }
  return updates;
}

router.get("/public/upcoming", async (req, res) => {
  // Fetch including registration window fields needed for status auto-advancement.
  const events = await db.select({
    id: eventsTable.id,
    name: eventsTable.name,
    state: eventsTable.state,
    date: eventsTable.date,
    endDate: eventsTable.endDate,
    location: eventsTable.location,
    trackName: eventsTable.trackName,
    status: eventsTable.status,
    registrationOpen: eventsTable.registrationOpen,
    registrationClose: eventsTable.registrationClose,
    clubName: clubsTable.name,
  }).from(eventsTable)
    .leftJoin(clubsTable, eq(eventsTable.clubId, clubsTable.id))
    .where(and(
      // Include draft events too so we can advance their status below; filter
      // them back out after advancement.
      sql`${eventsTable.status} != 'completed'`,
      // Exclude events whose race day has already passed — even if the
      // organizer hasn't finalized/published the event yet.  Use endDate
      // when set (multi-day events) so they show until the last day.
      // SUBSTRING(...,1,10) guards against dates stored as full ISO timestamps
      // (e.g. "2026-06-23T18:00:00.000Z") vs plain "YYYY-MM-DD" strings.
      sql`SUBSTRING(COALESCE(${eventsTable.endDate}, ${eventsTable.date}), 1, 10) >= to_char(CURRENT_DATE, 'YYYY-MM-DD')`,
    ))
    .orderBy(eventsTable.date);

  // Advance statuses (draft→registration_open→registration_closed→race_day)
  // so the public page always reflects the current registration window state.
  const advanced = await _advanceStatuses(events);

  return res.json(
    events
      // Apply any status advances computed above, then filter out drafts.
      .map(e => ({ ...e, status: advanced.get(e.id) ?? e.status }))
      .filter(e => e.status !== "draft")
      .map(e => ({
        eventId: e.id,
        name: e.name,
        state: (e.state ?? "").trim(),
        date: e.date,
        endDate: e.endDate ?? null,
        location: e.location,
        trackName: e.trackName,
        status: e.status,
        clubName: e.clubName || "",
      }))
  );
});

router.get("/public/recent-results", async (req, res) => {
  const { state, limit = "10" } = req.query;
  const baseCondition = eq(eventsTable.status, 'completed');
  const events = await db.select({
    id: eventsTable.id,
    name: eventsTable.name,
    state: eventsTable.state,
    date: eventsTable.date,
    location: eventsTable.location,
    trackName: eventsTable.trackName,
    clubName: clubsTable.name,
  }).from(eventsTable)
    .leftJoin(clubsTable, eq(eventsTable.clubId, clubsTable.id))
    .where(state ? and(baseCondition, eq(eventsTable.state, String(state))) : baseCondition)
    .orderBy(desc(eventsTable.date))
    .limit(Number(limit));

  const results = [];
  for (const e of events) {
    const topResult = await db.select({
      riderid: raceResultsTable.riderId,
      raceClass: raceResultsTable.raceClass,
      firstName: ridersTable.firstName,
      lastName: ridersTable.lastName,
    }).from(raceResultsTable)
      .leftJoin(ridersTable, eq(raceResultsTable.riderId, ridersTable.id))
      .where(and(eq(raceResultsTable.eventId, e.id), eq(raceResultsTable.position, 1)))
      .limit(1);

    results.push({
      eventId: e.id,
      eventName: e.name,
      state: e.state,
      date: e.date,
      location: e.location || "",
      trackName: e.trackName || "",
      clubName: e.clubName || "",
      topRider: topResult[0] ? `${topResult[0].firstName} ${topResult[0].lastName}` : "TBD",
      raceClass: topResult[0]?.raceClass || "All Classes",
    });
  }

  return res.json(results);
});

router.get("/reports/event/:eventId", async (req, res) => {
  const eventId = Number(req.params.eventId);
  const events = await db.select().from(eventsTable).where(eq(eventsTable.id, eventId));
  if (!events[0]) return res.status(404).json({ error: "Not found" });

  const [regCount] = await db.select({ count: count() }).from(registrationsTable).where(eq(registrationsTable.eventId, eventId));
  const [checkinCount] = await db.select({ count: count() }).from(checkinsTable).where(and(eq(checkinsTable.eventId, eventId), eq(checkinsTable.checkedIn, true)));
  const [rfidCount] = await db.select({ count: count() }).from(checkinsTable).where(and(eq(checkinsTable.eventId, eventId), eq(checkinsTable.rfidLinked, true)));

  return res.json({
    eventId,
    eventName: events[0].name,
    type: "summary",
    generatedAt: new Date().toISOString(),
    data: {
      totalRegistrations: regCount.count,
      totalCheckedIn: checkinCount.count,
      rfidLinked: rfidCount.count,
      noShow: regCount.count - checkinCount.count,
    },
  });
});

// ─── Public Race Results browser ─────────────────────────────────────────────

// GET /public/events/browse — live (race_day) + completed events, optional text search
router.get("/public/events/browse", async (req, res) => {
  const q = String(req.query.q ?? "").trim().toLowerCase();

  const events = await db.select({
    id: eventsTable.id,
    name: eventsTable.name,
    state: eventsTable.state,
    date: eventsTable.date,
    endDate: eventsTable.endDate,
    location: eventsTable.location,
    trackName: eventsTable.trackName,
    status: eventsTable.status,
    clubName: clubsTable.name,
  }).from(eventsTable)
    .leftJoin(clubsTable, eq(eventsTable.clubId, clubsTable.id))
    .where(inArray(eventsTable.status, ["race_day", "completed"]))
    .orderBy(desc(eventsTable.date));

  const out = events
    .filter(e =>
      !q ||
      (e.name ?? "").toLowerCase().includes(q) ||
      (e.state ?? "").toLowerCase().includes(q) ||
      (e.location ?? "").toLowerCase().includes(q) ||
      (e.trackName ?? "").toLowerCase().includes(q) ||
      (e.clubName ?? "").toLowerCase().includes(q)
    )
    .map(e => ({
      eventId: e.id,
      name: e.name ?? "",
      state: (e.state ?? "").trim(),
      date: e.date ?? "",
      endDate: e.endDate ?? null,
      location: e.location ?? "",
      trackName: e.trackName ?? "",
      status: e.status,
      clubName: e.clubName ?? "",
    }));

  return res.json(out);
});

// GET /public/events/:eventId/schedule — event schedule with motos for public viewing
router.get("/public/events/:eventId/schedule", async (req, res) => {
  const eventId = Number(req.params.eventId);
  if (isNaN(eventId)) return res.status(400).json({ error: "Invalid event ID" });

  const [event] = await db.select({
    id: eventsTable.id,
    name: eventsTable.name,
    state: eventsTable.state,
    date: eventsTable.date,
    endDate: eventsTable.endDate,
    location: eventsTable.location,
    trackName: eventsTable.trackName,
    status: eventsTable.status,
    raceStyle: eventsTable.raceStyle,
  }).from(eventsTable)
    .where(and(
      eq(eventsTable.id, eventId),
      ne(eventsTable.status, "draft"),
    ));

  if (!event) return res.status(404).json({ error: "Event not found" });

  const motos = await db.select().from(motosTable)
    .where(eq(motosTable.eventId, eventId))
    .orderBy(asc(motosTable.motoNumber));

  return res.json({
    eventId: event.id,
    name: event.name ?? "",
    state: (event.state ?? "").trim(),
    date: event.date ?? "",
    endDate: event.endDate ?? null,
    location: event.location ?? "",
    trackName: event.trackName ?? "",
    status: event.status,
    raceStyle: event.raceStyle ?? "motocross",
    motos: motos
      .filter(m => m.type !== "practice")
      .map(m => ({
        motoId: m.id,
        motoNumber: m.motoNumber,
        name: m.name,
        raceClass: m.raceClass ?? null,
        status: m.status,
        type: m.type ?? "heat",
        scheduledTime: m.scheduledTime ?? null,
        startedAt: m.startedAt?.toISOString() ?? null,
        completedAt: m.completedAt?.toISOString() ?? null,
        lineup: ((Array.isArray(m.lineup) ? m.lineup : []) as Array<{ position: number; riderName: string; bibNumber?: string | null }>)
          .sort((a, b) => a.position - b.position)
          .map(e => ({ gate: e.position, riderName: e.riderName, bibNumber: e.bibNumber ?? null })),
      })),
  });
});

// GET /public/motos/:motoId/detail — public moto detail (leaderboard + lineup, no auth)
router.get("/public/motos/:motoId/detail", async (req, res) => {
  const motoId = Number(req.params.motoId);
  if (isNaN(motoId)) return res.status(400).json({ error: "Invalid moto ID" });

  const snapshot = await buildLeaderboard(motoId);
  if (!snapshot) return res.status(404).json({ error: "Moto not found" });

  const [moto] = await db.select({ lineup: motosTable.lineup }).from(motosTable).where(eq(motosTable.id, motoId));
  const rawLineup = (Array.isArray(moto?.lineup) ? moto.lineup : []) as Array<{
    position: number; riderName: string; bibNumber?: string | null;
  }>;
  const lineup = rawLineup
    .sort((a, b) => a.position - b.position)
    .map(e => ({ gate: e.position, riderName: e.riderName, bibNumber: e.bibNumber ?? null }));

  return res.json({ ...snapshot, lineup });
});

export default router;
