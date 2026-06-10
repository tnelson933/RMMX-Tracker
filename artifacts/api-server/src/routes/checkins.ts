import { Router } from "express";
import { db } from "@workspace/db";
import { checkinsTable, ridersTable, rfidAssignmentsTable, registrationsTable, eventsTable } from "@workspace/db";
import { eq, and, ne, asc } from "drizzle-orm";

const router = Router();

function getStaffClubId(res: any): number | null {
  const v = res.locals?.staffClubId;
  return typeof v === "number" ? v : null;
}

async function checkEventOwnership(eventId: number, staffCId: number | null, res: any): Promise<boolean> {
  if (staffCId === null) return true;
  const [evt] = await db.select({ clubId: eventsTable.clubId }).from(eventsTable).where(eq(eventsTable.id, eventId));
  if (!evt || evt.clubId !== staffCId) { res.status(403).json({ error: "Forbidden" }); return false; }
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

  return res.json(regs.map(r => {
    const c = checkinByRider.get(r.riderId);
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
      checkedIn: c?.checkedIn ?? false,
      checkedInAt: c?.checkedInAt?.toISOString() ?? null,
      rfidNumber: c?.rfidNumber ?? null,
      rfidLinked: c?.rfidLinked ?? false,
    };
  }));
});

router.post("/events/:eventId/checkins", async (req, res) => {
  const eventId = Number(req.params.eventId);
  if (!await checkEventOwnership(eventId, getStaffClubId(res), res)) return;
  const { riderId, rfidNumber, bibNumber } = req.body;
  if (!riderId) return res.status(400).json({ error: "riderId required" });

  // Look up the registration for class info
  const regs = await db.select().from(registrationsTable)
    .where(and(eq(registrationsTable.eventId, eventId), eq(registrationsTable.riderId, riderId)));
  const raceClass = regs[0]?.raceClass ?? "Unknown";
  const regBib = regs[0]?.bibNumber ?? null;

  const existing = await db.select().from(checkinsTable)
    .where(and(eq(checkinsTable.eventId, eventId), eq(checkinsTable.riderId, riderId)))
    .orderBy(asc(checkinsTable.id))
    .limit(1);

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
    await db.update(ridersTable).set({ rfidNumber }).where(eq(ridersTable.id, checkin.riderId));
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

export default router;
