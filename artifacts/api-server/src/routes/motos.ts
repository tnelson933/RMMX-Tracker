import { Router } from "express";
import { db } from "@workspace/db";
import { motosTable, checkinsTable, ridersTable } from "@workspace/db";
import { eq, and } from "drizzle-orm";

const POINTS_BY_POSITION = [25, 22, 20, 18, 16, 15, 14, 13, 12, 11, 10, 9, 8, 7, 6, 5, 4, 3, 2, 1];

const router = Router();

router.get("/events/:eventId/motos", async (req, res) => {
  const eventId = Number(req.params.eventId);
  const motos = await db.select().from(motosTable).where(eq(motosTable.eventId, eventId)).orderBy(motosTable.motoNumber);
  return res.json(motos.map(m => ({
    ...m,
    lineup: Array.isArray(m.lineup) ? m.lineup : [],
    createdAt: m.createdAt.toISOString(),
  })));
});

router.post("/events/:eventId/motos", async (req, res) => {
  const eventId = Number(req.params.eventId);
  const { name, type, raceClass, motoNumber, scheduledTime, lineup } = req.body;
  if (!name || !type || !raceClass || motoNumber === undefined) return res.status(400).json({ error: "name, type, raceClass, motoNumber required" });

  const [moto] = await db.insert(motosTable).values({
    eventId, name, type, raceClass, motoNumber, scheduledTime, lineup: lineup || [], status: "scheduled",
  }).returning();

  return res.status(201).json({ ...moto, lineup: Array.isArray(moto.lineup) ? moto.lineup : [], createdAt: moto.createdAt.toISOString() });
});

router.patch("/motos/:motoId", async (req, res) => {
  const id = Number(req.params.motoId);
  const updates: Record<string, unknown> = {};
  if (req.body.status !== undefined) updates.status = req.body.status;
  if (req.body.lineup !== undefined) updates.lineup = req.body.lineup;
  if (req.body.scheduledTime !== undefined) updates.scheduledTime = req.body.scheduledTime;

  const [moto] = await db.update(motosTable).set(updates as any).where(eq(motosTable.id, id)).returning();
  if (!moto) return res.status(404).json({ error: "Not found" });
  return res.json({ ...moto, lineup: Array.isArray(moto.lineup) ? moto.lineup : [], createdAt: moto.createdAt.toISOString() });
});

router.post("/events/:eventId/generate-lineups", async (req, res) => {
  const eventId = Number(req.params.eventId);
  const { raceFormat, classes, ridersPerHeat = 8 } = req.body;

  const checkins = await db.select({
    riderId: checkinsTable.riderId,
    raceClass: checkinsTable.raceClass,
    bibNumber: checkinsTable.bibNumber,
    rfidNumber: checkinsTable.rfidNumber,
    firstName: ridersTable.firstName,
    lastName: ridersTable.lastName,
  }).from(checkinsTable)
    .leftJoin(ridersTable, eq(checkinsTable.riderId, ridersTable.id))
    .where(and(eq(checkinsTable.eventId, eventId), eq(checkinsTable.checkedIn, true)));

  const motos: typeof motosTable.$inferSelect[] = [];
  let motoNumber = 1;

  const motoCount = raceFormat === "three_moto" ? 3 : raceFormat === "two_moto" ? 2 : 1;

  for (const cls of (classes || [])) {
    const classRiders = checkins.filter(c => c.raceClass === cls);
    if (classRiders.length === 0) continue;

    for (let m = 1; m <= motoCount; m++) {
      const lineup = classRiders.map((r, i) => ({
        position: i + 1,
        riderId: r.riderId,
        riderName: `${r.firstName} ${r.lastName}`,
        bibNumber: r.bibNumber,
        rfidNumber: r.rfidNumber,
      }));

      const [moto] = await db.insert(motosTable).values({
        eventId,
        name: `${cls} Moto ${m}`,
        type: m === motoCount && motoCount > 1 ? "main" : "heat",
        raceClass: cls,
        motoNumber: motoNumber++,
        status: "scheduled",
        lineup,
      }).returning();
      motos.push(moto);
    }
  }

  return res.json(motos.map(m => ({ ...m, lineup: Array.isArray(m.lineup) ? m.lineup : [], createdAt: m.createdAt.toISOString() })));
});

export default router;
