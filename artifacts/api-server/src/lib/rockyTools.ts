import type Anthropic from "@anthropic-ai/sdk";
import {
  db, checkinsTable, connectorLaptopsTable, eventReaderAssignmentsTable, eventsTable, lapCrossingsTable,
  liabilityWaiverSignaturesTable, motosTable, readersTable, registrationsTable, rfidAssignmentsTable, ridersTable,
} from "@workspace/db";
import { and, desc, eq, gte, ilike, inArray, isNull, ne, or, sql } from "drizzle-orm";
import { getConnectorStatus } from "./connectorRelay";
import { eventTimingTags, splitRegistrationTag, timingTagsLabel } from "./eventTimingTags";

/**
 * Rocky's read-only diagnostic tools. Every lookup is limited to the asking
 * organizer's own club, and none of them changes anything. Rocky uses them to
 * answer "why isn't my reader showing up / why can't this rider check in"
 * before escalating to the RM Roost team (create_support_ticket).
 */
export interface RockyToolContext {
  clubId: number;
  /** The event the organizer has open, if any. */
  eventId: number | null;
}

export const ROCKY_DIAGNOSTIC_TOOLS: Anthropic.Tool[] = [
  {
    name: "get_reader_status",
    description:
      "Live status of the club's timing hardware: every registered reader (RFID or RM TrackR), whether RM Connect is connected for it right now, whether the hardware is connected and ready, its last read, and the club's paired RM Connect laptops with when each was last seen. Use for any reader, RM Connect, loop or 'no reads' question.",
    input_schema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "get_event_timing_status",
    description:
      "Timing state of one event: its status, the moto in progress and the next scheduled one, crossings recorded in the last 15 minutes, the readers placed on its course map, and which tag kinds riders need. Use when timing isn't recording or a race won't start or score. Defaults to the event the organizer has open.",
    input_schema: {
      type: "object",
      properties: { event_id: { type: "integer", description: "Event id; omit for the event the organizer has open." } },
      additionalProperties: false,
    },
  },
  {
    name: "find_rider_entry",
    description:
      "Look up a rider's entries at an event by name or bib: class, registration and payment status, bib, transponder and RFID sticker, check-in, waiver, and rentals or purchases to hand out. Use when a rider can't register, check in, Quick Check-In or isn't being timed. Returns at most 5 matches.",
    input_schema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Rider name (or part of it) or bib number." },
        event_id: { type: "integer", description: "Event id; omit for the event the organizer has open." },
      },
      required: ["query"],
      additionalProperties: false,
    },
  },
];

function minutesAgo(at: Date | string | null | undefined, now = Date.now()): number | null {
  if (!at) return null;
  const t = new Date(at).getTime();
  return Number.isFinite(t) ? Math.max(0, Math.round((now - t) / 60_000)) : null;
}

/** An event id the club owns: the one asked for, else the open event. */
async function ownedEventId(ctx: RockyToolContext, requested: unknown): Promise<number | null> {
  const id = Number.isInteger(requested) ? Number(requested) : ctx.eventId;
  if (!id) return null;
  const [e] = await db.select({ id: eventsTable.id }).from(eventsTable)
    .where(and(eq(eventsTable.id, id), eq(eventsTable.clubId, ctx.clubId)));
  return e?.id ?? null;
}

async function readerStatus(ctx: RockyToolContext) {
  const [readers, laptops] = await Promise.all([
    db.select().from(readersTable).where(eq(readersTable.clubId, ctx.clubId)).orderBy(readersTable.name),
    db.select().from(connectorLaptopsTable)
      .where(and(eq(connectorLaptopsTable.clubId, ctx.clubId), isNull(connectorLaptopsTable.revokedAt))),
  ]);
  const live = getConnectorStatus(ctx.clubId);
  return {
    readers: readers.map(r => {
      const conn = live.find(c => c.readerId === r.id);
      return {
        name: r.name,
        type: r.type === "active_transponder" ? "RM TrackR" : "RFID",
        connection: r.connection === "hand_scanner" ? "hand scanner" : "RM Connect",
        lastSeenMinutesAgo: minutesAgo(r.lastSeenAt),
        rmConnectConnectedNow: !!conn,
        rmConnectVersion: conn?.connectorVersion ?? null,
        hardwareConnected: conn ? conn.hardware.connected : null,
        hardwareReady: conn ? conn.hardware.ready : null,
        hardwareDetail: conn?.hardware.detail ?? null,
        lastReadMinutesAgo: minutesAgo(conn?.hardware.lastReadAt),
        readsThisSession: conn?.hardware.readCount ?? null,
      };
    }),
    rmConnectLaptops: laptops.map(l => ({ name: l.name, lastSeenMinutesAgo: minutesAgo(l.lastSeenAt) })),
    note: readers.length === 0 ? "No readers are registered for this club. Readers are added from RM Connect (Reader Setup)." : undefined,
  };
}

