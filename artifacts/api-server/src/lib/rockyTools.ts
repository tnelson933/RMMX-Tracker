import type Anthropic from "@anthropic-ai/sdk";
import {
  db, addonPaymentsTable, checkinsTable, clubsTable, connectorLaptopsTable, eventReaderAssignmentsTable, eventsTable, lapCrossingsTable,
  liabilityWaiverSignaturesTable, motosTable, readersTable, registrationsTable, rfidAssignmentsTable, ridersTable,
} from "@workspace/db";
import { and, desc, eq, gt, gte, ilike, inArray, isNotNull, isNull, ne, or, sql } from "drizzle-orm";
import { getConnectorStatus } from "./connectorRelay";
import { eventTimingTags, splitRegistrationTag, timingTagsLabel } from "./eventTimingTags";
import { getStripePublishableKey, getUncachableStripeClient } from "../stripeClient";
import { stripeNeeds } from "./stripeRequirements";
import { onClub } from "./stripePayments";

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
  {
    name: "get_payments_status",
    description:
      "The club's card payment setup: whether Stripe is connected, whether it's the club's own Stripe account or the older connection (Switch account), whether Stripe setup is complete and, if not, what Stripe still needs and what it's checking, whether the in-page card form is available, the club's card readers (online or offline), and unfinished card payments from the last 24 hours (these block Disconnect). Use for 'can't take payments', 'Stripe setup', 'Finish setup does nothing', card reader or disconnect questions.",
    input_schema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "get_results_status",
    description:
      "An event's results state: finished races and which are still unofficial (not finalized), whether all results are official, when the race day stats emails went out and how many riders opted in, and whether the finalize reminder email went to the organizers. Use for 'results say unofficial', 'riders didn't get their stats', 'series points not updating' or reminder email questions. Defaults to the event the organizer has open.",
    input_schema: {
      type: "object",
      properties: { event_id: { type: "integer", description: "Event id; omit for the event the organizer has open." } },
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
    registrationId: registrationsTable.id,
    transponderReturned: registrationsTable.transponderReturned,
    rentalReminderStatus: registrationsTable.rentalReminderStatus,
    statsEmailOptIn: registrationsTable.statsEmailOptIn,
  }).from(registrationsTable)
    .innerJoin(ridersTable, eq(registrationsTable.riderId, ridersTable.id))
    .where(and(eq(registrationsTable.eventId, eventId), or(nameMatch, eq(registrationsTable.bibNumber, query))))
    .orderBy(desc(registrationsTable.id))
    .limit(5);
  if (regs.length === 0) return { matches: [], note: "No entry at this event matches that name or bib." };
  const riderIds = [...new Set(regs.map(r => r.riderId))];
  const [stickers, checkins, waivers, addons] = await Promise.all([
    db.select({ riderId: rfidAssignmentsTable.riderId, number: rfidAssignmentsTable.rfidNumber }).from(rfidAssignmentsTable)
      .where(and(eq(rfidAssignmentsTable.eventId, eventId), inArray(rfidAssignmentsTable.riderId, riderIds), isNull(rfidAssignmentsTable.expiresAt))),
    db.select({ riderId: checkinsTable.riderId, raceClass: checkinsTable.raceClass, checkedIn: checkinsTable.checkedIn }).from(checkinsTable)
      .where(and(eq(checkinsTable.eventId, eventId), inArray(checkinsTable.riderId, riderIds))),
    db.select({ riderId: registrationsTable.riderId }).from(liabilityWaiverSignaturesTable)
      .innerJoin(registrationsTable, eq(registrationsTable.id, liabilityWaiverSignaturesTable.registrationId))
      .where(and(eq(liabilityWaiverSignaturesTable.eventId, eventId), inArray(registrationsTable.riderId, riderIds))),
    db.select({ registrationId: addonPaymentsTable.registrationId, item: addonPaymentsTable.item, method: addonPaymentsTable.method, status: addonPaymentsTable.status, amount: addonPaymentsTable.amount })
      .from(addonPaymentsTable).where(inArray(addonPaymentsTable.registrationId, regs.map(r => r.registrationId))),
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
        rental: r.transponderRental
          ? { unit: regTag.transponder ?? null, returned: r.transponderReturned, lastReturnReminder: r.rentalReminderStatus ?? null }
          : null,
        paidAtCheckin: addons.filter(a => a.registrationId === r.registrationId).map(a => ({ item: a.item, method: a.method, status: a.status, amount: Number(a.amount) })),
        raceDayStatsEmail: r.statsEmailOptIn,
        toHandOut: [
          r.transponderRental && !regTag.transponder ? "rental transponder" : null,
          r.rmTrackrPurchased && !r.rmTrackrFulfilledAt ? "RM TrackR they bought" : null,
          r.rfidStickerPurchased && !sticker ? "RFID sticker they bought" : null,
        ].filter(Boolean),
      };
    }),
  };
}

