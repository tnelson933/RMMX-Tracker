import { Router } from "express";
import { db } from "@workspace/db";
import { registrationsTable, ridersTable, checkinsTable, eventsTable, clubsTable } from "@workspace/db";
import { eq, and, sql } from "drizzle-orm";

const router = Router();

router.get("/events/:eventId/registrations", async (req, res) => {
  const eventId = Number(req.params.eventId);
  const regs = await db.select({
    id: registrationsTable.id,
    eventId: registrationsTable.eventId,
    riderId: registrationsTable.riderId,
    raceClass: registrationsTable.raceClass,
    status: registrationsTable.status,
    paymentStatus: registrationsTable.paymentStatus,
    amountPaid: registrationsTable.amountPaid,
    bibNumber: registrationsTable.bibNumber,
    createdAt: registrationsTable.createdAt,
    firstName: ridersTable.firstName,
    lastName: ridersTable.lastName,
  }).from(registrationsTable)
    .leftJoin(ridersTable, eq(registrationsTable.riderId, ridersTable.id))
    .where(eq(registrationsTable.eventId, eventId))
    .orderBy(registrationsTable.createdAt);

  return res.json(regs.map(r => ({
    id: r.id,
    eventId: r.eventId,
    riderId: r.riderId,
    riderName: `${r.firstName} ${r.lastName}`,
    raceClass: r.raceClass,
    status: r.status,
    paymentStatus: r.paymentStatus,
    amountPaid: r.amountPaid ? Number(r.amountPaid) : null,
    bibNumber: r.bibNumber,
    createdAt: r.createdAt.toISOString(),
  })));
});

router.post("/events/:eventId/registrations", async (req, res) => {
  const eventId = Number(req.params.eventId);
  const { riderId, raceClass, bibNumber } = req.body;
  if (!riderId || !raceClass) return res.status(400).json({ error: "riderId and raceClass required" });

  const [reg] = await db.insert(registrationsTable).values({
    eventId, riderId, raceClass, bibNumber, status: "confirmed", paymentStatus: "unpaid",
  }).returning();

  // Auto-create checkin record
  await db.insert(checkinsTable).values({
    eventId, riderId, raceClass, bibNumber, checkedIn: false, rfidLinked: false,
  }).onConflictDoNothing();

  const riders = await db.select().from(ridersTable).where(eq(ridersTable.id, riderId));
  const rider = riders[0];

  return res.status(201).json({
    ...reg,
    riderName: rider ? `${rider.firstName} ${rider.lastName}` : "",
    amountPaid: null,
    createdAt: reg.createdAt.toISOString(),
  });
});

router.patch("/registrations/:registrationId", async (req, res) => {
  const id = Number(req.params.registrationId);
  const { status, paymentStatus, raceClass, bibNumber } = req.body;
  const updates: Record<string, unknown> = {};
  if (status !== undefined) updates.status = status;
  if (paymentStatus !== undefined) updates.paymentStatus = paymentStatus;
  if (raceClass !== undefined) updates.raceClass = raceClass;
  if (bibNumber !== undefined) updates.bibNumber = bibNumber;

  const [reg] = await db.update(registrationsTable).set(updates as any).where(eq(registrationsTable.id, id)).returning();
  if (!reg) return res.status(404).json({ error: "Not found" });

  const riders = await db.select().from(ridersTable).where(eq(ridersTable.id, reg.riderId));
  const rider = riders[0];
  return res.json({
    ...reg,
    riderName: rider ? `${rider.firstName} ${rider.lastName}` : "",
    amountPaid: reg.amountPaid ? Number(reg.amountPaid) : null,
    createdAt: reg.createdAt.toISOString(),
  });
});