async function eventTimingStatus(ctx: RockyToolContext, input: Record<string, unknown>) {
  const eventId = await ownedEventId(ctx, input.event_id);
  if (!eventId) return { error: "No event: open an event in RM Roost, or give an event id from this club." };
  const [event] = await db.select({ name: eventsTable.name, date: eventsTable.date, status: eventsTable.status, raceStyle: eventsTable.raceStyle })
    .from(eventsTable).where(eq(eventsTable.id, eventId));
  const since = new Date(Date.now() - 15 * 60_000);
  const [motos, recent, assignments, tags] = await Promise.all([
    db.select({ id: motosTable.id, name: motosTable.name, raceClass: motosTable.raceClass, status: motosTable.status, motoNumber: motosTable.motoNumber, startedAt: motosTable.startedAt })
      .from(motosTable).where(and(eq(motosTable.eventId, eventId), inArray(motosTable.status, ["in_progress", "scheduled"])))
      .orderBy(motosTable.motoNumber),
    db.select({ n: sql<number>`count(*)::int`, last: sql<string | null>`max(${lapCrossingsTable.crossingTime})` })
      .from(lapCrossingsTable).where(and(eq(lapCrossingsTable.eventId, eventId), gte(lapCrossingsTable.crossingTime, since))),
    db.select({ role: eventReaderAssignmentsTable.role, label: eventReaderAssignmentsTable.label, motoId: eventReaderAssignmentsTable.motoId, reader: readersTable.name, type: readersTable.type })
      .from(eventReaderAssignmentsTable).innerJoin(readersTable, eq(eventReaderAssignmentsTable.readerId, readersTable.id))
      .where(eq(eventReaderAssignmentsTable.eventId, eventId)),
    eventTimingTags(eventId),
  ]);
  const running = motos.find(m => m.status === "in_progress");
  const next = motos.find(m => m.status === "scheduled");
  return {
    event: { name: event?.name, date: String(event?.date ?? "").slice(0, 10), status: event?.status, raceStyle: event?.raceStyle },
    motoInProgress: running ? { name: running.name, class: running.raceClass, startedMinutesAgo: minutesAgo(running.startedAt) } : null,
    nextScheduled: next ? { name: next.name, class: next.raceClass } : null,
    crossingsLast15Minutes: recent[0]?.n ?? 0,
    lastCrossingMinutesAgo: minutesAgo(recent[0]?.last),
    courseMap: assignments.map(a => ({ reader: a.reader, type: a.type === "active_transponder" ? "RM TrackR" : "RFID", role: a.role, label: a.label, enduroTest: a.motoId != null })),
    tagsRidersNeed: tags.fromReaders ? timingTagsLabel(tags) : "either kind (no readers set up)",
  };
}

