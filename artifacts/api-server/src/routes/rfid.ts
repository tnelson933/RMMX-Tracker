import { Router } from "express";
import { db } from "@workspace/db";
import { rfidAssignmentsTable, ridersTable, checkinsTable, eventsTable, practiceCrossingsTable, lapCrossingsTable, raceResultsTable, motosTable, registrationsTable } from "@workspace/db";
import { eq, and, inArray, isNull, isNotNull, asc, or, gt, sql } from "drizzle-orm";
import { formatLapTime } from "./timing";

const router = Router();

function getStaffClubId(res: any): number | null {
  const v = res.locals?.staffClubId;
  return typeof v === "number" ? v : null;
}

router.get("/rfid", async (req, res) => {
  const { eventId, assignmentType } = req.query;
  const isActiveTransponder = assignmentType === "active_transponder";
  if (assignmentType != null && assignmentType !== "rfid" && !isActiveTransponder) {
    return res.status(400).json({ error: "Invalid assignmentType" });
  }
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

  // Active transponders are not passive RFID assignments. Event registrations
  // are the dedicated event-scoped source, with the rider profile as the
  // persistent active-transponder profile field.
  if (isActiveTransponder) {
    if (!numEventId) {
      return res.status(400).json({ error: "eventId required for active transponder assignments" });
    }
    const activeRows = await db.select({
      id: registrationsTable.id,
      riderId: registrationsTable.riderId,
      rfidNumber: registrationsTable.myLapsTransponderNumber,
      firstName: ridersTable.firstName,
      lastName: ridersTable.lastName,
      assignedAt: registrationsTable.createdAt,
    }).from(registrationsTable)
      .leftJoin(ridersTable, eq(registrationsTable.riderId, ridersTable.id))
      .where(and(
        eq(registrationsTable.eventId, numEventId),
        isNotNull(registrationsTable.myLapsTransponderNumber),
      ));

    // Multi-class riders have one registration per class; expose one active
    // assignment per rider rather than duplicate rows in the organizer view.
    const byRider = new Map<number, typeof activeRows[number]>();
    for (const row of activeRows) {
      if (!byRider.has(row.riderId)) byRider.set(row.riderId, row);
    }
    return res.json([...byRider.values()].map(a => ({
      id: a.id,
      riderId: a.riderId,
      riderName: `${a.firstName ?? ""} ${a.lastName ?? ""}`.trim(),
      rfidNumber: a.rfidNumber!,
      eventId: numEventId,
      assignedAt: a.assignedAt.toISOString(),
    })));
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
  const { riderId, rfidNumber, eventId, assignmentType } = req.body;
  if (!riderId || !rfidNumber) return res.status(400).json({ error: "riderId and rfidNumber required" });
  const isActiveTransponder = assignmentType === "active_transponder";
  if (assignmentType != null && assignmentType !== "rfid" && !isActiveTransponder) {
    return res.status(400).json({ error: "Invalid assignmentType" });
  }

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

  if (isActiveTransponder) {
    if (numEventId) {
      const existing = await db.select({
        riderId: registrationsTable.riderId,
      }).from(registrationsTable)
        .where(and(
          eq(registrationsTable.eventId, numEventId),
          eq(registrationsTable.myLapsTransponderNumber, rfidNumber),
        ))
        .limit(1);
      if (existing.length > 0 && existing[0].riderId !== numRiderId) {
        return res.status(409).json({ error: `Transponder ${rfidNumber} is already assigned to another rider for this event` });
      }
    }

    const [rider] = await db.update(ridersTable)
      .set({ mylapsTransponderId: rfidNumber })
      .where(eq(ridersTable.id, numRiderId))
      .returning();

    if (numEventId) {
      await db.update(registrationsTable)
        .set({ myLapsTransponderNumber: rfidNumber })
        .where(and(
          eq(registrationsTable.eventId, numEventId),
          eq(registrationsTable.riderId, numRiderId),
        ));
    }

    return res.status(201).json({
      // Active assignments intentionally have no rfid_assignments row. Keep
      // the legacy response shape with a stable numeric identifier.
      id: numRiderId,
      riderId: numRiderId,
      riderName: rider ? `${rider.firstName} ${rider.lastName}` : "",
      rfidNumber,
      eventId: numEventId,
      assignedAt: new Date().toISOString(),
    });
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

  // Legacy callers omit assignmentType and retain the passive RFID behavior.
  await db.update(ridersTable).set({ rfidNumber }).where(eq(ridersTable.id, numRiderId));

  // Keep event-scoped registration/check-in data synchronized. Active timing
  // is surfaced on check-in rows from the associated registration, while
  // passive RFID continues to use the checkins RFID columns exactly as before.
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

        const allLapTimes = riderCrossings.map(c => c.lapTimeMs).filter((t): t is number => t !== null);
        // Only cap by lapCount for fixed-lap races; time-limit races let laps run freely
        const rfidLapCap = moto.lapCount != null && moto.lapCount > 0 && !moto.timeLimitMs ? Number(moto.lapCount) : null;
        const lapTimes = rfidLapCap != null ? allLapTimes.slice(0, rfidLapCap) : allLapTimes;
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
