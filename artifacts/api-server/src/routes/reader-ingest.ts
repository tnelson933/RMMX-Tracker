/**
 * Token-based reader ingest endpoint.
 *
 * POST /timing/readers/:token/crossing
 *
 * Each physical reader (RFID or MyLaps) is pointed at its own URL containing
 * its unique token.  The token resolves to a registered reader, which has an
 * event-reader-assignment telling us which test moto + role (start | finish)
 * the reader is covering.  The crossing is then routed directly to the correct
 * moto instead of relying on the "active moto" heuristic.
 *
 * Role enforcement prevents mis-routing:
 *   start  reader  → only processes when the rider's crossing count is even
 *                    (expecting a start toggle)
 *   finish reader  → only processes when the rider's crossing count is odd
 *                    (expecting a finish toggle)
 *   time_check     → records an arrival note (split time) against the check
 */
import { Router } from "express";
import { db } from "@workspace/db";
import {
  readersTable,
  eventReaderAssignmentsTable,
  eventsTable,
  lapCrossingsTable,
  rfidAssignmentsTable,
  ridersTable,
  enduroCheckpointArrivalsTable,
} from "@workspace/db/schema";
import { eq, and, count } from "drizzle-orm";
import { processCrossing } from "./timing";
import { recomputeEnduroPositionsForEvent } from "./enduro-scoring";
import { recordTagSeen } from "../lib/recentTags";

const router = Router();

/**
 * Resolve a tag number to a riderId for the given event.
 * Checks rfid_assignments first, then the riders table (permanent column).
 */
async function resolveRider(rfidNumber: string, eventId: number): Promise<number | null> {
  // Event-specific assignment takes priority
  const [assignment] = await db
    .select({ riderId: rfidAssignmentsTable.riderId })
    .from(rfidAssignmentsTable)
    .where(and(eq(rfidAssignmentsTable.eventId, eventId), eq(rfidAssignmentsTable.rfidNumber, rfidNumber)));
  if (assignment) return assignment.riderId;

  // Fall back to permanent rfid_number on the rider record
  const [rider] = await db
    .select({ id: ridersTable.id })
    .from(ridersTable)
    .where(eq(ridersTable.rfidNumber, rfidNumber));
  return rider?.id ?? null;
}

