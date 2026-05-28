import { Router } from "express";
import { db } from "@workspace/db";
import { clubsTable, eventsTable, ridersTable, registrationsTable, checkinsTable, motosTable, raceResultsTable, eventPublicationTable } from "@workspace/db";
import { eq, and, count, sql, inArray, desc } from "drizzle-orm";

const router = Router();

router.get("/dashboard/club/:clubId", async (req, res) => {
  const clubId = Number(req.params.clubId);

  const [eventsCount] = await db.select({ count: count() }).from(eventsTable).where(eq(eventsTable.clubId, clubId));
  const [upcomingCount] = await db.select({ count: count() }).from(eventsTable).where(
    and(eq(eventsTable.clubId, clubId), sql`${eventsTable.status} IN ('draft','registration_open','registration_closed','race_day')`)
  );

  const clubEvents = await db.select({ id: eventsTable.id }).from(eventsTable).where(eq(eventsTable.clubId, clubId));
  const eventIdList = clubEvents.map(e => e.id);

  let totalRegistrations = 0;
  let checkedInToday = 0;
  if (eventIdList.length > 0) {
    const regCount = await db.select({ count: count() }).from(registrationsTable)
      .where(inArray(registrationsTable.eventId, eventIdList));
    totalRegistrations = regCount[0]?.count || 0;

    const checkinCount = await db.select({ count: count() }).from(checkinsTable)
      .where(and(
        inArray(checkinsTable.eventId, eventIdList),
        eq(checkinsTable.checkedIn, true),
      ));
    checkedInToday = checkinCount[0]?.count || 0;
  }

  const [ridersCount] = await db.select({ count: count() }).from(ridersTable);

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

  const [regCount] = await db.select({ count: count() }).from(registrationsTable).where(eq(registrationsTable.eventId, eventId));
  const [checkedInCount] = await db.select({ count: count() }).from(checkinsTable).where(and(eq(checkinsTable.eventId, eventId), eq(checkinsTable.checkedIn, true)));
  const [rfidCount] = await db.select({ count: count() }).from(checkinsTable).where(and(eq(checkinsTable.eventId, eventId), eq(checkinsTable.rfidLinked, true)));
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
    const [checkinCls] = await db.select({ count: count() }).from(checkinsTable)
      .where(and(eq(checkinsTable.eventId, eventId), eq(checkinsTable.raceClass, cls.raceClass), eq(checkinsTable.checkedIn, true)));
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
    .leftJoin(eventPublicationTable, eq(eventsTable.id, eventPublicationTable.eventId))
    .where(sql`${eventPublicationTable.published} = true OR ${eventsTable.status} != 'draft'`)
    .groupBy(eventsTable.state)
    .orderBy(eventsTable.state);

  return res.json(stateData.map(s => ({ state: s.state, eventCount: s.count })));
});

router.get("/public/recent-results", async (req, res) => {
  const { state, limit = "10" } = req.query;
  let query = db.select({
    id: eventsTable.id,
    name: eventsTable.name,
    state: eventsTable.state,
    date: eventsTable.date,
    clubName: clubsTable.name,
  }).from(eventsTable)
    .leftJoin(eventPublicationTable, eq(eventsTable.id, eventPublicationTable.eventId))
    .leftJoin(clubsTable, eq(eventsTable.clubId, clubsTable.id))
    .where(eq(eventPublicationTable.published, true))
    .orderBy(eventsTable.date)
    .limit(Number(limit));

  const events = await (state
    ? db.select({
        id: eventsTable.id,
        name: eventsTable.name,
        state: eventsTable.state,
        date: eventsTable.date,
        clubName: clubsTable.name,
      }).from(eventsTable)
        .leftJoin(eventPublicationTable, eq(eventsTable.id, eventPublicationTable.eventId))
        .leftJoin(clubsTable, eq(eventsTable.clubId, clubsTable.id))
        .where(and(eq(eventPublicationTable.published, true), eq(eventsTable.state, String(state))))
        .orderBy(eventsTable.date)
        .limit(Number(limit))
    : query);

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

export default router;