async function findRiderEntry(ctx: RockyToolContext, input: Record<string, unknown>) {
  const eventId = await ownedEventId(ctx, input.event_id);
  if (!eventId) return { error: "No event: open an event in RM Roost, or give an event id from this club." };
  const query = typeof input.query === "string" ? input.query.trim().slice(0, 60) : "";
  if (!query) return { error: "Give a rider name or bib." };
  const words = query.split(/\s+/).filter(Boolean).slice(0, 3);
  const nameMatch = and(...words.map(w => or(ilike(ridersTable.firstName, `%${w}%`), ilike(ridersTable.lastName, `%${w}%`))));
  const regs = await db.select({
    riderId: registrationsTable.riderId,
    firstName: ridersTable.firstName,
    lastName: ridersTable.lastName,
    raceClass: registrationsTable.raceClass,
    status: registrationsTable.status,
    paymentStatus: registrationsTable.paymentStatus,
    bibNumber: registrationsTable.bibNumber,
    transponder: registrationsTable.myLapsTransponderNumber,
    riderTransponder: ridersTable.mylapsTransponderId,
    waiverAcknowledgedAt: registrationsTable.waiverAcknowledgedAt,
    transponderRental: registrationsTable.transponderRental,
    rmTrackrPurchased: registrationsTable.rmTrackrPurchased,
    rmTrackrFulfilledAt: registrationsTable.rmTrackrFulfilledAt,
    rfidStickerPurchased: registrationsTable.rfidStickerPurchased,
  }).from(registrationsTable)
    .innerJoin(ridersTable, eq(registrationsTable.riderId, ridersTable.id))
    .where(and(eq(registrationsTable.eventId, eventId), or(nameMatch, eq(registrationsTable.bibNumber, query))))
    .orderBy(desc(registrationsTable.id))
    .limit(5);
  if (regs.length === 0) return { matches: [], note: "No entry at this event matches that name or bib." };
  const riderIds = [...new Set(regs.map(r => r.riderId))];
  const [stickers, checkins, waivers] = await Promise.all([
    db.select({ riderId: rfidAssignmentsTable.riderId, number: rfidAssignmentsTable.rfidNumber }).from(rfidAssignmentsTable)
      .where(and(eq(rfidAssignmentsTable.eventId, eventId), inArray(rfidAssignmentsTable.riderId, riderIds), isNull(rfidAssignmentsTable.expiresAt))),
    db.select({ riderId: checkinsTable.riderId, raceClass: checkinsTable.raceClass, checkedIn: checkinsTable.checkedIn }).from(checkinsTable)
      .where(and(eq(checkinsTable.eventId, eventId), inArray(checkinsTable.riderId, riderIds))),
    db.select({ riderId: registrationsTable.riderId }).from(liabilityWaiverSignaturesTable)
      .innerJoin(registrationsTable, eq(registrationsTable.id, liabilityWaiverSignaturesTable.registrationId))
      .where(and(eq(liabilityWaiverSignaturesTable.eventId, eventId), inArray(registrationsTable.riderId, riderIds))),
  ]);
  return {
    matches: regs.map(r => {
      const regTag = splitRegistrationTag(r.transponder);
      const sticker = stickers.find(s => s.riderId === r.riderId)?.number ?? regTag.sticker;
      return {
        rider: [r.firstName, r.lastName].filter(Boolean).join(" "),
        class: r.raceClass,
        registration: r.status,
        payment: r.paymentStatus,
        bib: r.bibNumber,
        transponder: regTag.transponder ?? r.riderTransponder ?? null,
        rfidSticker: sticker,
        checkedIn: checkins.some(c => c.riderId === r.riderId && c.raceClass === r.raceClass && c.checkedIn),
        waiverAcknowledged: !!r.waiverAcknowledgedAt,
        liabilityWaiverSigned: waivers.some(w => w.riderId === r.riderId),
        toHandOut: [
          r.transponderRental && !regTag.transponder ? "rental transponder" : null,
          r.rmTrackrPurchased && !r.rmTrackrFulfilledAt ? "RM TrackR they bought" : null,
          r.rfidStickerPurchased && !sticker ? "RFID sticker they bought" : null,
        ].filter(Boolean),
      };
    }),
  };
}

/** Run one diagnostic tool; returns JSON text for the tool_result. Never throws. */
export async function runRockyDiagnosticTool(name: string, input: unknown, ctx: RockyToolContext): Promise<{ content: string; isError: boolean }> {
  const args = input && typeof input === "object" && !Array.isArray(input) ? (input as Record<string, unknown>) : {};
  try {
    const result = name === "get_reader_status" ? await readerStatus(ctx)
      : name === "get_event_timing_status" ? await eventTimingStatus(ctx, args)
      : name === "find_rider_entry" ? await findRiderEntry(ctx, args)
      : null;
    if (result === null) return { content: `Unknown tool ${name}`, isError: true };
    return { content: JSON.stringify(result), isError: "error" in result };
  } catch (err) {
    return { content: `The lookup failed: ${err instanceof Error ? err.message : String(err)}`, isError: true };
  }
}
