import { Router } from "express";
import { db } from "@workspace/db";
import { registrationsTable, ridersTable, checkinsTable, eventsTable, clubsTable } from "@workspace/db";
import { eq, and, sql } from "drizzle-orm";
import { getUncachableStripeClient } from "../stripeClient";

const router = Router();

function getAppUrl(): string {
  if (process.env.APP_URL) return process.env.APP_URL;
  const domains = process.env.REPLIT_DOMAINS;
  if (domains) return `https://${domains.split(",")[0]}`;
  return "http://localhost:80";
}

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
  const {
    riderId, raceClass, bibNumber,
    // Full on-site rider info (alternative to riderId)
    firstName, lastName, email, phone, dateOfBirth, emergencyContact, emergencyPhone,
  } = req.body;

  if (!raceClass) return res.status(400).json({ error: "raceClass required" });

  let resolvedRiderId: number;

  if (riderId) {
    resolvedRiderId = Number(riderId);
  } else if (firstName && lastName && email) {
    // Find or create rider by email
    const existing = await db.select().from(ridersTable).where(eq(ridersTable.email, email));
    if (existing[0]) {
      resolvedRiderId = existing[0].id;
    } else {
      const [created] = await db.insert(ridersTable).values({
        firstName, lastName, email,
        phone: phone || null,
        dateOfBirth: dateOfBirth || null,
        emergencyContact: emergencyContact || null,
        emergencyPhone: emergencyPhone || null,
        bibNumber: bibNumber || null,
      }).returning();
      resolvedRiderId = created.id;
    }
  } else {
    return res.status(400).json({ error: "riderId OR firstName, lastName, and email are required" });
  }

  // Prevent duplicate registrations in the same class
  const dupes = await db.select().from(registrationsTable).where(and(
    eq(registrationsTable.eventId, eventId),
    eq(registrationsTable.riderId, resolvedRiderId),
    eq(registrationsTable.raceClass, raceClass),
  ));
  if (dupes[0]) {
    return res.status(409).json({ error: "This rider is already registered for that class at this event" });
  }

  const [reg] = await db.insert(registrationsTable).values({
    eventId, riderId: resolvedRiderId, raceClass,
    bibNumber: bibNumber || null,
    status: "confirmed", paymentStatus: "unpaid",
  }).returning();

  await db.insert(checkinsTable).values({
    eventId, riderId: resolvedRiderId, raceClass,
    bibNumber: bibNumber || null,
    checkedIn: false, rfidLinked: false,
  }).onConflictDoNothing();

  const riders = await db.select().from(ridersTable).where(eq(ridersTable.id, resolvedRiderId));
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
  const { status, paymentStatus, raceClass, bibNumber, amountPaid } = req.body;
  const updates: Record<string, unknown> = {};
  if (status !== undefined) updates.status = status;
  if (paymentStatus !== undefined) updates.paymentStatus = paymentStatus;
  if (raceClass !== undefined) updates.raceClass = raceClass;
  if (bibNumber !== undefined) updates.bibNumber = bibNumber;
  if (amountPaid !== undefined) updates.amountPaid = String(amountPaid);

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

