import { Router } from "express";
import { db } from "@workspace/db";
import { rfidAssignmentsTable, ridersTable } from "@workspace/db";
import { eq } from "drizzle-orm";

const router = Router();

router.get("/rfid", async (req, res) => {
  const { eventId } = req.query;
  let assignments;
  if (eventId) {
    assignments = await db.select({
      id: rfidAssignmentsTable.id,
      riderId: rfidAssignmentsTable.riderId,
      rfidNumber: rfidAssignmentsTable.rfidNumber,
      eventId: rfidAssignmentsTable.eventId,
      assignedAt: rfidAssignmentsTable.assignedAt,
      firstName: ridersTable.firstName,
      lastName: ridersTable.lastName,
    }).from(rfidAssignmentsTable)
      .leftJoin(ridersTable, eq(rfidAssignmentsTable.riderId, ridersTable.id))
      .where(eq(rfidAssignmentsTable.eventId, Number(eventId)));
  } else {
    assignments = await db.select({
      id: rfidAssignmentsTable.id,
      riderId: rfidAssignmentsTable.riderId,
      rfidNumber: rfidAssignmentsTable.rfidNumber,
      eventId: rfidAssignmentsTable.eventId,
      assignedAt: rfidAssignmentsTable.assignedAt,
      firstName: ridersTable.firstName,
      lastName: ridersTable.lastName,
    }).from(rfidAssignmentsTable)
      .leftJoin(ridersTable, eq(rfidAssignmentsTable.riderId, ridersTable.id));
  }

  return res.json(assignments.map(a => ({
    id: a.id,
    riderId: a.riderId,
    riderName: `${a.firstName} ${a.lastName}`,
    rfidNumber: a.rfidNumber,
    eventId: a.eventId,
    assignedAt: a.assignedAt.toISOString(),
  })));
});

router.post("/rfid", async (req, res) => {
  const { riderId, rfidNumber, eventId } = req.body;
  if (!riderId || !rfidNumber) return res.status(400).json({ error: "riderId and rfidNumber required" });

  const [assignment] = await db.insert(rfidAssignmentsTable).values({ riderId, rfidNumber, eventId }).returning();

  // Also update rider's primary rfid
  await db.update(ridersTable).set({ rfidNumber }).where(eq(ridersTable.id, riderId));

  const riders = await db.select().from(ridersTable).where(eq(ridersTable.id, riderId));
  const rider = riders[0];

  return res.status(201).json({
    id: assignment.id,
    riderId: assignment.riderId,
    riderName: rider ? `${rider.firstName} ${rider.lastName}` : "",
    rfidNumber: assignment.rfidNumber,
    eventId: assignment.eventId,
    assignedAt: assignment.assignedAt.toISOString(),
  });
});

export default router;
