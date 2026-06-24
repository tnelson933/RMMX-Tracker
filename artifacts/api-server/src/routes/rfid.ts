import { Router } from "express";
import { db } from "@workspace/db";
import { rfidAssignmentsTable, ridersTable, checkinsTable, eventsTable, practiceCrossingsTable, lapCrossingsTable, raceResultsTable, motosTable, registrationsTable } from "@workspace/db";
import { eq, and, inArray, isNull, asc, or, gt, sql } from "drizzle-orm";
import { formatLapTime } from "./timing";

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
  // Filter: exclude assignments whose rental expiry has passed
  const notExpired = or(isNull(rfidAssignmentsTable.expiresAt), gt(rfidAssignmentsTable.expiresAt, sql`NOW()`));
  const selectFields = {
    id: rfidAssignmentsTable.id,
    riderId: rfidAssignmentsTable.riderId,
    rfidNumber: rfidAssignmentsTable.rfidNumber,
    eventId: rfidAssignmentsTable.eventId,
    assignedAt: rfidAssignmentsTable.assignedAt,
    firstName: ridersTable.firstName,
    lastName: ridersTable.lastName,
  };
  let assignments;
  if (numEventId) {
    assignments = await db.select(selectFields).from(rfidAssignmentsTable)
      .leftJoin(ridersTable, eq(rfidAssignmentsTable.riderId, ridersTable.id))
      .where(and(eq(rfidAssignmentsTable.eventId, numEventId), notExpired));
  } else if (staffCId !== null) {
    // Staff with no eventId filter — scope to their club's events only
    const clubEvents = await db.select({ id: eventsTable.id }).from(eventsTable).where(eq(eventsTable.clubId, staffCId));
    const clubEventIds = clubEvents.map(e => e.id);
    assignments = clubEventIds.length > 0
      ? await db.select(selectFields).from(rfidAssignmentsTable)
          .leftJoin(ridersTable, eq(rfidAssignmentsTable.riderId, ridersTable.id))
          .where(and(inArray(rfidAssignmentsTable.eventId, clubEventIds), notExpired))
      : [];
  } else {
    assignments = await db.select(selectFields).from(rfidAssignmentsTable)
      .leftJoin(ridersTable, eq(rfidAssignmentsTable.riderId, ridersTable.id))
      .where(notExpired);
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

    // Sync transponder number to ALL of this rider's registration rows for the event
    // so multi-class riders don't end up with stale/missing numbers on some classes.
    await db.update(registrationsTable)
      .set({ myLapsTransponderNumber: rfidNumber })
      .where(and(
        eq(registrationsTable.eventId, numEventId),
        eq(registrationsTable.riderId, numRiderId),
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

  // Backfill race lap_crossings and race_results for this RFID
  if (rider) {
    // Find unidentified race crossings for this tag
    const unidentified = await db.select()
      .from(lapCrossingsTable)
      .where(and(eq(lapCrossingsTable.rfidNumber, rfidNumber), isNull(lapCrossingsTable.riderId)));

    if (unidentified.length > 0) {
      // Stamp riderId onto all unidentified crossings for this tag
      await db.update(lapCrossingsTable)
        .set({ riderId: numRiderId })
        .where(and(eq(lapCrossingsTable.rfidNumber, rfidNumber), isNull(lapCrossingsTable.riderId)));

      // For each affected moto, upsert race_results and recalculate positions
      const affectedMotoIds = [...new Set(unidentified.map(c => c.motoId))];
      for (const motoId of affectedMotoIds) {
        const [moto] = await db.select().from(motosTable).where(eq(motosTable.id, motoId));
        if (!moto) continue;

        // All crossings for this rider in this moto (after backfill)
        const riderCrossings = await db.select()
          .from(lapCrossingsTable)
          .where(and(eq(lapCrossingsTable.motoId, motoId), eq(lapCrossingsTable.riderId, numRiderId)))
          .orderBy(asc(lapCrossingsTable.crossingTime));

        // Get bib from check-in
        const checkins = await db.select().from(checkinsTable)
          .where(and(eq(checkinsTable.eventId, moto.eventId), eq(checkinsTable.riderId, numRiderId)));
        const checkin = checkins.find(c => c.raceClass === moto.raceClass) ?? checkins[0];

        const lapTimes = riderCrossings.map(c => c.lapTimeMs).filter((t): t is number => t !== null);
        const totalMs = lapTimes.reduce((s, t) => s + t, 0);

        const [existing] = await db.select().from(raceResultsTable)
          .where(and(eq(raceResultsTable.motoId, motoId), eq(raceResultsTable.riderId, numRiderId)));

        if (existing) {
          await db.update(raceResultsTable)
            .set({ lapTimes, totalTime: lapTimes.length ? formatLapTime(totalMs) : null, bibNumber: checkin?.bibNumber ?? null })
            .where(eq(raceResultsTable.id, existing.id));
        } else {
          await db.insert(raceResultsTable).values({
            eventId: moto.eventId,
            motoId,
            riderId: numRiderId,
            raceClass: moto.raceClass,
            position: 999,
            lapTimes,
            totalTime: lapTimes.length ? formatLapTime(totalMs) : null,
            bibNumber: checkin?.bibNumber ?? null,
            dnf: false,
            dns: false,
          });
        }

        // Recalculate positions for all riders in this moto
        const allResults = await db.select().from(raceResultsTable).where(eq(raceResultsTable.motoId, motoId));
        const sorted = allResults
          .map(r => {
            const laps = Array.isArray(r.lapTimes) ? (r.lapTimes as number[]) : [];
            return { id: r.id, laps: laps.length, totalMs: laps.reduce((s, t) => s + t, 0) };
          })
          .sort((a, b) => b.laps - a.laps || a.totalMs - b.totalMs);
        for (let i = 0; i < sorted.length; i++) {
          await db.update(raceResultsTable).set({ position: i + 1 }).where(eq(raceResultsTable.id, sorted[i].id));
        }
      }
    }
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