async function paymentsStatus(ctx: RockyToolContext) {
  const [club] = await db.select().from(clubsTable).where(eq(clubsTable.id, ctx.clubId));
  if (!club?.stripeAccountId) return { connected: false, note: "Stripe isn't connected. Payments page → Connect with Stripe." };
  const stripe = await getUncachableStripeClient();
  const direct = !!club.stripeDirectCharges;
  const result: Record<string, unknown> = {
    connected: true,
    ownStripeAccount: direct,
    olderConnection: !direct,
    switchInProgress: !!club.stripePendingAccountId,
    inPageCardForm: !!(await getStripePublishableKey().catch(() => "")),
  };
  // Setup state: of the account being set up (the new one while switching).
  const setupId = club.stripePendingAccountId ?? club.stripeAccountId;
  try {
    const account = await stripe.accounts.retrieve(setupId);
    const needs = stripeNeeds(account);
    result.setupAccount = club.stripePendingAccountId ? "new account (switching)" : "current account";
    result.canTakePayments = !!account.charges_enabled;
    result.canPayOut = !!account.payouts_enabled;
    result.stripeStillNeeds = needs.needs;
    result.stripeIsChecking = needs.verifying;
  } catch {
    result.setupAccount = "unreachable (connected in another mode, under other keys, or removed in Stripe): connect again on Payments";
  }
  if (direct && club.stripeTerminalLocationId) {
    try {
      const readers = await stripe.terminal.readers.list({ location: club.stripeTerminalLocationId, limit: 100 }, onClub({ accountId: club.stripeAccountId, direct }));
      result.cardReaders = readers.data.map(r => ({ name: r.label, online: r.status === "online", simulated: String(r.device_type).startsWith("simulated") }));
    } catch {
      result.cardReaders = "couldn't load";
    }
  } else {
    result.cardReaders = [];
  }
  const unfinished = await db.select({ event: eventsTable.name, first: ridersTable.firstName, last: ridersTable.lastName, raceClass: registrationsTable.raceClass })
    .from(registrationsTable)
    .innerJoin(eventsTable, eq(registrationsTable.eventId, eventsTable.id))
    .leftJoin(ridersTable, eq(registrationsTable.riderId, ridersTable.id))
    .where(and(
      eq(eventsTable.clubId, ctx.clubId),
      isNotNull(registrationsTable.stripeSessionId),
      eq(registrationsTable.paymentStatus, "unpaid"),
      ne(registrationsTable.status, "void"),
      gt(registrationsTable.createdAt, new Date(Date.now() - 24 * 3600_000)),
    )).limit(10);
  result.unfinishedCardPaymentsLast24h = unfinished.map(u => ({ rider: [u.first, u.last].filter(Boolean).join(" "), class: u.raceClass, event: u.event }));
  return result;
}

async function resultsStatus(ctx: RockyToolContext, input: Record<string, unknown>) {
  const eventId = await ownedEventId(ctx, input.event_id);
  if (!eventId) return { error: "No event: open an event in RM Roost, or give an event id from this club." };
  const [event] = await db.select({ name: eventsTable.name, status: eventsTable.status, statsSentAt: eventsTable.statsEmailsSentAt, reminderSentAt: eventsTable.finalizeReminderSentAt })
    .from(eventsTable).where(eq(eventsTable.id, eventId));
  const finished = await db.select({ name: motosTable.name, raceClass: motosTable.raceClass, finalizedAt: motosTable.resultsFinalizedAt, completedAt: motosTable.completedAt })
    .from(motosTable)
    .where(and(eq(motosTable.eventId, eventId), eq(motosTable.status, "completed"), ne(motosTable.type, "practice")))
    .orderBy(motosTable.motoNumber);
  const [optIn] = await db.select({ n: sql<number>`count(distinct ${registrationsTable.riderId})::int` }).from(registrationsTable)
    .where(and(eq(registrationsTable.eventId, eventId), eq(registrationsTable.statsEmailOptIn, true), ne(registrationsTable.status, "void")));
  const unofficial = finished.filter(m => !m.finalizedAt);
  return {
    event: { name: event?.name, status: event?.status },
    finishedRaces: finished.length,
    unofficialRaces: unofficial.map(m => `${m.name} (${m.raceClass})`),
    allOfficial: finished.length > 0 && unofficial.length === 0,
    lastRaceFinishedMinutesAgo: minutesAgo(finished.map(m => m.completedAt).filter(Boolean).sort().at(-1) ?? null),
    raceDayStats: {
      ridersOptedIn: optIn?.n ?? 0,
      emailsSentMinutesAgo: minutesAgo(event?.statsSentAt ?? null),
      note: event?.statsSentAt ? "Sent once, when all results became official." : "Not sent yet: they go out when every finished race is finalized.",
    },
    finalizeReminderSentMinutesAgo: minutesAgo(event?.reminderSentAt ?? null),
  };
}

/** Run one diagnostic tool; returns JSON text for the tool_result. Never throws. */
export async function runRockyDiagnosticTool(name: string, input: unknown, ctx: RockyToolContext): Promise<{ content: string; isError: boolean }> {
  const args = input && typeof input === "object" && !Array.isArray(input) ? (input as Record<string, unknown>) : {};
  try {
    const result = name === "get_reader_status" ? await readerStatus(ctx)
      : name === "get_event_timing_status" ? await eventTimingStatus(ctx, args)
      : name === "find_rider_entry" ? await findRiderEntry(ctx, args)
      : name === "get_payments_status" ? await paymentsStatus(ctx)
      : name === "get_results_status" ? await resultsStatus(ctx, args)
      : null;
    if (result === null) return { content: `Unknown tool ${name}`, isError: true };
    return { content: JSON.stringify(result), isError: "error" in result };
  } catch (err) {
    return { content: `The lookup failed: ${err instanceof Error ? err.message : String(err)}`, isError: true };
  }
}
