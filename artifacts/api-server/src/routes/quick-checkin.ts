import { Router } from "express";
import { db } from "@workspace/db";
import {
  eventsTable,
  registrationsTable,
  checkinsTable,
  rfidAssignmentsTable,
  ridersTable,
  riderAccountsTable,
  liabilityWaiverSignaturesTable,
} from "@workspace/db";
import { eq, and, ne, inArray } from "drizzle-orm";
import { sql } from "drizzle-orm";
import { requireRiderAuth } from "./rider-portal";
import { managedRiderWhere } from "../lib/riderAccess";

const router = Router();

// Riders see Check In within 1 mile of the track; the server allows a little
// more so GPS drift at the edge doesn't reject a rider who's really there.
export const QUICK_CHECKIN_RADIUS_MILES = 1;
const SERVER_RADIUS_MILES = 1.25;

// Haversine distance in miles between two lat/lng pairs
function distanceMiles(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 3958.8; // Earth radius in miles
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLng = ((lng2 - lng1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// GET /rider/quick-checkin-events
// Returns events where quick check-in is enabled and the rider is eligible today.
// Eligibility: quickCheckinEnabled=true, event is today (or first day for multi-day),
// rider registered (not void), not already checked in, required transponder/rfid/waiver met.
router.get("/rider/quick-checkin-events", requireRiderAuth, async (req, res) => {
  const riderAccountId = (req.session as any).riderAccountId as number;

  const [account] = await db
    .select()
    .from(riderAccountsTable)
    .where(eq(riderAccountsTable.id, riderAccountId));
  if (!account) return res.status(401).json({ error: "Not authenticated" });

  // Resolve all riders linked to this account by email
  const familyRiders = await db
    .select({ id: ridersTable.id, firstName: ridersTable.firstName, lastName: ridersTable.lastName, transponderId: ridersTable.mylapsTransponderId })
    .from(ridersTable)
    .where(await managedRiderWhere(account));

  if (familyRiders.length === 0) return res.json([]);

  const familyRiderIds = familyRiders.map(r => r.id);
  const transponderByRiderId = new Map(familyRiders.map(r => [r.id, r.transponderId]));
  const nameById = new Map(familyRiders.map(r => [r.id, `${r.firstName} ${r.lastName}`.trim()]));

  // "Today" anchored to Mountain Time (matches quickCheckinNotifier) so late-evening
  // riders aren't cut off when the UTC date rolls over at ~6pm MT.
  const todayStr = new Date().toLocaleDateString("en-CA", { timeZone: "America/Denver" });

  // Auto-advance any quick-checkin events whose date has arrived but status hasn't caught up.
  // This handles the case where registration is still "open" on race day (late close date).
  await db
    .update(eventsTable)
    .set({ status: "race_day" })
    .where(
      and(
        eq(eventsTable.quickCheckinEnabled, true),
        sql`${eventsTable.date}::date <= ${todayStr}::date`,
        inArray(eventsTable.status, ["draft", "registration_open", "registration_closed"]),
      )
    );

  // Fetch registrations for events that are: race_day status, quickCheckinEnabled, today
  const regs = await db
    .select({
      registrationId: registrationsTable.id,
      riderId: registrationsTable.riderId,
      eventId: registrationsTable.eventId,
      raceClass: registrationsTable.raceClass,
      bibNumber: registrationsTable.bibNumber,
      myLapsTransponderNumber: registrationsTable.myLapsTransponderNumber,
      regStatus: registrationsTable.status,
      waiverAcknowledgedAt: registrationsTable.waiverAcknowledgedAt,
      eventName: eventsTable.name,
      eventDate: eventsTable.date,
      eventEndDate: eventsTable.endDate,
      eventStatus: eventsTable.status,
      timingTechnology: eventsTable.timingTechnology,
      requireWaiver: eventsTable.requireWaiver,
      requireLiabilityWaiver: eventsTable.requireLiabilityWaiver,
      quickCheckinEnabled: eventsTable.quickCheckinEnabled,
      trackLat: eventsTable.trackLat,
      trackLng: eventsTable.trackLng,
      location: eventsTable.location,
      state: eventsTable.state,
      trackName: eventsTable.trackName,
       requireTransponder: eventsTable.requireTransponder,
    })
    .from(registrationsTable)
    .innerJoin(eventsTable, eq(registrationsTable.eventId, eventsTable.id))
    .where(
      and(
        inArray(registrationsTable.riderId, familyRiderIds),
        ne(registrationsTable.status, "void"),
        eq(eventsTable.quickCheckinEnabled, true),
        eq(eventsTable.status, "race_day"),
      )
    );

  if (regs.length === 0) return res.json([]);

  // Filter to today only (event.date === today, or for multi-day: start date === today)
  const todayRegs = regs.filter(r => {
    const eventDate = String(r.eventDate ?? "").substring(0, 10);
    return eventDate === todayStr;
  });

  if (todayRegs.length === 0) return res.json([]);

  const eventIds = [...new Set(todayRegs.map(r => r.eventId))];
  const riderIds = [...new Set(todayRegs.map(r => r.riderId))];

  // Check which riders are already checked in
  const checkins = await db
    .select({ eventId: checkinsTable.eventId, riderId: checkinsTable.riderId, raceClass: checkinsTable.raceClass, checkedIn: checkinsTable.checkedIn })
    .from(checkinsTable)
    .where(
      and(
        inArray(checkinsTable.eventId, eventIds),
        inArray(checkinsTable.riderId, riderIds),
        eq(checkinsTable.checkedIn, true),
      )
    );
  // Keyed per registration: event + rider + class
  const checkedInSet = new Set(checkins.map(c => `${c.eventId}:${c.riderId}:${c.raceClass}`));

  // Check RFID assignments for RFID events
  const rfidRows = await db
    .select({ riderId: rfidAssignmentsTable.riderId, eventId: rfidAssignmentsTable.eventId })
    .from(rfidAssignmentsTable)
    .where(
      and(
        inArray(rfidAssignmentsTable.riderId, riderIds),
        inArray(rfidAssignmentsTable.eventId, eventIds),
      )
    );
  const rfidSet = new Set(rfidRows.map(r => `${r.eventId}:${r.riderId}`));

  // Check waiver signatures for events that require them
  // A signature counts for a rider only when it is linked to one of that rider's
  // registrations for the event (the waiver is linked to the first class entry), never
  // merely because the signed-in account's email signed some waiver for the event.
  const waiverRows = await db
    .select({ eventId: liabilityWaiverSignaturesTable.eventId, riderId: registrationsTable.riderId })
    .from(liabilityWaiverSignaturesTable)
    .innerJoin(registrationsTable, and(
      eq(registrationsTable.id, liabilityWaiverSignaturesTable.registrationId),
      eq(registrationsTable.eventId, liabilityWaiverSignaturesTable.eventId),
    ))
    .where(inArray(liabilityWaiverSignaturesTable.eventId, eventIds));
  const waiverByRider = new Set(waiverRows.map(w => `${w.eventId}:${w.riderId}`));

  const results: Array<{
    eventId: number;
    eventName: string;
    eventDate: string;
    location: string | null;
    state: string;
    trackName: string | null;
    trackLat: number | null;
    trackLng: number | null;
    riderId: number;
    riderName: string;
    registrationId: number;
    raceClass: string | null;
    eligible: boolean;
    checkedIn: boolean;
    ineligibleReason: string | null;
  }> = [];

  for (const r of todayRegs) {
    const key = `${r.eventId}:${r.riderId}`;
    const checkedIn = checkedInSet.has(`${r.eventId}:${r.riderId}:${r.raceClass ?? "Unknown"}`);

    let eligible = true;
    let ineligibleReason: string | null = null;

    // RFID events: must have an RFID assignment for this event
    if (r.timingTechnology === "rfid" && !rfidSet.has(key)) {
      eligible = false;
      ineligibleReason = "missing_rfid";
    }

    // Active transponder events must have a registration-level or rider-level number.
    if (eligible && r.requireTransponder && ["active_transponder", "mylaps"].includes(r.timingTechnology)) {
      const hasRegTransponder = !!r.myLapsTransponderNumber;
      const hasRiderTransponder = !!transponderByRiderId.get(r.riderId);
      if (!hasRegTransponder && !hasRiderTransponder) {
        eligible = false;
        ineligibleReason = "missing_transponder";
      }
    }

    // Waiver check:
    // requireWaiver = simple acknowledgment stored on the registration row (waiver_acknowledged_at)
    // requireLiabilityWaiver = full PDF e-signature stored in liability_waiver_signatures
    if (eligible && r.requireWaiver && !r.requireLiabilityWaiver) {
      // Simple acknowledgment — satisfied by waiver_acknowledged_at on the registration
      if (!r.waiverAcknowledgedAt) {
        eligible = false;
        ineligibleReason = "missing_waiver";
      }
    } else if (eligible && r.requireLiabilityWaiver) {
      // Full liability waiver — must be in liability_waiver_signatures
      const hasWaiver = waiverByRider.has(`${r.eventId}:${r.riderId}`);
      if (!hasWaiver) {
        eligible = false;
        ineligibleReason = "missing_waiver";
      }
    }

    results.push({
      eventId: r.eventId,
      eventName: r.eventName,
      eventDate: String(r.eventDate ?? "").substring(0, 10),
      location: r.location ?? null,
      state: r.state,
      trackName: r.trackName ?? null,
      trackLat: r.trackLat ?? null,
      trackLng: r.trackLng ?? null,
      riderId: r.riderId,
      riderName: nameById.get(r.riderId) ?? "Rider",
      registrationId: r.registrationId,
      raceClass: r.raceClass ?? null,
      eligible,
      checkedIn,
      ineligibleReason,
    });
  }

  return res.json(results);
});

// GET /rider/quick-checkin-geofences
// Tracks to watch for the 1-mile arrival alert: this account's registrations
// (not void) for Quick Check-In events in the next 7 days that have a track
// location. The app registers these with the phone so the alert fires even
// when RM Roost is closed; it only notifies on the event's start date.
router.get("/rider/quick-checkin-geofences", requireRiderAuth, async (req, res) => {
  const riderAccountId = (req.session as any).riderAccountId as number;
  const [account] = await db.select().from(riderAccountsTable).where(eq(riderAccountsTable.id, riderAccountId));
  if (!account) return res.status(401).json({ error: "Not authenticated" });

  const riders = await db.select({ id: ridersTable.id }).from(ridersTable).where(await managedRiderWhere(account));
  if (riders.length === 0) return res.json({ radiusMiles: QUICK_CHECKIN_RADIUS_MILES, events: [] });

  const today = new Date().toLocaleDateString("en-CA", { timeZone: "America/Denver" });
  const weekOut = new Date(Date.now() + 7 * 86_400_000).toLocaleDateString("en-CA", { timeZone: "America/Denver" });
  const rows = await db
    .selectDistinct({
      eventId: eventsTable.id,
      eventName: eventsTable.name,
      eventDate: eventsTable.date,
      trackName: eventsTable.trackName,
      trackLat: eventsTable.trackLat,
      trackLng: eventsTable.trackLng,
    })
    .from(registrationsTable)
    .innerJoin(eventsTable, eq(registrationsTable.eventId, eventsTable.id))
    .where(and(
      inArray(registrationsTable.riderId, riders.map(r => r.id)),
      ne(registrationsTable.status, "void"),
      eq(eventsTable.quickCheckinEnabled, true),
      ne(eventsTable.status, "completed"),
      sql`${eventsTable.date}::date BETWEEN ${today}::date AND ${weekOut}::date`,
      sql`${eventsTable.trackLat} IS NOT NULL AND ${eventsTable.trackLng} IS NOT NULL`,
    ));

  return res.json({
    radiusMiles: QUICK_CHECKIN_RADIUS_MILES,
    events: rows.map(r => ({ ...r, eventDate: String(r.eventDate).substring(0, 10) })),
  });
});

// POST /events/:eventId/quick-checkin
// Self-service check-in for a rider. Validates eligibility then creates/updates a checkin row.
router.post("/events/:eventId/quick-checkin", requireRiderAuth, async (req, res) => {
  const riderAccountId = (req.session as any).riderAccountId as number;
  const eventId = Number(req.params.eventId);
  if (isNaN(eventId)) return res.status(400).json({ error: "Invalid eventId" });

  const { riderId: bodyRiderId, registrationId: bodyRegistrationId, latitude, longitude } =
    req.body as { riderId?: number; registrationId?: number; latitude?: number; longitude?: number };

  const [account] = await db
    .select()
    .from(riderAccountsTable)
    .where(eq(riderAccountsTable.id, riderAccountId));
  if (!account) return res.status(401).json({ error: "Not authenticated" });

  // Verify the event is eligible for quick check-in today
  const [event] = await db
    .select({
      id: eventsTable.id,
      quickCheckinEnabled: eventsTable.quickCheckinEnabled,
      status: eventsTable.status,
      date: eventsTable.date,
      timingTechnology: eventsTable.timingTechnology,
      requireWaiver: eventsTable.requireWaiver,
      requireLiabilityWaiver: eventsTable.requireLiabilityWaiver,
      requireTransponder: eventsTable.requireTransponder,
      trackLat: eventsTable.trackLat,
      trackLng: eventsTable.trackLng,
    })
    .from(eventsTable)
    .where(eq(eventsTable.id, eventId));

  if (!event) return res.status(404).json({ error: "Event not found" });
  if (!event.quickCheckinEnabled) return res.status(400).json({ error: "Quick check-in not enabled for this event" });
  if (event.status !== "race_day") return res.status(400).json({ error: "Event is not in race_day status" });

  // "Today" anchored to Mountain Time (matches quickCheckinNotifier) so late-evening
  // riders aren't cut off when the UTC date rolls over at ~6pm MT.
  const todayStr = new Date().toLocaleDateString("en-CA", { timeZone: "America/Denver" });
  if (String(event.date).substring(0, 10) !== todayStr) {
    return res.status(400).json({ error: "Quick check-in is only available on race day" });
  }

  // The rider has to be at the track. (Events whose track location couldn't be
  // found skip this; the organizer is warned when enabling Quick Check-In.)
  if (event.trackLat != null && event.trackLng != null) {
    const lat = Number(latitude);
    const lng = Number(longitude);
    if (latitude == null || longitude == null || !Number.isFinite(lat) || !Number.isFinite(lng)) {
      return res.status(400).json({ error: "Turn on location so we can confirm you're at the track" });
    }
    const miles = distanceMiles(lat, lng, event.trackLat, event.trackLng);
    if (miles > SERVER_RADIUS_MILES) {
      return res.status(403).json({ error: `You're ${miles.toFixed(1)} miles from the track. Quick Check-In opens within ${QUICK_CHECKIN_RADIUS_MILES} mile.`, distanceMiles: miles });
    }
  }

  // Confirm the rider belongs to this account
  const familyRiders = await db
    .select({ id: ridersTable.id, transponderId: ridersTable.mylapsTransponderId })
    .from(ridersTable)
    .where(await managedRiderWhere(account));

  const familyRiderIds = familyRiders.map(r => r.id);

  // Resolve the target registration: by registrationId if provided, otherwise by riderId
  let reg;
  let riderId: number;
  if (bodyRegistrationId) {
    const [row] = await db
      .select()
      .from(registrationsTable)
      .where(and(eq(registrationsTable.id, bodyRegistrationId), eq(registrationsTable.eventId, eventId), ne(registrationsTable.status, "void")));
    if (!row || !familyRiderIds.includes(row.riderId)) {
      return res.status(400).json({ error: "No active registration found" });
    }
    reg = row;
    riderId = row.riderId;
  } else {
    riderId = bodyRiderId && familyRiderIds.includes(bodyRiderId) ? bodyRiderId : familyRiderIds[0];
    if (!riderId) return res.status(400).json({ error: "No rider found for this account" });
    const [row] = await db
      .select()
      .from(registrationsTable)
      .where(and(eq(registrationsTable.eventId, eventId), eq(registrationsTable.riderId, riderId), ne(registrationsTable.status, "void")));
    if (!row) return res.status(400).json({ error: "No active registration found" });
    reg = row;
  }

  // RFID eligibility
  if (event.timingTechnology === "rfid") {
    const [rfid] = await db
      .select()
      .from(rfidAssignmentsTable)
      .where(and(eq(rfidAssignmentsTable.riderId, riderId), eq(rfidAssignmentsTable.eventId, eventId)));
    if (!rfid) return res.status(400).json({ error: "RFID not assigned — contact the organizer" });
  }

  // Active transponder eligibility (including legacy stored values).
  if (event.requireTransponder && ["active_transponder", "mylaps"].includes(event.timingTechnology)) {
    const riderRow = familyRiders.find(r => r.id === riderId);
    if (!reg.myLapsTransponderNumber && !riderRow?.transponderId) {
      return res.status(400).json({ error: "Active transponder number not assigned — contact the organizer" });
    }
  }

  // Waiver eligibility:
  // requireWaiver = simple acknowledgment on the registration row (waiver_acknowledged_at)
  // requireLiabilityWaiver = full PDF e-signature in liability_waiver_signatures
  if (event.requireWaiver && !event.requireLiabilityWaiver) {
    if (!reg.waiverAcknowledgedAt) {
      return res.status(400).json({ error: "Waiver not signed — please complete the waiver before checking in" });
    }
  } else if (event.requireLiabilityWaiver) {
    // Must be linked to one of this rider's registrations for the event (any class entry).
    const [sig] = await db
      .select({ id: liabilityWaiverSignaturesTable.id })
      .from(liabilityWaiverSignaturesTable)
      .innerJoin(registrationsTable, eq(registrationsTable.id, liabilityWaiverSignaturesTable.registrationId))
      .where(and(
        eq(liabilityWaiverSignaturesTable.eventId, eventId),
        eq(registrationsTable.eventId, eventId),
        eq(registrationsTable.riderId, riderId),
      ))
      .limit(1);
    const hasSig = !!sig;
    if (!hasSig) return res.status(400).json({ error: "Waiver not signed — please complete the waiver before checking in" });
  }

  // Check if already checked in (scoped to this registration's class)
  const [existing] = await db
    .select()
    .from(checkinsTable)
    .where(and(
      eq(checkinsTable.eventId, eventId),
      eq(checkinsTable.riderId, riderId),
      eq(checkinsTable.raceClass, reg.raceClass ?? "Unknown"),
    ));

  if (existing?.checkedIn) {
    return res.json({ ok: true, alreadyCheckedIn: true, checkin: existing });
  }

  let checkin;
  if (existing) {
    const [updated] = await db
      .update(checkinsTable)
      .set({ checkedIn: true, checkedInAt: new Date() })
      .where(eq(checkinsTable.id, existing.id))
      .returning();
    checkin = updated;
  } else {
    const [created] = await db
      .insert(checkinsTable)
      .values({
        eventId,
        riderId,
        raceClass: reg.raceClass ?? "Unknown",
        bibNumber: reg.bibNumber ?? null,
        checkedIn: true,
        checkedInAt: new Date(),
        rfidLinked: false,
      })
      .returning();
    checkin = created;
  }

  req.log.info({ eventId, riderId, riderAccountId }, "Quick check-in completed");
  return res.json({ ok: true, alreadyCheckedIn: false, checkin });
});

export default router;
