import { Router } from "express";
import { db } from "@workspace/db";
import { registrationsTable, ridersTable, checkinsTable } from "@workspace/db";
import { eq, and } from "drizzle-orm";

const router = Router();

router.get("/events/:eventId/registrations", async (req, res) => {
  const eventId = Number(req.params.eventId);
  const regs = await db.select({
    id: registrationsTable.id,
    eventId: registrationsTable.eventId,
    riderId: registrationsTable.riderId,
    raceClass: registrationsTable.raceClass,
    status: registrationsTable.status,
    paymentStatus: registrationsTable.paymentStatus,
    amountPaid: registrationsTable.amountPaid,
    bibNumber: registrationsTable.bibNumber,
    createdAt: registrationsTable.createdAt,
    firstName: ridersTable.firstName,
    lastName: ridersTable.lastName,
  }).from(registrationsTable)
    .leftJoin(ridersTable, eq(registrationsTable.riderId, ridersTable.id))
    .where(eq(registrationsTable.eventId, eventId))
    .orderBy(registrationsTable.createdAt);

  return res.json(regs.map(r => ({
    id: r.id,
    eventId: r.eventId,
    riderId: r.riderId,
    riderName: `${r.firstName} ${r.lastName}`,
    raceClass: r.raceClass,
    status: r.status,
    paymentStatus: r.paymentStatus,
    amountPaid: r.amountPaid ? Number(r.amountPaid) : null,
    bibNumber: r.bibNumber,
    createdAt: r.createdAt.toISOString(),
  })));
});

router.post("/events/:eventId/registrations", async (req, res) => {
  const eventId = Number(req.params.eventId);
  const { riderId, raceClass, bibNumber } = req.body;
  if (!riderId || !raceClass) return res.status(400).json({ error: "riderId and raceClass required" });

  const [reg] = await db.insert(registrationsTable).values({
    eventId, riderId, raceClass, bibNumber, status: "confirmed", paymentStatus: "unpaid",
  }).returning();

  // Auto-create checkin record
  await db.insert(checkinsTable).values({
    eventId, riderId, raceClass, bibNumber, checkedIn: false, rfidLinked: false,
  }).onConflictDoNothing();

  const riders = await db.select().from(ridersTable).where(eq(ridersTable.id, riderId));
  const rider = riders[0];

  return res.status(201).json({
    ...reg,
    riderName: rider ? `${rider.firstName} ${rider.lastName}` : "",
    amountPaid: null,
    createdAt: reg.createdAt.toISOString(),
  });
});

router.patch("/registrations/:registrationId", async (req, res) => {
  const id = Number(req.params.registrationId);
  const { status, paymentStatus, raceClass, bibNumber } = req.body;
  const updates: Record<string, unknown> = {};
  if (status !== undefined) updates.status = status;
  if (paymentStatus !== undefined) updates.paymentStatus = paymentStatus;
  if (raceClass !== undefined) updates.raceClass = raceClass;
  if (bibNumber !== undefined) updates.bibNumber = bibNumber;

  const [reg] = await db.update(registrationsTable).set(updates as any).where(eq(registrationsTable.id, id)).returning();
  if (!reg) return res.status(404).json({ error: "Not found" });

  const riders = await db.select().from(ridersTable).where(eq(ridersTable.id, reg.riderId));
  const rider = riders[0];
  return res.json({
    ...reg,
    riderName: rider ? `${rider.firstName} ${rider.lastName}` : "",
    amountPaid: reg.amountPaid ? Number(reg.amountPaid) : null,
    createdAt: reg.createdAt.toISOString(),
  });
});

export default router;