// ── Public: event info for the registration form ─────────────────────────────
router.get("/public/events/:eventId/register-info", async (req, res) => {
  const eventId = Number(req.params.eventId);
  const rows = await db.select({
    id: eventsTable.id,
    name: eventsTable.name,
    date: eventsTable.date,
    state: eventsTable.state,
    location: eventsTable.location,
    trackName: eventsTable.trackName,
    raceClasses: eventsTable.raceClasses,
    status: eventsTable.status,
    entryFee: eventsTable.entryFee,
    maxRiders: eventsTable.maxRiders,
    registrationOpen: eventsTable.registrationOpen,
    registrationClose: eventsTable.registrationClose,
    clubName: clubsTable.name,
  }).from(eventsTable)
    .leftJoin(clubsTable, eq(eventsTable.clubId, clubsTable.id))
    .where(eq(eventsTable.id, eventId));

  if (!rows[0]) return res.status(404).json({ error: "Event not found" });
  const e = rows[0];
  return res.json({
    ...e,
    entryFee: e.entryFee ? Number(e.entryFee) : null,
  });
});

// ── Public: self-service rider registration ───────────────────────────────────
router.post("/public/events/:eventId/register", async (req, res) => {
  const eventId = Number(req.params.eventId);
  const { firstName, lastName, email, phone, dateOfBirth, emergencyContact, emergencyPhone, raceClass, bibNumber } = req.body;

  if (!firstName || !lastName || !email || !raceClass) {
    return res.status(400).json({ error: "firstName, lastName, email, and raceClass are required" });
  }

  // Confirm event exists and is open for registration
  const events = await db.select().from(eventsTable).where(eq(eventsTable.id, eventId));
  if (!events[0]) return res.status(404).json({ error: "Event not found" });
  if (events[0].status !== "registration_open") {
    return res.status(409).json({ error: "Registration is not currently open for this event" });
  }
  const now = new Date();
  if (events[0].registrationOpen && now < new Date(events[0].registrationOpen)) {
    return res.status(409).json({ error: "Registration has not opened yet for this event" });
  }
  if (events[0].registrationClose && now > new Date(events[0].registrationClose)) {
    return res.status(409).json({ error: "Registration has closed for this event" });
  }
  if (events[0].raceClasses && !events[0].raceClasses.includes(raceClass)) {
    return res.status(400).json({ error: "Invalid race class for this event" });
  }

  // Enforce per-class rider limit
  const limits = (events[0].raceClassLimits ?? {}) as Record<string, number | null>;
  const classLimit = limits[raceClass];
  if (classLimit != null && classLimit > 0) {
    const classCount = await db.select({ count: sql<number>`count(*)::int` })
      .from(registrationsTable)
      .where(and(eq(registrationsTable.eventId, eventId), eq(registrationsTable.raceClass, raceClass)));
    if ((classCount[0]?.count ?? 0) >= classLimit) {
      return res.status(409).json({ error: `${raceClass} is full (${classLimit} rider limit reached)` });
    }
  }

  // Find or create rider by email
  let rider;
  const existing = await db.select().from(ridersTable).where(eq(ridersTable.email, email));
  if (existing[0]) {
    rider = existing[0];
  } else {
    const [created] = await db.insert(ridersTable).values({
      firstName, lastName, email, phone: phone || null,
      dateOfBirth: dateOfBirth || null,
      emergencyContact: emergencyContact || null,
      emergencyPhone: emergencyPhone || null,
      bibNumber: bibNumber || null,
    }).returning();
    rider = created;
  }

  // Prevent duplicate registration
  const dupes = await db.select().from(registrationsTable)
    .where(and(
      eq(registrationsTable.eventId, eventId),
      eq(registrationsTable.riderId, rider.id),
      eq(registrationsTable.raceClass, raceClass),
    ));
  if (dupes[0]) {
    return res.status(409).json({ error: "You are already registered for this class at this event" });
  }

  const [reg] = await db.insert(registrationsTable).values({
    eventId, riderId: rider.id, raceClass,
    bibNumber: bibNumber || rider.bibNumber || null,
    status: "confirmed", paymentStatus: "unpaid",
  }).returning();

  await db.insert(checkinsTable).values({
    eventId, riderId: rider.id, raceClass,
    bibNumber: bibNumber || rider.bibNumber || null,
    checkedIn: false, rfidLinked: false,
  }).onConflictDoNothing();

  return res.status(201).json({
    registrationId: reg.id,
    riderName: `${rider.firstName} ${rider.lastName}`,
    raceClass,
    eventName: events[0].name,
    eventDate: events[0].date,
  });
});

export default router;
