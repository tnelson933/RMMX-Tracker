/**
 * Token-based reader ingest endpoint.
 *
 * POST /timing/readers/:token/crossing
 *
 * Each physical reader (RFID or Active Transponder Timing) is pointed at its own URL containing
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
import express, { Router } from "express";
import { db } from "@workspace/db";
import {
  readersTable,
  eventReaderAssignmentsTable,
  eventsTable,
  lapCrossingsTable,
  rfidAssignmentsTable,
  ridersTable,
  enduroCheckpointArrivalsTable,
  practiceSessionsTable,
  motosTable,
  registrationsTable,
} from "@workspace/db/schema";
import { eq, and, count, ilike, or, desc } from "drizzle-orm";
import { processCrossing, handleFacilityCrossing, handlePing, buildLeaderboard, sseBroadcast, withMotoLock, motoForRider, RiderMotoFinishedError } from "./timing";
import { recordSplitCrossing, splitForReader } from "../lib/sectors";
import { processPracticeCrossing } from "./practice";
import { recomputeEnduroPositionsForEvent } from "./enduro-scoring";
import { recordTagSeen } from "../lib/recentTags";
import { canonicalizeCrossingTimestamp, parseTrustworthyReceivedAt } from "../lib/crossingTimestamp";
import { findReaderByToken } from "../lib/ingestAuth";
import { activePracticeForClub, liveMotoForClub } from "../lib/liveSession";

const router = Router();

/**
 * Resolve a tag number to a riderId for the given event.
 * Checks event RFID assignments first, then permanent RFID and active-transponder
 * identifiers on the rider record.
 */
async function resolveRider(
  rfidNumber: string,
  eventId: number,
  isActiveTransponderReader: boolean,
): Promise<number | null> {
  const tagNumber = rfidNumber.trim();

  // Active IDs assigned for this event take priority over the rider's global
  // identifier, allowing a rider to use different transponders at different
  // events without breaking older event assignments.
  if (isActiveTransponderReader) {
    const [registration] = await db
      .select({ riderId: registrationsTable.riderId })
      .from(registrationsTable)
      .where(and(
        eq(registrationsTable.eventId, eventId),
        ilike(registrationsTable.myLapsTransponderNumber, tagNumber),
      ))
      .limit(1);
    if (registration) return registration.riderId;
  }

  // Event-specific assignment takes priority
  const [assignment] = await db
    .select({ riderId: rfidAssignmentsTable.riderId })
    .from(rfidAssignmentsTable)
    .where(and(eq(rfidAssignmentsTable.eventId, eventId), ilike(rfidAssignmentsTable.rfidNumber, tagNumber)));
  if (assignment) return assignment.riderId;

  // Fall back to permanent RFID sticker or active-transponder identifiers.
  // F2000 hexadecimal values may use a different letter case than the stored ID.
  const [rider] = await db
    .select({ id: ridersTable.id })
    .from(ridersTable)
    .where(or(
      ilike(ridersTable.rfidNumber, tagNumber),
      ilike(ridersTable.mylapsTransponderId, tagNumber),
    ));
  return rider?.id ?? null;
}

/**
 * Record a split under the moto's lock, the same lock laps use, and publish
 * the leaderboard from inside it so snapshots go out in order.
 */
async function recordSplitLocked(routed: Parameters<typeof recordSplitCrossing>[0]) {
  // In a staggered start the split belongs to the rider's own moto.
  let motoId: number;
  try {
    motoId = await motoForRider(routed.motoId, routed.rfidNumber);
  } catch (err) {
    // A split from a rider whose moto already finished isn't recorded anywhere.
    if (err instanceof RiderMotoFinishedError) return { recorded: false, lapNumber: 0 };
    motoId = routed.motoId;
  }
  const input = { ...routed, motoId };
  return withMotoLock(input.motoId, async () => {
    const result = await recordSplitCrossing(input);
    if (result.recorded) {
      const snapshot = await buildLeaderboard(input.motoId).catch(() => null);
      if (snapshot) sseBroadcast(input.motoId, snapshot);
    }
    return result;
  });
}

