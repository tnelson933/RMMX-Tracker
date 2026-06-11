import { Router } from "express";
import { db } from "@workspace/db";
import { rfidAssignmentsTable, ridersTable, checkinsTable, eventsTable, practiceCrossingsTable } from "@workspace/db";
import { eq, and, inArray, isNull } from "drizzle-orm";

const router = Router();

function getStaffClubId(res: any): number | null {
  const v = res.locals?.staffClubId;
  return typeof v === "number" ? v : null;
}

router.get("/rfid", async (req, res) => {
  const { eventId } = req.query;
  const numEventId = eventId ? parseInt(String(eventId), 10) : null;
  if (eventId && (numEventId === null || isNaN(numEventId))) {
    return res.status(400).json({ error: "Invalid eventId" });
  }
  const staffCId = getStaffClubId(res);
  // Staff: verify the requested event belongs to their club
  if (staffCId !== null && numEventId) {
    const [evt] = await db.select({ clubId: eventsTable.clubId }).from(eventsTable).where(eq(eventsTable.id, numEventId));
    if (!evt || evt.clubId !== staffCId) return res.status(403).json({ error: "Forbidden" });
  }
  let assignments;
  if (numEventId) {
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
      .where(eq(rfidAssignmentsTable.eventId, numEventId));
  } else if (staffCId !== null) {
    // Staff with no eventId filter — scope to their club's events only
    const clubEvents = await db.select({ id: eventsTable.id }).from(eventsTable).where(eq(eventsTable.clubId, staffCId));
    const clubEventIds = clubEvents.map(e => e.id);
    assignments = clubEventIds.length > 0
      ? await db.select({
          id: rfidAssignmentsTable.id,
          riderId: rfidAssignmentsTable.riderId,
          rfidNumber: rfidAssignmentsTable.rfidNumber,
          eventId: rfidAssignmentsTable.eventId,
          assignedAt: rfidAssignmentsTable.assignedAt,
          firstName: ridersTable.firstName,
          lastName: ridersTable.lastName,
        }).from(rfidAssignmentsTable)
          .leftJoin(ridersTable, eq(rfidAssignmentsTable.riderId, ridersTable.id))
          .where(inArray(rfidAssignmentsTable.eventId, clubEventIds))
      : [];
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

  const numRiderId = parseInt(String(riderId), 10);
  if (isNaN(numRiderId)) return res.status(400).json({ error: "Invalid riderId" });
  const numEventId = eventId != null ? parseInt(String(eventId), 10) : null;
  if (eventId != null && (numEventId === null || isNaN(numEventId))) {
    return res.status(400).json({ error: "Invalid eventId" });
  }

  // Staff: verify the event belongs to their club
  const staffCId = getStaffClubId(res);
  if (staffCId !== null && numEventId) {
    const [evt] = await db.select({ clubId: eventsTable.clubId }).from(eventsTable).where(eq(eventsTable.id, numEventId));
    if (!evt || evt.clubId !== staffCId) return res.status(403).json({ error: "Forbidden" });
  }

  // Guard: prevent the same tag number being assigned to multiple riders in the same event.
  // If that happened the timing lookup (rfidNumber + eventId) would match the wrong rider.
  if (numEventId) {
    const existing = await db
      .select({ id: rfidAssignmentsTable.id, riderId: rfidAssignmentsTable.riderId })
      .from(rfidAssignmentsTable)
      .where(and(eq(rfidAssignmentsTable.rfidNumber, rfidNumber), eq(rfidAssignmentsTable.eventId, numEventId)));
    if (existing.length > 0 && existing[0].riderId !== numRiderId) {
      return res.status(409).json({ error: `Tag ${rfidNumber} is already assigned to another rider for this event` });
    }
  }

  // Upsert: if this rider already has an assignment for this event, replace it
  let assignment;
  if (numEventId) {
    const existing = await db
      .select({ id: rfidAssignmentsTable.id })
      .from(rfidAssignmentsTable)
      .where(and(eq(rfidAssignmentsTable.riderId, numRiderId), eq(rfidAssignmentsTable.eventId, numEventId)))
      .limit(1);
    if (existing.length > 0) {
      [assignment] = await db.update(rfidAssignmentsTable)
        .set({ rfidNumber })
        .where(eq(rfidAssignmentsTable.id, existing[0].id))
        .returning();
    } else {
      [assignment] = await db.insert(rfidAssignmentsTable).values({ riderId: numRiderId, rfidNumber, eventId: numEventId }).returning();
    }
  } else {
    [assignment] = await db.insert(rfidAssignmentsTable).values({ riderId: numRiderId, rfidNumber, eventId: null }).returning();
  }

  // Also update rider's primary rfid
  await db.update(ridersTable).set({ rfidNumber }).where(eq(ridersTable.id, numRiderId));

  // Update the checkin row so the check-in page reflects rfidLinked immediately
  if (numEventId) {
    await db.update(checkinsTable)
      .set({ rfidNumber, rfidLinked: true })
      .where(and(
        eq(checkinsTable.eventId, numEventId),
        eq(checkinsTable.riderId, numRiderId),
      ));
  }

  const riders = await db.select().from(ridersTable).where(eq(ridersTable.id, numRiderId));
  const rider = riders[0];

  // Backfill any practice crossings that recorded this RFID but had no rider identity at the time
  if (rider) {
    const riderName = `${rider.firstName} ${rider.lastName}`.trim();
    await db.update(practiceCrossingsTable)
      .set({ riderId: numRiderId, riderName, bibNumber: rider.bibNumber ?? null })
      .where(and(
        eq(practiceCrossingsTable.rfidNumber, rfidNumber),
        isNull(practiceCrossingsTable.riderId),
      ));
  }

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