// ── Organizer: create a Stripe Checkout session for an existing on-site registration ──
router.post("/events/:eventId/registrations/:regId/charge", async (req, res) => {
  const eventId = Number(req.params.eventId);
  const regId = Number(req.params.regId);

  try {
    const [reg] = await db.select().from(registrationsTable).where(eq(registrationsTable.id, regId));
    if (!reg) return res.status(404).json({ error: "Registration not found" });
    if (reg.eventId !== eventId) return res.status(403).json({ error: "Registration does not belong to this event" });

    const [event] = await db.select().from(eventsTable).where(eq(eventsTable.id, eventId));
    if (!event?.entryFee) return res.status(400).json({ error: "This event has no entry fee configured" });

    const [club] = await db.select().from(clubsTable).where(eq(clubsTable.id, event.clubId));
    if (!club?.stripeAccountId) return res.status(400).json({ error: "Club has no Stripe account configured. Use cash payment instead." });

    const stripe = await getUncachableStripeClient();
    const appUrl = getAppUrl();
    const entryFee = Number(event.entryFee);

    const [rider] = await db.select().from(ridersTable).where(eq(ridersTable.id, reg.riderId));

    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      line_items: [{
        price_data: {
          currency: "usd",
          product_data: {
            name: `${event.name} — ${reg.raceClass} Entry`,
          },
          unit_amount: Math.round(entryFee * 100),
        },
        quantity: 1,
      }],
      customer_email: rider?.email ?? undefined,
      payment_intent_data: {
        transfer_data: { destination: club.stripeAccountId },
      },
      metadata: { registrationId: String(regId) },
      success_url: `${appUrl}/events/${eventId}/registrations`,
      cancel_url: `${appUrl}/events/${eventId}/registrations`,
    });

    return res.json({ checkoutUrl: session.url, sessionId: session.id, entryFee });
  } catch (err: any) {
    req.log?.error({ err: err?.message }, "[charge] Error");
    return res.status(500).json({ error: err?.message ?? "Failed to create checkout session" });
  }
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
    paymentEnabled: eventsTable.paymentEnabled,
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

  // Determine if payment is required
  const needsPayment = !!events[0].paymentEnabled && events[0].entryFee != null;
  const regStatus = needsPayment ? "pending" : "confirmed";

  const [reg] = await db.insert(registrationsTable).values({
    eventId, riderId: rider.id, raceClass,
    bibNumber: bibNumber || rider.bibNumber || null,
    status: regStatus, paymentStatus: "unpaid",
  }).returning();

  // Only create the check-in record now if no payment is required.
  // For payment-required registrations, the checkin is created after payment is confirmed.
  if (!needsPayment) {
    await db.insert(checkinsTable).values({
      eventId, riderId: rider.id, raceClass,
      bibNumber: bibNumber || rider.bibNumber || null,
      checkedIn: false, rfidLinked: false,
    }).onConflictDoNothing();
  }

  // If payment required, create Stripe Checkout session
  if (needsPayment && events[0].entryFee) {
    try {
      const [club] = await db.select().from(clubsTable).where(eq(clubsTable.id, events[0].clubId));
      if (club?.stripeAccountId) {
        const stripe = await getUncachableStripeClient();
        const appUrl = getAppUrl();
        const entryFee = Number(events[0].entryFee);

        const session = await stripe.checkout.sessions.create({
          mode: "payment",
          line_items: [{
            price_data: {
              currency: "usd",
              product_data: {
                name: `${events[0].name} — ${raceClass} Entry`,
              },
              unit_amount: Math.round(entryFee * 100),
            },
            quantity: 1,
          }],
          payment_intent_data: {
            transfer_data: {
              destination: club.stripeAccountId,
            },
          },
          success_url: `${appUrl}/register/${eventId}?reg_id=${reg.id}&session_id={CHECKOUT_SESSION_ID}&payment_success=1`,
          cancel_url: `${appUrl}/register/${eventId}?payment_cancelled=1`,
          metadata: {
            registrationId: String(reg.id),
            eventId: String(eventId),
          },
          customer_email: email,
        });

        if (session.url) {
          return res.status(201).json({
            requiresPayment: true,
            checkoutUrl: session.url,
            sessionId: session.id,
            registrationId: reg.id,
            riderName: `${rider.firstName} ${rider.lastName}`,
            raceClass,
            eventName: events[0].name,
            entryFee,
          });
        }
      }
    } catch (err: any) {
      req.log?.warn({ err: err?.message }, "[checkout] Failed to create Stripe Checkout session — registering without payment");
      // Fall back: confirm registration without payment gate
      await db.update(registrationsTable)
        .set({ status: "confirmed" })
        .where(eq(registrationsTable.id, reg.id));
    }
  }

  return res.status(201).json({
    registrationId: reg.id,
    riderName: `${rider.firstName} ${rider.lastName}`,
    raceClass,
    eventName: events[0].name,
    eventDate: events[0].date,
  });
});

// ── Public: verify Stripe payment and confirm registration ─────────────────────
router.post("/public/registrations/:id/verify-payment", async (req, res) => {
  const id = Number(req.params.id);
  const { sessionId } = req.body;
  if (!sessionId) return res.status(400).json({ error: "sessionId required" });

  try {
    const stripe = await getUncachableStripeClient();
    const session = await stripe.checkout.sessions.retrieve(sessionId);

    if (session.metadata?.registrationId !== String(id)) {
      return res.status(403).json({ error: "Session does not match registration" });
    }
    if (session.payment_status !== "paid") {
      return res.status(402).json({ error: "Payment not yet completed", paymentStatus: session.payment_status });
    }

    const amountPaid = session.amount_total != null ? session.amount_total / 100 : null;

    const [reg] = await db.update(registrationsTable)
      .set({ paymentStatus: "paid", status: "confirmed", amountPaid: amountPaid != null ? String(amountPaid) : null })
      .where(eq(registrationsTable.id, id))
      .returning();

    if (!reg) return res.status(404).json({ error: "Registration not found" });

    // Create the check-in record now that payment is confirmed
    await db.insert(checkinsTable).values({
      eventId: reg.eventId,
      riderId: reg.riderId,
      raceClass: reg.raceClass,
      bibNumber: reg.bibNumber,
      checkedIn: false,
      rfidLinked: false,
    }).onConflictDoNothing();

    const [rider] = await db.select().from(ridersTable).where(eq(ridersTable.id, reg.riderId));
    const [event] = await db.select().from(eventsTable).where(eq(eventsTable.id, reg.eventId));

    return res.json({
      registrationId: reg.id,
      riderName: rider ? `${rider.firstName} ${rider.lastName}` : "",
      raceClass: reg.raceClass,
      eventName: event?.name ?? "",
      eventDate: event?.date ?? "",
      amountPaid,
    });
  } catch (err: any) {
    req.log?.error({ err: err?.message }, "[verify-payment] Error");
    return res.status(500).json({ error: err?.message ?? "Verification failed" });
  }
});

export default router;
