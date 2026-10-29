import { Router } from "express";
import { db } from "@workspace/db";
import { checkinsTable, ridersTable, rfidAssignmentsTable, registrationsTable, eventsTable, motosTable, liabilityWaiverSignaturesTable } from "@workspace/db";
import { eq, and, ne, asc, isNull } from "drizzle-orm";
import { fulfillRmTrackr } from "../lib/rmTrackr";
import { splitRegistrationTag } from "../lib/eventTimingTags";

const router = Router();

function getStaffClubId(res: any): number | null {
  const v = res.locals?.staffClubId;
  return typeof v === "number" ? v : null;
}

async function checkEventOwnership(eventId: number, staffCId: number | null, res: any): Promise<boolean> {
  if (staffCId === null) return true;
  const [evt] = await db.select({ clubId: eventsTable.clubId }).from(eventsTable).where(eq(eventsTable.id, eventId));
  if (!evt || evt.clubId !== staffCId) { res.status(403).json({ error: "Your account doesn't have access to this. If it should, ask your club's owner to check your role on the Team page." }); return false; }
  return true;
}

// List all registered riders for an event with their check-in status overlaid.
// Source of truth is registrations — every registered rider appears here.
router.get("/events/:eventId/checkins", async (req, res) => {
  const eventId = Number(req.params.eventId);
  if (!await checkEventOwnership(eventId, getStaffClubId(res), res)) return;

  // Fetch all registrations + rider info
  const regs = await db.select({
    registrationId: registrationsTable.id,
    riderId: registrationsTable.riderId,
    raceClass: registrationsTable.raceClass,
    bibNumber: registrationsTable.bibNumber,
    myLapsTransponderNumber: registrationsTable.myLapsTransponderNumber,
    transponderRental: registrationsTable.transponderRental,
    transponderReturned: registrationsTable.transponderReturned,
    rfidStickerPurchased: registrationsTable.rfidStickerPurchased,
    rmTrackrPurchased: registrationsTable.rmTrackrPurchased,
    rmTrackrFulfilledAt: registrationsTable.rmTrackrFulfilledAt,
    rmTrackrTransponder: registrationsTable.rmTrackrTransponder,
    paymentStatus: registrationsTable.paymentStatus,
    firstName: ridersTable.firstName,
    lastName: ridersTable.lastName,
    email: ridersTable.email,
    phone: ridersTable.phone,
  }).from(registrationsTable)
    .leftJoin(ridersTable, eq(registrationsTable.riderId, ridersTable.id))
    .where(and(eq(registrationsTable.eventId, eventId), ne(registrationsTable.status, "void")))
    .orderBy(ridersTable.lastName);

  if (regs.length === 0) return res.json([]);

  // Fetch all existing checkin rows for the event in one query.
  // Order by id ascending so that if duplicates exist, the first (canonical) row
  // ends up in the map — later entries for the same riderId are ignored.
  const checkinRows = await db.select().from(checkinsTable)
    .where(eq(checkinsTable.eventId, eventId))
    .orderBy(asc(checkinsTable.id));

  const checkinByRider = new Map<number, typeof checkinRows[0]>();
  for (const c of checkinRows) {
    if (!checkinByRider.has(c.riderId)) checkinByRider.set(c.riderId, c);
  }

  // Fetch all waiver signatures for this event to compute waiverSigned per rider.
  const sigRows = await db
    .select({ signerEmail: liabilityWaiverSignaturesTable.signerEmail })
    .from(liabilityWaiverSignaturesTable)
    .where(eq(liabilityWaiverSignaturesTable.eventId, eventId));
  const signedEmails = new Set(sigRows.map(s => s.signerEmail.toLowerCase()));

  // RFID stickers assigned for this event. An event can use RM TrackR loops and
  // RFID readers together, so a rider may have a transponder and a sticker.
  const stickerRows = await db.select({ riderId: rfidAssignmentsTable.riderId, rfidNumber: rfidAssignmentsTable.rfidNumber })
    .from(rfidAssignmentsTable)
    // Stickers only: a rental transponder link has an expiry.
    .where(and(eq(rfidAssignmentsTable.eventId, eventId), isNull(rfidAssignmentsTable.expiresAt)))
    .orderBy(asc(rfidAssignmentsTable.id));
  const stickerByRider = new Map<number, string>();
  for (const a of stickerRows) stickerByRider.set(a.riderId, a.rfidNumber);

  return res.json(regs.map(r => {
    const c = checkinByRider.get(r.riderId);
    const riderEmail = r.email?.toLowerCase() ?? null;
    const timingNumber = c?.rfidNumber ?? r.myLapsTransponderNumber ?? null;
    // An old sticker number copied into the transponder field counts as the sticker.
    const regTag = splitRegistrationTag(r.myLapsTransponderNumber);
    const transponderNumber = regTag.transponder;
    // Older registrations also stored the transponder as a sticker row: skip that.
    const sticker = stickerByRider.get(r.riderId) ?? null;
    const rfidTag = (sticker && sticker.trim().toLowerCase() !== transponderNumber?.toLowerCase() ? sticker : null) ?? regTag.sticker;
    return {
      id: c?.id ?? null,
      eventId,
      riderId: r.riderId,
      registrationId: r.registrationId,
      riderName: `${r.firstName ?? ""} ${r.lastName ?? ""}`.trim(),
      raceClass: r.raceClass,
      registrationBib: r.bibNumber ?? null,
      bibNumber: r.bibNumber ?? c?.bibNumber ?? null,
      email: r.email ?? null,
      phone: r.phone ?? null,
      myLapsTransponderNumber: r.myLapsTransponderNumber ?? null,
      transponderRental: r.transponderRental ?? false,
      transponderReturned: r.transponderReturned ?? false,
      rfidStickerPurchased: r.rfidStickerPurchased ?? false,
      rmTrackrPurchased: r.rmTrackrPurchased ?? false,
      rmTrackrFulfilledAt: r.rmTrackrFulfilledAt?.toISOString() ?? null,
      rmTrackrTransponder: r.rmTrackrTransponder ?? null,
      paymentStatus: r.paymentStatus ?? null,
      checkedIn: c?.checkedIn ?? false,
      checkedInAt: c?.checkedInAt?.toISOString() ?? null,
      rfidNumber: timingNumber,
      rfidLinked: Boolean(c?.rfidLinked || timingNumber),
      // Each kind of tag on its own (rfidNumber above is whichever was set last).
      transponderNumber,
      rfidTag,
      waiverSigned: riderEmail ? signedEmails.has(riderEmail) : false,
    };
  }));
});

