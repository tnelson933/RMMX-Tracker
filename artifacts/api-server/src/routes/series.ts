import { Router } from "express";
import { db } from "@workspace/db";
import { seriesTable, seriesPointsTable, raceResultsTable, ridersTable } from "@workspace/db";
import { eq } from "drizzle-orm";

const router = Router();

router.get("/series", async (req, res) => {
  const series = await db.select().from(seriesTable).orderBy(seriesTable.name);
  return res.json(series.map(s => ({ ...s, createdAt: s.createdAt.toISOString() })));
});

router.post("/series", async (req, res) => {
  const { name, clubId, season, classes, pointsSystem, eventIds } = req.body;
  if (!name || !clubId || !season) return res.status(400).json({ error: "name, clubId, season required" });
  const [series] = await db.insert(seriesTable).values({ name, clubId, season, classes: classes || [], pointsSystem: pointsSystem || "standard", eventIds: eventIds || [] }).returning();
  return res.status(201).json({ ...series, createdAt: series.createdAt.toISOString() });
});

router.get("/series/:seriesId/leaderboard", async (req, res) => {
  const seriesId = Number(req.params.seriesId);
  const points = await db.select({
    id: seriesPointsTable.id,
    riderId: seriesPointsTable.riderId,
    raceClass: seriesPointsTable.raceClass,
    totalPoints: seriesPointsTable.totalPoints,
    eventsEntered: seriesPointsTable.eventsEntered,
    eventResults: seriesPointsTable.eventResults,
    firstName: ridersTable.firstName,
    lastName: ridersTable.lastName,
  }).from(seriesPointsTable)
    .leftJoin(ridersTable, eq(seriesPointsTable.riderId, ridersTable.id))
    .where(eq(seriesPointsTable.seriesId, seriesId))
    .orderBy(seriesPointsTable.totalPoints);

  const byClass: Record<string, typeof points> = {};
  for (const p of points) {
    if (!byClass[p.raceClass]) byClass[p.raceClass] = [];
    byClass[p.raceClass].push(p);
  }

  const standings: Array<{ position: number; riderId: number; riderName: string; raceClass: string; totalPoints: number; eventsEntered: number; eventResults: unknown[] }> = [];
  for (const [cls, riders] of Object.entries(byClass)) {
    const sorted = riders.sort((a, b) => b.totalPoints - a.totalPoints);
    sorted.forEach((r, i) => {
      standings.push({
        position: i + 1,
        riderId: r.riderId,
        riderName: `${r.firstName} ${r.lastName}`,
        raceClass: r.raceClass,
        totalPoints: r.totalPoints,
        eventsEntered: r.eventsEntered,
        eventResults: Array.isArray(r.eventResults) ? r.eventResults : [],
      });
    });
  }

  return res.json(standings);
});

router.post("/series/:seriesId/recalculate", async (req, res) => {
  const seriesId = Number(req.params.seriesId);
  const series = await db.select().from(seriesTable).where(eq(seriesTable.id, seriesId));
  if (!series[0]) return res.status(404).json({ error: "Not found" });

  const eventIds = series[0].eventIds as number[];

  // Delete existing points
  await db.delete(seriesPointsTable).where(eq(seriesPointsTable.seriesId, seriesId));

  // Aggregate results by rider+class across all events
  const pointsByRiderClass: Record<string, { riderId: number; raceClass: string; totalPoints: number; eventsEntered: number; eventResults: number[] }> = {};

  for (const eventId of eventIds) {
    const results = await db.select().from(raceResultsTable).where(eq(raceResultsTable.eventId, eventId));
    for (const r of results) {
      const key = `${r.riderId}-${r.raceClass}`;
      if (!pointsByRiderClass[key]) {
        pointsByRiderClass[key] = { riderId: r.riderId, raceClass: r.raceClass, totalPoints: 0, eventsEntered: 0, eventResults: [] };
      }
      pointsByRiderClass[key].totalPoints += r.points || 0;
      pointsByRiderClass[key].eventsEntered += 1;
      pointsByRiderClass[key].eventResults.push(r.points || 0);
    }
  }

  for (const data of Object.values(pointsByRiderClass)) {
    await db.insert(seriesPointsTable).values({ seriesId, ...data });
  }

  return res.json({ ok: true });
});

export default router;
