import { Router } from "express";
import { db } from "@workspace/db";
import { ridersTable, raceResultsTable, motosTable, eventsTable, registrationsTable } from "@workspace/db";
import { eq, ilike, or, desc, and, inArray } from "drizzle-orm";

const router = Router();

function getStaffClubId(res: any): number | null {
  const v = res.locals?.staffClubId;
  return typeof v === "number" ? v : null;
}

async function getClubRiderIds(clubId: number): Promise<number[]> {
  const events = await db.select({ id: eventsTable.id }).from(eventsTable).where(eq(eventsTable.clubId, clubId));
  if (events.length === 0) return [];
  const regs = await db.selectDistinct({ riderId: registrationsTable.riderId }).from(registrationsTable)
    .where(inArray(registrationsTable.eventId, events.map(e => e.id)));
  return regs.map(r => r.riderId).filter((id): id is number => id !== null);
}

router.get("/riders", async (req, res) => {
  const { search } = req.query;
  const staffCId = getStaffClubId(res);

  let riders;
  if (staffCId !== null) {
    const riderIds = await getClubRiderIds(staffCId);
    if (riderIds.length === 0) return res.json([]);
    const cond = search
      ? and(
          inArray(ridersTable.id, riderIds),
          or(
            ilike(ridersTable.firstName, `%${String(search)}%`),
            ilike(ridersTable.lastName, `%${String(search)}%`),
            ilike(ridersTable.bibNumber, `%${String(search)}%`)
          )
        )
      : inArray(ridersTable.id, riderIds);
    riders = await db.select().from(ridersTable).where(cond).orderBy(ridersTable.lastName);
  } else if (search) {
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
  const { firstName, lastName, email, phone, bibNumber, dateOfBirth, emergencyContact, emergencyPhone, rfidNumber, bikeManufacturer, sponsors, amaNumber, mylapsTransponderId, hometown, homeState } = req.body;
  if (!firstName || !lastName) return res.status(400).json({ error: "firstName and lastName required" });
  const [rider] = await db.insert(ridersTable).values({ firstName, lastName, email, phone, bibNumber, dateOfBirth, emergencyContact, emergencyPhone, rfidNumber, bikeManufacturer, sponsors, amaNumber, mylapsTransponderId, hometown, homeState }).returning();
  return res.status(201).json({ ...rider, createdAt: rider.createdAt.toISOString() });
});

router.get("/riders/:riderId", async (req, res) => {
  const id = Number(req.params.riderId);
  const riders = await db.select().from(ridersTable).where(eq(ridersTable.id, id));
  if (!riders[0]) return res.status(404).json({ error: "Not found" });
  const rider = riders[0];

  const staffCId = getStaffClubId(res);
  if (staffCId !== null) {
    const riderIds = await getClubRiderIds(staffCId);
    if (!riderIds.includes(id)) return res.status(403).json({ error: "Forbidden" });
  }

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

  const [latestClubId] = await db
    .select({ clubIdNumber: registrationsTable.clubIdNumber })
    .from(registrationsTable)
    .where(eq(registrationsTable.riderId, id) as any)
    .orderBy(desc(registrationsTable.createdAt))
    .limit(1);

  return res.json({
    ...rider,
    createdAt: rider.createdAt.toISOString(),
    clubIdNumber: latestClubId?.clubIdNumber ?? null,
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

  const staffCId = getStaffClubId(res);
  if (staffCId !== null) {
    const riderIds = await getClubRiderIds(staffCId);
    if (!riderIds.includes(id)) return res.status(403).json({ error: "Forbidden" });
  }

  const fields = ["firstName", "lastName", "email", "phone", "bibNumber", "dateOfBirth", "emergencyContact", "emergencyPhone", "rfidNumber", "bikeManufacturer", "sponsors", "amaNumber", "mylapsTransponderId", "hometown", "homeState"];
  const updates: Record<string, unknown> = {};
  for (const f of fields) {
    if (req.body[f] !== undefined) updates[f] = req.body[f];
  }
  const [rider] = await db.update(ridersTable).set(updates as any).where(eq(ridersTable.id, id)).returning();
  if (!rider) return res.status(404).json({ error: "Not found" });
  return res.json({ ...rider, createdAt: rider.createdAt.toISOString() });
});

export default router;
