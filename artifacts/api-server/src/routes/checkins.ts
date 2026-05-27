import { Router } from "express";
import { db } from "@workspace/db";
import { checkinsTable, ridersTable, rfidAssignmentsTable } from "@workspace/db";
import { eq, and } from "drizzle-orm";

const router = Router();

router.get("/events/:eventId/checkins", async (req, res) => {
  const eventId = Number(req.params.eventId);
  const checkins = await db.select({
    id: checkinsTable.id,
    eventId: checkinsTable.eventId,
    riderId: checkinsTable.riderId,
    raceClass: checkinsTable.raceClass,
    bibNumber: checkinsTable.bibNumber,
    checkedIn: checkinsTable.checkedIn,
    checkedInAt: checkinsTable.checkedInAt,
    rfidNumber: checkinsTable.rfidNumber,
    rfidLinked: checkinsTable.rfidLinked,
    firstName: ridersTable.firstName,
    lastName: ridersTable.lastName,
  }).from(checkinsTable)
    .leftJoin(ridersTable, eq(checkinsTable.riderId, ridersTable.id))
    .where(eq(checkinsTable.eventId, eventId))
    .orderBy(ridersTable.lastName);

  return res.json(checkins.map(c => ({
    id: c.id,
    eventId: c.eventId,
    riderId: c.riderId,
    riderName: `${c.firstName} ${c.lastName}`,
    raceClass: c.raceClass,
    bibNumber: c.bibNumber,
    checkedIn: c.checkedIn,
    checkedInAt: c.checkedInAt?.toISOString() ?? null,
    rfidNumber: c.rfidNumber,
    rfidLinked: c.rfidLinked,
  })));
});

router.post("/events/:eventId/checkins", async (req, res) => {
  const eventId = Number(req.params.eventId);
  const { riderId, rfidNumber, bibNumber } = req.body;
  if (!riderId) return res.status(400).json({ error: "riderId required" });

  const existing = await db.select().from(checkinsTable)
    .where(and(eq(checkinsTable.eventId, eventId), eq(checkinsTable.riderId, riderId)));

  let checkin;
  if (existing[0]) {
    const updates: Record<string, unknown> = {
      checkedIn: true,
      checkedInAt: new Date(),
    };
    if (rfidNumber !== undefined) {
      updates.rfidNumber = rfidNumber;
      updates.rfidLinked = !!rfidNumber;
    }
    if (bibNumber !== undefined) updates.bibNumber = bibNumber;

    const [updated] = await db.update(checkinsTable).set(updates as any)
      .where(eq(checkinsTable.id, existing[0].id)).returning();
    checkin = updated;

    // Also update rider's rfid if provided
    if (rfidNumber) {
      await db.update(ridersTable).set({ rfidNumber }).where(eq(ridersTable.id, riderId));
    }
  } else {
    const [created] = await db.insert(checkinsTable).values({
      eventId, riderId,
      raceClass: "Unknown",
      bibNumber,
      checkedIn: true,
      checkedInAt: new Date(),
      rfidNumber,
      rfidLinked: !!rfidNumber,
    }).returning();
    checkin = created;
  }

  const riders = await db.select().from(ridersTable).where(eq(ridersTable.id, riderId));
  const rider = riders[0];

  return res.json({
    id: checkin.id,
    eventId: checkin.eventId,
    riderId: checkin.riderId,
    riderName: rider ? `${rider.firstName} ${rider.lastName}` : "",
    raceClass: checkin.raceClass,
    bibNumber: checkin.bibNumber,
    checkedIn: checkin.checkedIn,
    checkedInAt: checkin.checkedInAt?.toISOString() ?? null,
    rfidNumber: checkin.rfidNumber,
    rfidLinked: checkin.rfidLinked,
  });
});

export default router;