router.post("/events/:eventId/checkins", async (req, res) => {
  const eventId = Number(req.params.eventId);
  if (!await checkEventOwnership(eventId, getStaffClubId(res), res)) return;
  const { riderId, rfidNumber, bibNumber, checkedIn } = req.body;
  if (!riderId) return res.status(400).json({ error: "Pick a rider first." });
  // `checkedIn: false` un-checks the rider (e.g. dragging a pool rider to the trash
  // in Motos). Any other value, including omitted, checks the rider in. Matches the
  // local server.
  const uncheck = checkedIn === false;

  // Look up the registration for class info
  const regs = await db.select().from(registrationsTable)
    .where(and(eq(registrationsTable.eventId, eventId), eq(registrationsTable.riderId, riderId)));
  const raceClass = regs[0]?.raceClass ?? "Unknown";
  const regBib = regs[0]?.bibNumber ?? null;

  const existing = await db.select().from(checkinsTable)
    .where(and(eq(checkinsTable.eventId, eventId), eq(checkinsTable.riderId, riderId)))
    .orderBy(asc(checkinsTable.id))
    .limit(1);

  if (uncheck) {
    if (!existing[0]) {
      // Nothing to un-check: never insert a row just to mark it not checked in.
      return res.json({
        id: null, eventId, riderId: Number(riderId), riderName: "", raceClass,
        bibNumber: regBib, checkedIn: false, checkedInAt: null, rfidNumber: null, rfidLinked: false,
      });
    }
    const [unchecked] = await db.update(checkinsTable)
      .set({ checkedIn: false, checkedInAt: null })
      .where(eq(checkinsTable.id, existing[0].id))
      .returning();
    const [uncheckedRider] = await db.select().from(ridersTable).where(eq(ridersTable.id, unchecked.riderId));
    return res.json({
      id: unchecked.id,
      eventId: unchecked.eventId,
      riderId: unchecked.riderId,
      riderName: uncheckedRider ? `${uncheckedRider.firstName} ${uncheckedRider.lastName}` : "",
      raceClass: unchecked.raceClass,
      bibNumber: unchecked.bibNumber,
      checkedIn: unchecked.checkedIn,
      checkedInAt: null,
      rfidNumber: unchecked.rfidNumber,
      rfidLinked: unchecked.rfidLinked,
    });
  }

  let checkin;
  if (existing[0]) {
    const updates: Record<string, unknown> = {
      checkedIn: true,
      checkedInAt: new Date(),
    };
    if (rfidNumber !== undefined) {
      updates.rfidNumber = rfidNumber;
      updates.rfidLinked = !!rfidNumber;
    }
    if (bibNumber !== undefined) updates.bibNumber = bibNumber;

    const [updated] = await db.update(checkinsTable).set(updates as any)
      .where(eq(checkinsTable.id, existing[0].id)).returning();
    checkin = updated;
  } else {
    const [created] = await db.insert(checkinsTable).values({
      eventId,
      riderId,
      raceClass,
      bibNumber: bibNumber ?? regBib ?? null,
      checkedIn: true,
      checkedInAt: new Date(),
      rfidNumber,
      rfidLinked: !!rfidNumber,
    }).returning();
    checkin = created;
  }

  if (rfidNumber) {
    // A transponder number sent here (the check-in row's last-set tag) stays a
    // transponder: only a sticker goes on the profile's RFID field.
    const isTransponder = regs.some(r => r.myLapsTransponderNumber?.trim().toLowerCase() === String(rfidNumber).trim().toLowerCase());
    if (isTransponder) await fulfillRmTrackr(eventId, checkin.riderId, rfidNumber);
    else await db.update(ridersTable).set({ rfidNumber }).where(eq(ridersTable.id, checkin.riderId));
  }

  // Auto-slot rider into pre-generated lineup slots (created via useRegistrations).
  // If any scheduled moto for this event+class has a lineup entry with checkedIn: false
  // for this rider, flip it to true and fill in the latest bib/rfid.
  {
    const eventMotos = await db
      .select({ id: motosTable.id, lineup: motosTable.lineup, status: motosTable.status })
      .from(motosTable)
      .where(and(eq(motosTable.eventId, eventId), eq(motosTable.raceClass, raceClass)));

    for (const moto of eventMotos) {
      if (moto.status === "completed") continue;
      const lineup = Array.isArray(moto.lineup) ? (moto.lineup as Array<Record<string, unknown>>) : [];
      const idx = lineup.findIndex(entry => entry.riderId === checkin.riderId);
      if (idx < 0) continue;
      if (lineup[idx].checkedIn === true) continue; // already marked
      const updatedLineup = lineup.map((entry, i) =>
        i === idx
          ? { ...entry, checkedIn: true, bibNumber: checkin.bibNumber ?? entry.bibNumber, rfidNumber: checkin.rfidNumber ?? entry.rfidNumber }
          : entry
      );
      await db.update(motosTable).set({ lineup: updatedLineup }).where(eq(motosTable.id, moto.id));
    }
  }

  // Sync the confirmed bib from the saved checkin row back to the registration.
  // Use checkin.riderId (typed integer from DB) — not riderId from req.body — to
  // avoid any string/integer mismatch in the Drizzle WHERE clause.
  if (checkin.bibNumber) {
    await db.update(registrationsTable)
      .set({ bibNumber: checkin.bibNumber })
      .where(and(
        eq(registrationsTable.eventId, checkin.eventId),
        eq(registrationsTable.riderId, checkin.riderId),
      ));
  }

  const riders = await db.select().from(ridersTable).where(eq(ridersTable.id, riderId));
  const rider = riders[0];

  return res.json({
    id: checkin.id,
    eventId: checkin.eventId,
    riderId: checkin.riderId,
    riderName: rider ? `${rider.firstName} ${rider.lastName}` : "",
    raceClass: checkin.raceClass,
    bibNumber: checkin.bibNumber,
    checkedIn: checkin.checkedIn,
    checkedInAt: checkin.checkedInAt?.toISOString() ?? null,
    rfidNumber: checkin.rfidNumber,
    rfidLinked: checkin.rfidLinked,
  });
});

// Delete all checkin records for an event (organizer/super_admin only).
// Does NOT touch registrations — riders remain registered, just not checked in.
router.delete("/events/:eventId/checkins", async (req, res) => {
  const eventId = Number(req.params.eventId);
  if (!await checkEventOwnership(eventId, getStaffClubId(res), res)) return;
  const deleted = await db.delete(checkinsTable).where(eq(checkinsTable.eventId, eventId)).returning({ id: checkinsTable.id });
  return res.json({ deleted: deleted.length });
});

// Delete a single checkin record by ID, un-checking that rider in.
router.delete("/events/:eventId/checkins/:checkinId", async (req, res) => {
  const eventId = Number(req.params.eventId);
  const checkinId = Number(req.params.checkinId);
  if (!await checkEventOwnership(eventId, getStaffClubId(res), res)) return;
  const [deleted] = await db.delete(checkinsTable)
    .where(and(eq(checkinsTable.id, checkinId), eq(checkinsTable.eventId, eventId)))
    .returning({ id: checkinsTable.id });
  if (!deleted) return res.status(404).json({ error: "This check-in couldn't be found. It may have been deleted. Refresh the page and try again." });
  return res.json({ deleted: 1 });
});

export default router;