/** True when the reader is a split on any course: its reads must never become laps. */
async function isSplitReader(readerId: number): Promise<boolean> {
  const [row] = await db.select({ id: eventReaderAssignmentsTable.id }).from(eventReaderAssignmentsTable)
    .where(and(eq(eventReaderAssignmentsTable.readerId, readerId), eq(eventReaderAssignmentsTable.role, "split")))
    .limit(1);
  return !!row;
}

/** Tag reads in any payload format the facility URL accepts. */
function tagsFromPayload(body: any): Array<{ rfidNumber: string; time: unknown }> {
  if (Array.isArray(body?.events)) {
    return body.events
      .filter((e: any) => e?.type === "tagInventoryEvent" && e?.tagInventoryEvent?.epcHex)
      .map((e: any) => ({ rfidNumber: String(e.tagInventoryEvent.epcHex).toUpperCase(), time: e.tagInventoryEvent.firstSeenTime }));
  }
  if (Array.isArray(body)) {
    return body
      .filter((e: any) => e?.eventType === "tagInventory" && e?.tagInventoryEvent?.epc)
      .map((e: any) => ({
        rfidNumber: Buffer.from(String(e.tagInventoryEvent.epc).replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("hex").toUpperCase(),
        time: e.tagInventoryEvent.lastSeenTime ?? e.timestamp,
      }));
  }
  const zebra: any[] = Array.isArray(body?.data?.tags) ? body.data.tags : Array.isArray(body?.tags) ? body.tags : [];
  if (zebra.length) {
    return zebra
      .map(t => ({ rfidNumber: String(t.idHex || t.epc || "").toUpperCase(), time: t.firstSeenTimestamp }))
      .filter(t => t.rfidNumber);
  }
  const id = body?.rfidNumber ?? body?.transponder ?? body?.transponderId ?? body?.id;
  return id ? [{ rfidNumber: String(id), time: body?.crossingTime ?? body?.passingTime ?? body?.timestamp ?? body?.passTime }] : [];
}

function markReaderSeen(readerId: number) {
  db.update(readersTable)
    .set({ lastSeenAt: new Date() })
    .where(eq(readersTable.id, readerId))
    .catch(() => {});
}

/**
 * POST /timing/readers/:token/active/crossing
 *
 * Per-reader version of the facility URL (/timing/active/crossing?clubId=).
 * Same payload formats and moto/practice routing, but the club comes from the
 * reader token instead of a guessable query parameter. Use this URL for
 * hardware that cannot send an Authorization header.
 */
router.post("/timing/readers/:token/active/crossing", async (req, res) => {
  const reader = await findReaderByToken(req.params.token);
  if (!reader) return res.status(404).json({ ok: false, message: "Unknown reader token" });
  markReaderSeen(reader.id);
  const moto = await liveMotoForClub(reader.clubId);
  const split = moto && moto.type !== "enduro_test" ? await splitForReader(moto.eventId, reader.id) : null;
  if (!split) {
    // A split reader with no motocross moto running must not score practice laps.
    if (await isSplitReader(reader.id)) {
      return res.status(409).json({ ok: false, message: "Split readers only record sector times during a moto" });
    }
    return handleFacilityCrossing(req, res, reader.clubId);
  }
  if (!moto) return res.status(409).json({ ok: false, message: "No moto in progress" });

  const tags = tagsFromPayload(req.body);
  const isActive = reader.type === "active_transponder";
  let recorded = 0;
  for (const tag of tags) {
    recordTagSeen(reader.clubId, tag.rfidNumber.toUpperCase());
    const receivedAt = new Date();
    const crossingTime = canonicalizeCrossingTimestamp(tag.time ?? receivedAt, receivedAt, { source: "reader_split_direct", readerId: reader.id });
    const riderId = await resolveRider(tag.rfidNumber, moto.eventId, isActive);
    const result = await recordSplitLocked({ eventId: moto.eventId, motoId: moto.id, split, readerId: reader.id, rfidNumber: tag.rfidNumber, riderId, crossingTime });
    if (result.recorded) recorded++;
  }
  return res.json({ ok: true, processed: tags.length, recorded, split: split.label });
});

// POST /timing/readers/:token/ping — connectivity test for a per-reader URL.
router.post("/timing/readers/:token/ping", async (req, res) => {
  const reader = await findReaderByToken(req.params.token);
  if (!reader) return res.status(404).json({ ok: false, message: "Unknown reader token" });
  markReaderSeen(reader.id);
  return handlePing(req, res, reader.clubId);
});

const TAG_FIELDS = ["rfidNumber", "epc", "EPC", "tag", "tagId", "tag_id", "tagID", "uid", "data", "barcode"];
const TIME_FIELDS = ["crossingTime", "scanTime", "readTime", "time", "timestamp"];

/**
 * Hand scanner apps name the tag field differently and post JSON, forms, query
 * strings or plain text. Map the common shapes onto { rfidNumber, crossingTime }.
 */
export function normalizeScanBody(body: unknown, query: Record<string, unknown> = {}): Record<string, unknown> {
  const src: Record<string, unknown> = typeof body === "string"
    ? { rfidNumber: body.trim().split(/[\r\n,;]/)[0] }
    : body && typeof body === "object" && !Array.isArray(body) ? { ...(body as Record<string, unknown>) } : {};
  const pick = (fields: string[]) => {
    for (const k of fields) {
      const v = src[k] ?? query[k];
      if (typeof v === "string" && v.trim()) return v.trim();
      if (typeof v === "number") return String(v);
    }
    return undefined;
  };
  const tag = pick(TAG_FIELDS);
  if (tag) src.rfidNumber = tag.replace(/\s+/g, "");
  if (src.crossingTime == null) {
    const time = pick(TIME_FIELDS);
    if (time) src.crossingTime = /^\d{12,}$/.test(time) ? new Date(Number(time)).toISOString() : time;
  }
  return src;
}

router.post("/timing/readers/:token/crossing", express.text({ type: "text/*" }), (req, _res, next) => {
  req.body = normalizeScanBody(req.body, req.query as Record<string, unknown>);
  next();
}, async (req, res) => {
  const { token } = req.params;
  const body = req.body as {
    rfidNumber?: string;
    crossingTime?: string;
    antennaId?: number;
    eventId?: number;
    receivedAt?: string;
    receivedAtUtc?: string;
    deviceTimezone?: string;
    timeSource?: string;
    source?: string;
    readerReceivedAt?: string;
  };

  if (!body.rfidNumber) return res.status(400).json({ ok: false, message: "rfidNumber is required" });

  // 1. Resolve reader by token
  const reader = await findReaderByToken(token);
  if (!reader) return res.status(404).json({ ok: false, message: "Unknown reader token" });

  // Record the tag in the live scanner buffer — even if this request ends in
  // a 422 (no checkpoint assignment), so organizers can identify tags.
  recordTagSeen(reader.clubId, String(body.rfidNumber).toUpperCase());

  // 2. Update last-seen (fire-and-forget)
  markReaderSeen(reader.id);

  const serverReceivedAt = new Date();
  const isActiveTransponderReader =
    reader.type === "active_transponder";
  const originalReceipt = parseTrustworthyReceivedAt(
    body.receivedAtUtc ?? body.receivedAt,
    serverReceivedAt,
  );
  const receivedAt = originalReceipt ?? serverReceivedAt;
  const crossingTime = canonicalizeCrossingTimestamp(body.crossingTime ?? receivedAt, receivedAt, {
    source: "reader_token_ingest",
    readerId: reader.id,
    deviceTimezone: body.deviceTimezone,
    timeSource: body.timeSource ?? body.source,
  // A registered active reader is authenticated by its token, so it can attest
  // direct timing even when an older bridge did not include source metadata.
  // Passive reader types deliberately cannot opt into past-skew replacement.
  }, isActiveTransponderReader && originalReceipt !== null);

  // 3. Prefer a running practice whenever the club has no moto actually in
  // progress. An event can remain in race_day status while organizers run a
  // practice, so event status alone must not divert the crossing away from the
  // active practice.
  // A reader token only authorizes its own club. An eventId supplied by the
  // caller must belong to that club, or a token from one club could route
  // crossings into another club's event. Unknown event IDs keep their existing
  // handling (no assignment → 422), so connectors still fall back as before.
  // Deliberately not a 422: RM Connect retries on the facility URL when a 422
  // message mentions "assignment" or "no active race_day event".
  const requestedEventId = Number(body.eventId);
  if (body.eventId != null && Number.isInteger(requestedEventId) && requestedEventId > 0) {
    const [requestedEvent] = await db
      .select({ clubId: eventsTable.clubId })
      .from(eventsTable)
      .where(eq(eventsTable.id, requestedEventId));
    if (requestedEvent && requestedEvent.clubId !== reader.clubId) {
      return res.status(403).json({ ok: false, message: "Event does not belong to this reader's club" });
    }
  }

  let eventId = body.eventId ?? null;
  // RM Connect tags reads with the event of the last start_moto it heard. If
  // that moto isn't live any more and a practice is running, the read is a
  // practice lap.
  if (eventId) {
    const live = await liveMotoForClub(reader.clubId);
    if (live?.eventId !== Number(eventId) && (await activePracticeForClub(reader.clubId))) eventId = null;
  }
  if (!eventId) {
    const activeMoto = await liveMotoForClub(reader.clubId);

    if (activeMoto) {
      eventId = activeMoto.eventId;
    } else if (await isSplitReader(reader.id)) {
      // No moto running: a split reader's reads are not practice laps. Not a
      // 422, so RM Connect doesn't retry them on the facility URL.
      return res.status(409).json({ ok: false, message: "Split readers only record sector times during a moto" });
    } else {
      const [practice] = await db
        .select()
        .from(practiceSessionsTable)
        .where(and(
          eq(practiceSessionsTable.clubId, reader.clubId),
          eq(practiceSessionsTable.status, "active"),
        ))
        .limit(1);

      if (practice) {
        const result = await processPracticeCrossing(practice, String(body.rfidNumber), crossingTime);
        if ("skipped" in result) {
          const message = result.reason === "unknown_tag"
            ? `Tag ${body.rfidNumber} is not assigned to a rider`
            : "Practice crossing ignored by the debounce window";
          return res.json({ ok: false, message });
        }
        return res.json({ ok: true, message: "Practice crossing recorded" });
      }

      // RM Connect intentionally forwards physical F2000 reads even when a
      // WebSocket start command was missed, so a live practice can still time.
      // Outside a practice, however, an unarmed active-reader tag must not fall
      // through to a scheduled race/checkpoint and start it accidentally. New
      // connectors include eventId whenever they have received start_moto.
      if (isActiveTransponderReader) {
        return res.status(409).json({
          ok: false,
          message: "No active practice or moto is accepting active-transponder crossings",
        });
      }

      const activeEvents = await db
        .select({ id: eventsTable.id })
        .from(eventsTable)
        .where(and(eq(eventsTable.clubId, reader.clubId), eq(eventsTable.status, "race_day")));
      if (activeEvents.length === 0) {
        return res.status(422).json({ ok: false, message: "No active race_day event or practice session for this club" });
      }
      if (activeEvents.length > 1) return res.status(422).json({ ok: false, message: "Multiple active events — include eventId in the request body" });
      eventId = activeEvents[0].id;
    }
  }

  // 4. Find all checkpoint assignments for this reader + event
  const incomingAntenna = body.antennaId != null ? Number(body.antennaId) : null;
  const assignments = await db
    .select()
    .from(eventReaderAssignmentsTable)
    .where(and(eq(eventReaderAssignmentsTable.eventId, eventId), eq(eventReaderAssignmentsTable.readerId, reader.id)));

  // 4b. Course map (motocross / supercross): the event-wide finish reader scores
  //     laps as usual; split readers only add sector times. Enduro tests keep
  //     their own start/finish gates below.
  const courseAssignment = assignments.find((a) => a.motoId == null && (a.role === "finish" || a.role === "split"));
  if (courseAssignment) {
    const [activeMoto] = await db
      .select()
      .from(motosTable)
      .where(and(eq(motosTable.eventId, eventId), eq(motosTable.status, "in_progress")))
      .orderBy(desc(motosTable.startedAt))
      .limit(1);
    const hasTestGate = activeMoto != null && assignments.some((a) => a.motoId === activeMoto.id);
    if (!activeMoto) {
      if (courseAssignment.role === "split") {
        // Never fall back: a split read must not become a practice or race lap.
        return res.status(409).json({ ok: false, message: "No moto in progress — split reads are only recorded during a moto" });
      }
      // Finish line with no moto running: RM Connect retries on the facility
      // URL, which handles a running practice exactly as before.
      return res.status(422).json({ ok: false, message: "No moto in progress for this course assignment" });
    }
    if (activeMoto.type !== "enduro_test" && !hasTestGate) {
      const rfidNumber = body.rfidNumber!;
      if (courseAssignment.role === "split") {
        const split = await splitForReader(eventId, reader.id);
        if (!split) return res.status(422).json({ ok: false, message: "Reader has no matching checkpoint assignment" });
        const riderId = await resolveRider(rfidNumber, eventId, isActiveTransponderReader);
        const { recorded, lapNumber } = await recordSplitLocked({
          eventId, motoId: activeMoto.id, split, readerId: reader.id, rfidNumber, riderId, crossingTime,
        });
        return res.json({ ok: true, message: recorded ? `${split.label} recorded (lap ${lapNumber})` : `${split.label} already recorded for lap ${lapNumber}` });
      }
      try {
        const result = await processCrossing({
          rfidNumber,
          motoId: activeMoto.id,
          crossingTime,
          readerId: `reader:${reader.id}`,
          antennaId: incomingAntenna ?? undefined,
          readerReceivedAt: body.readerReceivedAt ?? originalReceipt?.toISOString(),
        });
        if (result.debounced) return res.json({ ok: true, message: "Duplicate read ignored" });
        return res.json({ ok: true, message: `Lap ${result.lapNumber} recorded` });
      } catch (err: any) {
        return res.status(409).json({ ok: false, message: err?.message ?? "Processing error" });
      }
    }
    if (courseAssignment.role === "split" && !hasTestGate) {
      return res.status(409).json({ ok: false, message: "Split readers record sector times on motocross and supercross motos only" });
    }
  }

  if (assignments.length === 0 || assignments.every((a) => a.motoId == null && (a.role === "finish" || a.role === "split"))) {
    return res.status(422).json({ ok: false, message: "Reader has no checkpoint assignment for this event" });
  }

  const rfidNumber = body.rfidNumber!;

  // 5. Handle time_check role — persist arrival and return
  const timeCheckAssignment = assignments.find((a) => a.role === "time_check");
  if (timeCheckAssignment && assignments.length === 1) {
    if (timeCheckAssignment.timeCheckId) {
      const riderId = await resolveRider(rfidNumber, eventId, isActiveTransponderReader);
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
    const riderId = await resolveRider(rfidNumber, eventId, isActiveTransponderReader);
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
        readerReceivedAt: body.readerReceivedAt ?? originalReceipt?.toISOString(),
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
      const riderId = await resolveRider(rfidNumber, eventId, isActiveTransponderReader);
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
  const riderId = await resolveRider(rfidNumber, eventId, isActiveTransponderReader);
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
      readerReceivedAt: body.readerReceivedAt ?? originalReceipt?.toISOString(),
    });
    const action = (result as any)?.enduroAction ?? (isEven ? "started" : "finished");
    return res.json({ ok: true, message: `Rider ${action} on moto ${assignment.motoId}` });
  } catch (err: any) {
    return res.status(500).json({ ok: false, message: err?.message ?? "Processing error" });
  }
});

export default router;
