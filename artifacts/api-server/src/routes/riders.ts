import { Router } from "express";
import { db } from "@workspace/db";
import { ridersTable, raceResultsTable, motosTable, eventsTable } from "@workspace/db";
import { eq, ilike, or } from "drizzle-orm";

const router = Router();

router.get("/riders", async (req, res) => {
  const { search } = req.query;
  let riders;
  if (search) {
    const s = `%${String(search)}%`;
    riders = await db.select().from(ridersTable).where(
      or(ilike(ridersTable.firstName, s), ilike(ridersTable.lastName, s), ilike(ridersTable.bibNumber, s))
    ).orderBy(ridersTable.lastName);
  } else {
    riders = await db.select().from(ridersTable).orderBy(ridersTable.lastName);
  }
  return res.json(riders.map(r => ({ ...r, createdAt: r.createdAt.toISOString() })));
});

router.post("/riders", async (req, res) => {
  const { firstName, lastName, email, phone, bibNumber, dateOfBirth, emergencyContact, emergencyPhone, rfidNumber } = req.body;
  if (!firstName || !lastName) return res.status(400).json({ error: "firstName and lastName required" });
  const [rider] = await db.insert(ridersTable).values({ firstName, lastName, email, phone, bibNumber, dateOfBirth, emergencyContact, emergencyPhone, rfidNumber }).returning();
  return res.status(201).json({ ...rider, createdAt: rider.createdAt.toISOString() });
});

router.get("/riders/:riderId", async (req, res) => {
  const id = Number(req.params.riderId);
  const riders = await db.select().from(ridersTable).where(eq(ridersTable.id, id));
  if (!riders[0]) return res.status(404).json({ error: "Not found" });
  const rider = riders[0];

  // Get recent results
  const recentResults = await db.select({
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
  }).from(raceResultsTable)
    .leftJoin(motosTable, eq(raceResultsTable.motoId, motosTable.id))
    .where(eq(raceResultsTable.riderId, id))
    .limit(10);

  return res.json({
    ...rider,
    createdAt: rider.createdAt.toISOString(),
    recentResults: recentResults.map(r => ({
      ...r,
      lapTimes: Array.isArray(r.lapTimes) ? r.lapTimes : [],
      motoName: r.motoName || "",
    })),
    totalEvents: recentResults.length,
  });
});

router.patch("/riders/:riderId", async (req, res) => {
  const id = Number(req.params.riderId);
  const fields = ["firstName", "lastName", "email", "phone", "bibNumber", "dateOfBirth", "emergencyContact", "emergencyPhone", "rfidNumber"];
  const updates: Record<string, unknown> = {};
  for (const f of fields) {
    if (req.body[f] !== undefined) updates[f] = req.body[f];
  }
  const [rider] = await db.update(ridersTable).set(updates as any).where(eq(ridersTable.id, id)).returning();
  if (!rider) return res.status(404).json({ error: "Not found" });
  return res.json({ ...rider, createdAt: rider.createdAt.toISOString() });
});

export default router;
