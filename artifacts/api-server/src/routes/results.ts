import { Router } from "express";
import { db } from "@workspace/db";
import { raceResultsTable, motosTable, ridersTable, eventPublicationTable, registrationsTable } from "@workspace/db";
import { eq, and } from "drizzle-orm";

const POINTS_BY_POSITION = [25, 22, 20, 18, 16, 15, 14, 13, 12, 11, 10, 9, 8, 7, 6, 5, 4, 3, 2, 1];

const router = Router();

router.get("/events/:eventId/results", async (req, res) => {
  const eventId = Number(req.params.eventId);

  const results = await db.select({
    id: raceResultsTable.id,
    eventId: raceResultsTable.eventId,
    motoId: raceResultsTable.motoId,
    riderId: raceResultsTable.riderId,
    raceClass: raceResultsTable.raceClass,
    position: raceResultsTable.position,
    totalTime: raceResultsTable.totalTime,
    lapTimes: raceResultsTable.lapTimes,
    points: raceResultsTable.points,
    dnf: raceResultsTable.dnf,
    dns: raceResultsTable.dns,
    bibNumber: raceResultsTable.bibNumber,
    motoName: motosTable.name,
    firstName: ridersTable.firstName,
    lastName: ridersTable.lastName,
    amaNumber: registrationsTable.amaNumber,
    bikeBrand: registrationsTable.bikeBrand,
  }).from(raceResultsTable)
    .leftJoin(motosTable, eq(raceResultsTable.motoId, motosTable.id))
    .leftJoin(ridersTable, eq(raceResultsTable.riderId, ridersTable.id))
    .leftJoin(registrationsTable, and(
      eq(registrationsTable.riderId, raceResultsTable.riderId),
      eq(registrationsTable.eventId, raceResultsTable.eventId),
    ))
    .where(eq(raceResultsTable.eventId, eventId))
    .orderBy(raceResultsTable.position);

  return res.json(results.map(r => ({
    id: r.id,
    eventId: r.eventId,
    motoId: r.motoId,
    motoName: r.motoName || "",
    riderId: r.riderId,
    riderName: `${r.firstName} ${r.lastName}`,
    raceClass: r.raceClass,
    position: r.position,
    totalTime: r.totalTime,
    lapTimes: Array.isArray(r.lapTimes) ? r.lapTimes : [],
    points: r.points,
    dnf: r.dnf,
    dns: r.dns,
    bibNumber: r.bibNumber,
    amaNumber: r.amaNumber ?? null,
    bikeBrand: r.bikeBrand ?? null,
  })));
});

router.post("/events/:eventId/results", async (req, res) => {
  const eventId = Number(req.params.eventId);
  const { motoId, results: riderResults } = req.body;
  if (!motoId || !Array.isArray(riderResults)) return res.status(400).json({ error: "motoId and results[] required" });

  const moto = await db.select().from(motosTable).where(eq(motosTable.id, motoId));
  if (!moto[0]) return res.status(404).json({ error: "Moto not found" });
  const raceClass = moto[0].raceClass;

  // Delete existing results for this moto
  await db.delete(raceResultsTable).where(eq(raceResultsTable.motoId, motoId));

  const inserted = [];
  for (const r of riderResults) {
    const points = r.dnf || r.dns ? 0 : (POINTS_BY_POSITION[r.position - 1] || 0);
    const [result] = await db.insert(raceResultsTable).values({
      eventId, motoId, riderId: r.riderId, raceClass,
      position: r.position,
      totalTime: r.totalTime || null,
      lapTimes: r.lapTimes || [],
      points,
      dnf: r.dnf || false,
      dns: r.dns || false,
    }).returning();
    inserted.push(result);
  }

  // Mark moto as completed
  await db.update(motosTable).set({ status: "completed" }).where(eq(motosTable.id, motoId));

  return res.status(201).json(inserted.map(r => ({
    id: r.id,
    eventId: r.eventId,
    motoId: r.motoId,
    motoName: moto[0].name,
    riderId: r.riderId,
    riderName: "",
    raceClass: r.raceClass,
    position: r.position,
    totalTime: r.totalTime,
    lapTimes: Array.isArray(r.lapTimes) ? r.lapTimes : [],
    points: r.points,
    dnf: r.dnf,
    dns: r.dns,
    bibNumber: r.bibNumber,
  })));
});

router.post("/events/:eventId/results/publish", async (req, res) => {
  const eventId = Number(req.params.eventId);
  const { published } = req.body;

  const existing = await db.select().from(eventPublicationTable).where(eq(eventPublicationTable.eventId, eventId));
  if (existing[0]) {
    await db.update(eventPublicationTable).set({
      published,
      publishedAt: published ? new Date() : null,
      updatedAt: new Date(),
    }).where(eq(eventPublicationTable.eventId, eventId));
  } else {
    await db.insert(eventPublicationTable).values({ eventId, published, publishedAt: published ? new Date() : null });
  }

  return res.json({ ok: true, published });
});

export default router;
