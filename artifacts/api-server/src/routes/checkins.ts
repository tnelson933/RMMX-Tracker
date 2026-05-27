import { Router } from "express";
import { db } from "@workspace/db";
import { checkinsTable, ridersTable, rfidAssignmentsTable, registrationsTable } from "@workspace/db";
import { eq, and, ne } from "drizzle-orm";

const router = Router();

// List all registered riders for an event with their check-in status overlaid.
// Source of truth is registrations — every registered rider appears here.
router.get("/events/:eventId/checkins", async (req, res) => {
  const eventId = Number(req.params.eventId);

  // Fetch all registrations + rider info
  const regs = await db.select({
    registrationId: registrationsTable.id,
    riderId: registrationsTable.riderId,
    raceClass: registrationsTable.raceClass,
    bibNumber: registrationsTable.bibNumber,
    firstName: ridersTable.firstName,
    lastName: ridersTable.lastName,
  }).from(registrationsTable)
    .leftJoin(ridersTable, eq(registrationsTable.riderId, ridersTable.id))
    .where(and(eq(registrationsTable.eventId, eventId), ne(registrationsTable.status, "void")))
    .orderBy(ridersTable.lastName);

  if (regs.length === 0) return res.json([]);

  // Fetch all existing checkin rows for the event in one query
  const checkinRows = await db.select().from(checkinsTable)
    .where(eq(checkinsTable.eventId, eventId));

  const checkinByRider = new Map(checkinRows.map(c => [c.riderId, c]));

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
      checkedIn: c?.checkedIn ?? false,
      checkedInAt: c?.checkedInAt?.toISOString() ?? null,
      rfidNumber: c?.rfidNumber ?? null,
      rfidLinked: c?.rfidLinked ?? false,
    };
  }));
});

router.post("/events/:eventId/checkins", async (req, res) => {
  const eventId = Number(req.params.eventId);
  const { riderId, rfidNumber, bibNumber } = req.body;
  if (!riderId) return res.status(400).json({ error: "riderId required" });

  // Look up the registration for class info
  const regs = await db.select().from(registrationsTable)
    .where(and(eq(registrationsTable.eventId, eventId), eq(registrationsTable.riderId, riderId)));
  const raceClass = regs[0]?.raceClass ?? "Unknown";
  const regBib = regs[0]?.bibNumber ?? null;

  const existing = await db.select().from(checkinsTable)
    .where(and(eq(checkinsTable.eventId, eventId), eq(checkinsTable.riderId, riderId)));

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