router.post("/timing/readers/:token/crossing", async (req, res) => {
  const { token } = req.params;
  const body = req.body as {
    rfidNumber?: string;
    crossingTime?: string;
    antennaId?: number;
    eventId?: number;
  };

  if (!body.rfidNumber) return res.status(400).json({ ok: false, message: "rfidNumber is required" });

  // 1. Resolve reader by token
  const [reader] = await db.select().from(readersTable).where(eq(readersTable.token, token));
  if (!reader) return res.status(404).json({ ok: false, message: "Unknown reader token" });

  // Record the tag in the live scanner buffer — even if this request ends in
  // a 422 (no checkpoint assignment), so organizers can identify tags.
  recordTagSeen(reader.clubId, String(body.rfidNumber).toUpperCase());

  // 2. Update last-seen (fire-and-forget)
  db.update(readersTable)
    .set({ lastSeenAt: new Date() })
    .where(eq(readersTable.id, reader.id))
    .catch(() => {});

  // 3. Resolve the active event for this reader's club
  let eventId = body.eventId ?? null;
  if (!eventId) {
    const activeEvents = await db
      .select({ id: eventsTable.id })
      .from(eventsTable)
      .where(and(eq(eventsTable.clubId, reader.clubId), eq(eventsTable.status, "race_day")));
    if (activeEvents.length === 0) return res.status(422).json({ ok: false, message: "No active race_day event for this club" });
    if (activeEvents.length > 1) return res.status(422).json({ ok: false, message: "Multiple active events — include eventId in the request body" });
    eventId = activeEvents[0].id;
  }

  // 4. Find all checkpoint assignments for this reader + event
  const incomingAntenna = body.antennaId != null ? Number(body.antennaId) : null;
  const assignments = await db
    .select()
    .from(eventReaderAssignmentsTable)
    .where(and(eq(eventReaderAssignmentsTable.eventId, eventId), eq(eventReaderAssignmentsTable.readerId, reader.id)));

  if (assignments.length === 0) {
    return res.status(422).json({ ok: false, message: "Reader has no checkpoint assignment for this event" });
  }

  const crossingTime = body.crossingTime ? new Date(body.crossingTime) : new Date();
  const rfidNumber = body.rfidNumber!;

  // 5. Handle time_check role — persist arrival and return
  const timeCheckAssignment = assignments.find((a) => a.role === "time_check");
  if (timeCheckAssignment && assignments.length === 1) {
    if (timeCheckAssignment.timeCheckId) {
      const riderId = await resolveRider(rfidNumber, eventId);
      if (riderId) {
        await db
          .insert(enduroCheckpointArrivalsTable)
          .values({
            eventId,
            timeCheckId: timeCheckAssignment.timeCheckId,
            riderId,
            arrivalTime: crossingTime,
            recordedBy: "rfid",
          })
          .onConflictDoUpdate({
            target: [enduroCheckpointArrivalsTable.timeCheckId, enduroCheckpointArrivalsTable.riderId],
            set: { arrivalTime: crossingTime, recordedBy: "rfid" },
          })
          .catch(() => {});
        // Recompute enduro standings asynchronously so penalties/DQ reflect immediately.
        recomputeEnduroPositionsForEvent(eventId).catch(() => {});
      }
    }
    return res.json({ ok: true, message: `Time check arrival recorded (check id ${timeCheckAssignment.timeCheckId})` });
  }

  // 6. Detect same-gate scenario: reader is assigned BOTH start AND finish for the same moto.
  //    When a test starts and ends at the same physical location, organizers assign one reader
  //    to both roles. We pick the correct role by crossing-parity (even count → start, odd → finish).
  const startByMoto = new Map(
    assignments.filter((a) => a.role === "start" && a.motoId).map((a) => [a.motoId!, a]),
  );
  const finishByMoto = new Map(
    assignments.filter((a) => a.role === "finish" && a.motoId).map((a) => [a.motoId!, a]),
  );
  const sameGateMotoId = [...startByMoto.keys()].find((id) => finishByMoto.has(id)) ?? null;

  if (sameGateMotoId) {
    // Resolve rider first so we can read crossing parity
    const riderId = await resolveRider(rfidNumber, eventId);
    if (!riderId) {
      return res.json({ ok: false, message: `Tag ${rfidNumber} not assigned to any rider in this event` });
    }

    const [countRow] = await db
      .select({ n: count() })
      .from(lapCrossingsTable)
      .where(and(eq(lapCrossingsTable.motoId, sameGateMotoId), eq(lapCrossingsTable.riderId, riderId)));

    const existing = Number(countRow?.n ?? 0);
    const isEven = existing % 2 === 0; // even = expecting start; odd = expecting finish

    try {
      const result = await processCrossing({
        rfidNumber,
        motoId: sameGateMotoId,
        crossingTime,
        readerId: `reader:${reader.id}`,
        antennaId: incomingAntenna ?? undefined,
      });
      const action = (result as any)?.enduroAction ?? (isEven ? "started" : "finished");
      return res.json({ ok: true, message: `Rider ${action} on moto ${sameGateMotoId}` });
    } catch (err: any) {
      return res.status(500).json({ ok: false, message: err?.message ?? "Processing error" });
    }
  }

  // 7. Normal single-role: pick assignment by antenna specificity, then wildcard
  const assignment =
    assignments.find((a) => a.antennaId !== null && a.antennaId === incomingAntenna) ??
    assignments.find((a) => a.antennaId === null) ??
    null;

  if (!assignment) {
    return res.status(422).json({ ok: false, message: "Reader has no matching checkpoint assignment" });
  }

  if (assignment.role === "time_check") {
    if (assignment.timeCheckId) {
      const riderId = await resolveRider(rfidNumber, eventId);
      if (riderId) {
        await db
          .insert(enduroCheckpointArrivalsTable)
          .values({
            eventId,
            timeCheckId: assignment.timeCheckId,
            riderId,
            arrivalTime: crossingTime,
            recordedBy: "rfid",
          })
          .onConflictDoUpdate({
            target: [enduroCheckpointArrivalsTable.timeCheckId, enduroCheckpointArrivalsTable.riderId],
            set: { arrivalTime: crossingTime, recordedBy: "rfid" },
          })
          .catch(() => {});
        // Recompute enduro standings asynchronously so penalties/DQ reflect immediately.
        recomputeEnduroPositionsForEvent(eventId).catch(() => {});
      }
    }
    return res.json({ ok: true, message: `Time check arrival recorded (check id ${assignment.timeCheckId})` });
  }

  if (!assignment.motoId) {
    return res.status(422).json({ ok: false, message: "Assignment has no motoId for start/finish" });
  }

  // Enforce role parity for dedicated start/finish readers
  const riderId = await resolveRider(rfidNumber, eventId);
  if (!riderId) {
    return res.json({ ok: false, message: `Tag ${rfidNumber} not assigned to any rider in this event` });
  }

  const [countRow] = await db
    .select({ n: count() })
    .from(lapCrossingsTable)
    .where(and(eq(lapCrossingsTable.motoId, assignment.motoId), eq(lapCrossingsTable.riderId, riderId)));

  const existing = Number(countRow?.n ?? 0);
  const isEven = existing % 2 === 0;

  if (assignment.role === "start" && !isEven) {
    return res.json({ ok: false, message: "Rider already has an open start — waiting for finish crossing" });
  }
  if (assignment.role === "finish" && isEven) {
    return res.json({ ok: false, message: "No open start for this rider on this test" });
  }

  // 8. Delegate to the standard crossing processor
  try {
    const result = await processCrossing({
      rfidNumber,
      motoId: assignment.motoId,
      crossingTime,
      readerId: `reader:${reader.id}`,
      antennaId: incomingAntenna ?? undefined,
    });
    const action = (result as any)?.enduroAction ?? (isEven ? "started" : "finished");
    return res.json({ ok: true, message: `Rider ${action} on moto ${assignment.motoId}` });
  } catch (err: any) {
    return res.status(500).json({ ok: false, message: err?.message ?? "Processing error" });
  }
});

export default router;
