import { Router } from "express";
import { db } from "@workspace/db";
import { registrationsTable, ridersTable, checkinsTable, eventsTable, clubsTable, compCodesTable, rfidAssignmentsTable, clubSettingsTable, riderAccountsTable, riderPushTokensTable, raceResultsTable } from "@workspace/db";
import { eq, and, sql, desc, asc, ne, isNull, inArray } from "drizzle-orm";
import { getUncachableStripeClient } from "../stripeClient";
import { sendPushNotifications } from "../lib/push";

const router = Router();

// ── Auto-link a MyLaps transponder when it's provided at registration ──────────
// Saves it to the rider's permanent profile and creates an rfid_assignment so
// the check-in screen shows the transponder already linked — no manual entry needed.
async function autoLinkTransponder(riderId: number, eventId: number, transponderNumber: string) {
  const trimmed = transponderNumber.trim();
  if (!trimmed) return;

  // 1. Store on the rider's permanent profile so it pre-fills next time
  await db.update(ridersTable)
    .set({ mylapsTransponderId: trimmed })
    .where(eq(ridersTable.id, riderId));

  // 2. Create an rfid_assignment for this event if one doesn't exist yet
  const existing = await db.select({ id: rfidAssignmentsTable.id })
    .from(rfidAssignmentsTable)
    .where(and(
      eq(rfidAssignmentsTable.riderId, riderId),
      eq(rfidAssignmentsTable.eventId, eventId),
    ))
    .limit(1);
  if (!existing.length) {
    await db.insert(rfidAssignmentsTable).values({ riderId, eventId, rfidNumber: trimmed });
  }

  // 3. Mark the check-in row as transponder-linked
  await db.update(checkinsTable)
    .set({ rfidNumber: trimmed, rfidLinked: true })
    .where(and(
      eq(checkinsTable.riderId, riderId),
      eq(checkinsTable.eventId, eventId),
    ));
}

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

router.get("/public/riders/lookup", async (req, res) => {
  const email = ((req.query.email as string) || "").trim().toLowerCase();
  if (!email) return res.status(400).json({ error: "email required" });

  const riders = await db.select().from(ridersTable)
    .where(sql`lower(${ridersTable.email}) = ${email}`)
    .orderBy(asc(ridersTable.id));

  if (!riders.length) return res.json({ found: false });

  const riderIds = riders.map(r => r.id);

  const allLastRegs = await db.select({
    riderId: registrationsTable.riderId,
    amaNumber: registrationsTable.amaNumber,
    clubIdNumber: registrationsTable.clubIdNumber,
    bikeBrand: registrationsTable.bikeBrand,
    bikeModel: registrationsTable.bikeModel,
    bikeYear: registrationsTable.bikeYear,
    bibNumber: registrationsTable.bibNumber,
    sponsors: registrationsTable.sponsors,
    createdAt: registrationsTable.createdAt,
  }).from(registrationsTable)
    .where(inArray(registrationsTable.riderId, riderIds))
    .orderBy(desc(registrationsTable.createdAt));

  const lastRegByRider = new Map<number, typeof allLastRegs[0]>();
  for (const reg of allLastRegs) {
    if (reg.riderId != null && !lastRegByRider.has(reg.riderId)) {
      lastRegByRider.set(reg.riderId, reg);
    }
  }

  const result = riders.map(rider => {
    const lastReg = lastRegByRider.get(rider.id) ?? null;
    return {
      id: rider.id,
      firstName: rider.firstName ?? "",
      lastName: rider.lastName ?? "",
      phone: rider.phone ?? "",
      dateOfBirth: rider.dateOfBirth ?? "",
      emergencyContact: rider.emergencyContact ?? "",
      emergencyPhone: rider.emergencyPhone ?? "",
      streetAddress: rider.streetAddress ?? "",
      city: rider.city ?? "",
      homeState: rider.homeState ?? "",
      zip: rider.zip ?? "",
      amaNumber: lastReg?.amaNumber ?? "",
      clubIdNumber: lastReg?.clubIdNumber ?? "",
      bikeBrand: lastReg?.bikeBrand ?? "",
      bikeModel: lastReg?.bikeModel ?? "",
      bikeYear: lastReg?.bikeYear ?? "",
      bibNumber: lastReg?.bibNumber?.toString() ?? "",
      sponsors: lastReg?.sponsors ?? "",
    };
  });

  return res.json({ found: true, count: result.length, riders: result });
});

function getAppUrl(): string {
  if (process.env.APP_URL) return process.env.APP_URL;
  const domains = process.env.REPLIT_DOMAINS;
  if (domains) return `https://${domains.split(",")[0]}`;
  return "http://localhost:80";
}

router.get("/events/:eventId/registrations", async (req, res) => {
  const eventId = Number(req.params.eventId);
  if (!await checkEventOwnership(eventId, getStaffClubId(res), res)) return;

  // Subquery: one RFID assignment per (riderId, eventId) — most recent wins.
  // Using DISTINCT ON prevents fan-out when a rider has multiple RFID records
  // for the same event, which would otherwise duplicate registration rows.
  const latestRfid = db
    .selectDistinctOn([rfidAssignmentsTable.riderId, rfidAssignmentsTable.eventId], {
      riderId: rfidAssignmentsTable.riderId,
      eventId: rfidAssignmentsTable.eventId,
      rfidNumber: rfidAssignmentsTable.rfidNumber,
    })
    .from(rfidAssignmentsTable)
    .orderBy(rfidAssignmentsTable.riderId, rfidAssignmentsTable.eventId, desc(rfidAssignmentsTable.id))
    .as("latest_rfid");

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
    displayFirstName: registrationsTable.displayFirstName,
    displayLastName: registrationsTable.displayLastName,
    myLapsTransponderNumber: registrationsTable.myLapsTransponderNumber,
    transponderRental: registrationsTable.transponderRental,
    waiverAcknowledgedAt: registrationsTable.waiverAcknowledgedAt,
    riderFirstName: ridersTable.firstName,
    riderLastName: ridersTable.lastName,
    email: ridersTable.email,
    phone: ridersTable.phone,
    dateOfBirth: ridersTable.dateOfBirth,
    emergencyContact: ridersTable.emergencyContact,
    emergencyPhone: ridersTable.emergencyPhone,
    rfidNumber: latestRfid.rfidNumber,
  }).from(registrationsTable)
    .leftJoin(ridersTable, eq(registrationsTable.riderId, ridersTable.id))
    .leftJoin(latestRfid, and(
      eq(latestRfid.riderId, registrationsTable.riderId),
      eq(latestRfid.eventId, registrationsTable.eventId),
    ))
    .where(eq(registrationsTable.eventId, eventId))
    .orderBy(registrationsTable.createdAt);

  return res.json(regs.map(r => {
    const firstName = r.displayFirstName ?? r.riderFirstName ?? "";
    const lastName = r.displayLastName ?? r.riderLastName ?? "";
    return {
    id: r.id,
    eventId: r.eventId,
    riderId: r.riderId,
    riderName: `${firstName} ${lastName}`,
    firstName,
    lastName,
    email: r.email ?? "",
    phone: r.phone ?? "",
    dateOfBirth: r.dateOfBirth ?? "",
    emergencyContact: r.emergencyContact ?? "",
    emergencyPhone: r.emergencyPhone ?? "",
    raceClass: r.raceClass,
    status: r.status,
    paymentStatus: r.paymentStatus,
    amountPaid: r.amountPaid ? Number(r.amountPaid) : null,
    bibNumber: r.bibNumber,
    myLapsTransponderNumber: r.myLapsTransponderNumber ?? null,
    transponderRental: r.transponderRental ?? false,
    rfidNumber: r.rfidNumber ?? null,
    waiverAcknowledgedAt: r.waiverAcknowledgedAt ? r.waiverAcknowledgedAt.toISOString() : null,
    createdAt: r.createdAt.toISOString(),
    };
  }));
});

router.post("/events/:eventId/registrations", async (req, res) => {
  const eventId = Number(req.params.eventId);
  if (!await checkEventOwnership(eventId, getStaffClubId(res), res)) return;
  const {
    riderId, raceClass, bibNumber, bikeBrand, bikeModel, bikeYear, clubIdNumber,
    // Full on-site rider info (alternative to riderId)
    firstName, lastName, email, phone, dateOfBirth, emergencyContact, emergencyPhone,
    // MyLaps transponder fields
    rentTransponder, myLapsTransponderNumber,
    // Purchase options
    selectedPurchaseOptions,
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

  // Determine if payment is required — on-site registrations start pending when the event has a fee
  const [eventData] = await db.select().from(eventsTable).where(eq(eventsTable.id, eventId));
  const needsPayment = !!(eventData?.paymentEnabled && eventData?.entryFee);
  const wantsRental = !!(rentTransponder && eventData?.transponderRentalEnabled && eventData?.transponderRentalFee);

  // Enforce club ID# if required
  if (eventData?.requireClubId && !clubIdNumber) {
    return res.status(400).json({ error: "Club ID # is required for this event" });
  }

  // Enforce unique bib numbers if the event requires it
  // Exclude the registering rider themselves — same rider in multiple classes can keep the same bib
  if (eventData?.noDuplicateBibs && bibNumber) {
    const bibTaken = await db.select({ id: registrationsTable.id })
      .from(registrationsTable)
      .where(and(
        eq(registrationsTable.eventId, eventId),
        eq(registrationsTable.bibNumber, String(bibNumber)),
        ne(registrationsTable.status, "void"),
        ne(registrationsTable.riderId, resolvedRiderId),
      ))
      .limit(1);
    if (bibTaken.length > 0) {
      return res.status(409).json({ error: `Bib #${bibNumber} is already taken for this event` });
    }
  }

  const [reg] = await db.insert(registrationsTable).values({
    eventId, riderId: resolvedRiderId, raceClass,
    bibNumber: bibNumber || null,
    bikeBrand: bikeBrand || null,
    bikeModel: bikeModel || null,
    bikeYear: bikeYear || null,
    clubIdNumber: clubIdNumber || null,
    status: needsPayment ? "pending" : "confirmed",
    paymentStatus: "unpaid",
    transponderRental: wantsRental,
    myLapsTransponderNumber: myLapsTransponderNumber?.trim() || null,
    selectedPurchaseOptions: Array.isArray(selectedPurchaseOptions) ? selectedPurchaseOptions : [],
  }).returning();

  // Only create the check-in record immediately for free events.
  // For paid events, check-in is created when payment is confirmed.
  // One checkin per rider per event — skip if one already exists (multi-class riders).
  if (!needsPayment) {
    const [existingCheckin] = await db.select({ id: checkinsTable.id })
      .from(checkinsTable)
      .where(and(eq(checkinsTable.eventId, eventId), eq(checkinsTable.riderId, resolvedRiderId)))
      .limit(1);
    if (!existingCheckin) {
      await db.insert(checkinsTable).values({
        eventId, riderId: resolvedRiderId, raceClass,
        bibNumber: bibNumber || null,
        checkedIn: false, rfidLinked: false,
      });
    }
  }

  const riders = await db.select().from(ridersTable).where(eq(ridersTable.id, resolvedRiderId));
  const rider = riders[0];

  return res.status(201).json({
    ...reg,
    riderName: rider ? `${rider.firstName} ${rider.lastName}` : "",
    requiresPayment: needsPayment,
    amountPaid: null,
    createdAt: reg.createdAt.toISOString(),
  });
});

router.patch("/registrations/:registrationId", async (req, res) => {
  const id = Number(req.params.registrationId);
  const { status, paymentStatus, raceClass, bibNumber, amountPaid, paymentMethod, displayFirstName, displayLastName, riderId: newRiderId } = req.body;
  const updates: Record<string, unknown> = {};
  if (status !== undefined) updates.status = status;
  if (paymentStatus !== undefined) {
    updates.paymentStatus = paymentStatus;
    // Recording cash payment — auto-confirm the registration
    if (paymentStatus === "paid" && status === undefined) {
      updates.status = "confirmed";
    }
  }
  if (raceClass !== undefined) updates.raceClass = raceClass;
  if (bibNumber !== undefined) updates.bibNumber = bibNumber;
  if (amountPaid !== undefined) updates.amountPaid = String(amountPaid);
  if (paymentMethod !== undefined) updates.paymentMethod = paymentMethod;
  if (displayFirstName !== undefined) updates.displayFirstName = displayFirstName;
  if (displayLastName !== undefined) updates.displayLastName = displayLastName;
  if (newRiderId !== undefined) updates.riderId = newRiderId;

  // Snapshot the current riderId and raceClass BEFORE updating so we can cascade
  const [before] = await db.select({ riderId: registrationsTable.riderId, eventId: registrationsTable.eventId, raceClass: registrationsTable.raceClass })
    .from(registrationsTable).where(eq(registrationsTable.id, id));
  const oldRiderId = before?.riderId;
  const oldRaceClass = before?.raceClass;

  if (before) {
    if (!await checkEventOwnership(before.eventId, getStaffClubId(res), res)) return;
  } else {
    return res.status(404).json({ error: "Not found" });
  }

  const [reg] = await db.update(registrationsTable).set(updates as any).where(eq(registrationsTable.id, id)).returning();
  if (!reg) return res.status(404).json({ error: "Not found" });

  // If riderId changed, re-point exactly one checkin row for this rider+event to the new rider
  if (newRiderId !== undefined && oldRiderId && oldRiderId !== newRiderId) {
    const [checkinToMove] = await db.select({ id: checkinsTable.id })
      .from(checkinsTable)
      .where(and(eq(checkinsTable.eventId, reg.eventId), eq(checkinsTable.riderId, oldRiderId)))
      .limit(1);
    if (checkinToMove) {
      await db.update(checkinsTable)
        .set({ riderId: newRiderId })
        .where(eq(checkinsTable.id, checkinToMove.id));
    }
  }

  // If raceClass changed, cascade to checkins and race_results for this rider+event
  if (raceClass !== undefined && oldRaceClass && raceClass !== oldRaceClass) {
    const cascadeRiderId = reg.riderId;
    // Update the rider's check-in record so they appear in the correct class at gate
    await db.update(checkinsTable)
      .set({ raceClass })
      .where(and(
        eq(checkinsTable.eventId, reg.eventId),
        eq(checkinsTable.riderId, cascadeRiderId),
        eq(checkinsTable.raceClass, oldRaceClass),
      ));
    // Update any race result rows so scoring/standings reflect the new class
    await db.update(raceResultsTable)
      .set({ raceClass })
      .where(and(
        eq(raceResultsTable.eventId, reg.eventId),
        eq(raceResultsTable.riderId, cascadeRiderId),
        eq(raceResultsTable.raceClass, oldRaceClass),
      ));
  }

  // Create check-in record if payment just confirmed the registration
  if (paymentStatus === "paid" && reg.status === "confirmed") {
    await db.insert(checkinsTable).values({
      eventId: reg.eventId,
      riderId: reg.riderId,
      raceClass: reg.raceClass,
      bibNumber: reg.bibNumber,
      checkedIn: false,
      rfidLinked: false,
    }).onConflictDoNothing();
  }

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
  if (!await checkEventOwnership(eventId, getStaffClubId(res), res)) return;
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
    const rentalFee = (reg.transponderRental && event.transponderRentalEnabled && event.transponderRentalFee)
      ? Number(event.transponderRentalFee)
      : 0;

    const [rider] = await db.select().from(ridersTable).where(eq(ridersTable.id, reg.riderId));

    const purchaseOptsList = ((reg.selectedPurchaseOptions as Array<{ id: string; name: string; amount: number }>) ?? []);
    const purchaseOptionsTotal = purchaseOptsList.reduce((sum, o) => sum + Number(o.amount), 0);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const lineItems: any[] = [
      {
        price_data: {
          currency: "usd",
          product_data: { name: `${event.name} — ${reg.raceClass} Entry` },
          unit_amount: Math.round(entryFee * 100),
        },
        quantity: 1,
      },
    ];

    if (rentalFee > 0) {
      lineItems.push({
        price_data: {
          currency: "usd",
          product_data: { name: "MyLaps Transponder Rental" },
          unit_amount: Math.round(rentalFee * 100),
        },
        quantity: 1,
      });
    }

    for (const opt of purchaseOptsList) {
      if (Number(opt.amount) > 0) {
        lineItems.push({
          price_data: {
            currency: "usd",
            product_data: { name: opt.name },
            unit_amount: Math.round(Number(opt.amount) * 100),
          },
          quantity: 1,
        });
      }
    }

    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      line_items: lineItems,
      customer_email: rider?.email ?? undefined,
      payment_intent_data: {
        transfer_data: { destination: club.stripeAccountId },
      },
      metadata: { registrationId: String(regId) },
      success_url: `${appUrl}/events/${eventId}/registrations`,
      cancel_url: `${appUrl}/events/${eventId}/registrations`,
    });

    return res.json({ checkoutUrl: session.url, sessionId: session.id, entryFee, rentalFee, purchaseOptionsTotal });
  } catch (err: any) {
    req.log?.error({ err: err?.message }, "[charge] Error");
    return res.status(500).json({ error: err?.message ?? "Failed to create checkout session" });
  }
});

// ── Organizer: add transponder rental to an existing registration (on-site) ───
router.post("/events/:eventId/registrations/:regId/add-transponder-rental", async (req, res) => {
  const eventId = Number(req.params.eventId);
  if (!await checkEventOwnership(eventId, getStaffClubId(res), res)) return;
  const regId = Number(req.params.regId);
  const { paymentMethod } = req.body; // 'cash' | 'card'

  const [reg] = await db.select().from(registrationsTable).where(eq(registrationsTable.id, regId));
  if (!reg) return res.status(404).json({ error: "Registration not found" });
  if (reg.eventId !== eventId) return res.status(403).json({ error: "Registration does not belong to this event" });
  if (reg.transponderRental) return res.status(400).json({ error: "Rider already has a transponder rental" });

  const [event] = await db.select().from(eventsTable).where(eq(eventsTable.id, eventId));
  if (!event?.transponderRentalEnabled || !event.transponderRentalFee) {
    return res.status(400).json({ error: "Transponder rental is not enabled for this event" });
  }

  const rentalFee = Number(event.transponderRentalFee);

  if (paymentMethod === "cash") {
    await db.update(registrationsTable)
      .set({ transponderRental: true })
      .where(eq(registrationsTable.id, regId));
    return res.json({ success: true, rentalFee });
  }

  if (paymentMethod === "card") {
    try {
      const [club] = await db.select().from(clubsTable).where(eq(clubsTable.id, event.clubId));
      if (!club?.stripeAccountId) {
        return res.status(400).json({ error: "Club has no Stripe account configured. Use cash payment instead." });
      }

      const stripe = await getUncachableStripeClient();
      const appUrl = getAppUrl();
      const [rider] = await db.select().from(ridersTable).where(eq(ridersTable.id, reg.riderId));

      const session = await stripe.checkout.sessions.create({
        mode: "payment",
        line_items: [{
          price_data: {
            currency: "usd",
            product_data: { name: "MyLaps Transponder Rental" },
            unit_amount: Math.round(rentalFee * 100),
          },
          quantity: 1,
        }],
        customer_email: rider?.email ?? undefined,
        payment_intent_data: {
          transfer_data: { destination: club.stripeAccountId },
        },
        metadata: { registrationId: String(regId), type: "transponder_rental" },
        success_url: `${appUrl}/events/${eventId}/checkin`,
        cancel_url: `${appUrl}/events/${eventId}/checkin`,
      });

      return res.json({ checkoutUrl: session.url, sessionId: session.id, rentalFee });
    } catch (err: any) {
      req.log?.error({ err: err?.message }, "[add-transponder-rental] Error");
      return res.status(500).json({ error: err?.message ?? "Failed to create checkout session" });
    }
  }

  return res.status(400).json({ error: "paymentMethod must be 'cash' or 'card'" });
});

// ── Organizer: add RFID sticker purchase at check-in gate ─────────────────────
router.post("/events/:eventId/registrations/:regId/add-rfid-sticker", async (req, res) => {
  const eventId = Number(req.params.eventId);
  if (!await checkEventOwnership(eventId, getStaffClubId(res), res)) return;
  const regId = Number(req.params.regId);
  const { paymentMethod } = req.body; // 'cash' | 'card'

  const [reg] = await db.select().from(registrationsTable).where(eq(registrationsTable.id, regId));
  if (!reg) return res.status(404).json({ error: "Registration not found" });
  if (reg.eventId !== eventId) return res.status(403).json({ error: "Registration does not belong to this event" });
  if (reg.rfidStickerPurchased) return res.status(400).json({ error: "Rider already has an RFID sticker" });

  const [event] = await db.select().from(eventsTable).where(eq(eventsTable.id, eventId));
  if (!event?.rfidStickerFee) {
    return res.status(400).json({ error: "RFID sticker is not enabled for this event" });
  }

  const stickerFee = Number(event.rfidStickerFee);

  if (paymentMethod === "cash") {
    await db.update(registrationsTable)
      .set({ rfidStickerPurchased: true })
      .where(and(eq(registrationsTable.eventId, eventId), eq(registrationsTable.riderId, reg.riderId)));
    return res.json({ success: true, stickerFee });
  }

  if (paymentMethod === "card") {
    try {
      const [club] = await db.select().from(clubsTable).where(eq(clubsTable.id, event.clubId));
      if (!club?.stripeAccountId) {
        return res.status(400).json({ error: "Club has no Stripe account configured. Use cash payment instead." });
      }

      const stripe = await getUncachableStripeClient();
      const appUrl = getAppUrl();
      const [rider] = await db.select().from(ridersTable).where(eq(ridersTable.id, reg.riderId));

      const session = await stripe.checkout.sessions.create({
        mode: "payment",
        line_items: [{
          price_data: {
            currency: "usd",
            product_data: { name: "RFID Sticker" },
            unit_amount: Math.round(stickerFee * 100),
          },
          quantity: 1,
        }],
        customer_email: rider?.email ?? undefined,
        payment_intent_data: {
          transfer_data: { destination: club.stripeAccountId },
        },
        metadata: { registrationId: String(regId), type: "rfid_sticker" },
        success_url: `${appUrl}/events/${eventId}/checkin`,
        cancel_url: `${appUrl}/events/${eventId}/checkin`,
      });

      return res.json({ checkoutUrl: session.url, sessionId: session.id, stickerFee });
    } catch (err: any) {
      req.log?.error({ err: err?.message }, "[add-rfid-sticker] Error");
      return res.status(500).json({ error: err?.message ?? "Failed to create checkout session" });
    }
  }

  return res.status(400).json({ error: "paymentMethod must be 'cash' or 'card'" });
});

// ── Public: verify RFID sticker Stripe payment and mark purchased ──────────────
router.post("/public/registrations/:id/verify-rfid-sticker", async (req, res) => {
  const id = Number(req.params.id);
  const { sessionId } = req.body;
  if (!sessionId) return res.status(400).json({ error: "sessionId required" });

  try {
    const stripe = await getUncachableStripeClient();
    const session = await stripe.checkout.sessions.retrieve(sessionId);

    if (session.metadata?.registrationId !== String(id) || session.metadata?.type !== "rfid_sticker") {
      return res.status(403).json({ error: "Session does not match this sticker purchase" });
    }
    if (session.payment_status !== "paid") {
      return res.status(402).json({ error: "Payment not yet completed" });
    }

    const [reg] = await db.select({ riderId: registrationsTable.riderId, eventId: registrationsTable.eventId })
      .from(registrationsTable).where(eq(registrationsTable.id, id));
    if (!reg) return res.status(404).json({ error: "Registration not found" });

    await db.update(registrationsTable)
      .set({ rfidStickerPurchased: true })
      .where(and(eq(registrationsTable.eventId, reg.eventId), eq(registrationsTable.riderId, reg.riderId)));

    return res.json({ paid: true });
  } catch (err: any) {
    req.log?.error({ err: err?.message }, "[verify-rfid-sticker] Error");
    return res.status(500).json({ error: err?.message ?? "Verification failed" });
  }
});

// ── Public: verify transponder rental Stripe payment and activate rental ──────
router.post("/public/registrations/:id/verify-transponder-rental", async (req, res) => {
  const id = Number(req.params.id);
  const { sessionId } = req.body;
  if (!sessionId) return res.status(400).json({ error: "sessionId required" });

  try {
    const stripe = await getUncachableStripeClient();
    const session = await stripe.checkout.sessions.retrieve(sessionId);

    if (session.metadata?.registrationId !== String(id) || session.metadata?.type !== "transponder_rental") {
      return res.status(403).json({ error: "Session does not match this rental" });
    }
    if (session.payment_status !== "paid") {
      return res.status(402).json({ error: "Payment not yet completed" });
    }

    const [reg] = await db.update(registrationsTable)
      .set({ transponderRental: true })
      .where(eq(registrationsTable.id, id))
      .returning();

    if (!reg) return res.status(404).json({ error: "Registration not found" });

    return res.json({ paid: true });
  } catch (err: any) {
    req.log?.error({ err: err?.message }, "[verify-transponder-rental] Error");
    return res.status(500).json({ error: err?.message ?? "Verification failed" });
  }
});

// ── Organizer: waiver acknowledgment history for a rider ──────────────────────
router.get("/clubs/:clubId/riders/:riderId/waiver-acknowledgments", async (req, res) => {
  const session = req.session as any;
  if (!session?.userId) return res.status(401).json({ error: "Unauthorized" });

  const clubId = Number(req.params.clubId);
  const riderId = Number(req.params.riderId);

  // Enforce club scope: non-super-admin staff may only query their own club
  const staffCId = getStaffClubId(res);
  if (staffCId !== null && staffCId !== clubId) {
    return res.status(403).json({ error: "Forbidden" });
  }

  const rows = await db.select({
    id: registrationsTable.id,
    waiverAcknowledgedAt: registrationsTable.waiverAcknowledgedAt,
    waiverSnapshot: registrationsTable.waiverSnapshot,
    eventId: eventsTable.id,
    eventName: eventsTable.name,
    eventDate: eventsTable.date,
  })
    .from(registrationsTable)
    .innerJoin(eventsTable, eq(registrationsTable.eventId, eventsTable.id))
    .where(
      and(
        eq(registrationsTable.riderId, riderId),
        eq(eventsTable.clubId, clubId),
        sql`${registrationsTable.waiverAcknowledgedAt} IS NOT NULL`,
      )
    )
    .orderBy(desc(registrationsTable.waiverAcknowledgedAt));

  return res.json(rows.map(r => ({
    id: r.id,
    eventId: r.eventId,
    eventName: r.eventName,
    eventDate: typeof r.eventDate === "string" ? r.eventDate : (r.eventDate as Date).toISOString(),
    waiverAcknowledgedAt: r.waiverAcknowledgedAt ? r.waiverAcknowledgedAt.toISOString() : null,
    waiverSnapshot: r.waiverSnapshot,
  })));
});

// ── Public: check if a bib number is already taken for an event ───────────────
// Optional query param: excludeRiderId — rider to exclude from the check
// (same rider registering for multiple classes should not be flagged)
router.get("/public/events/:eventId/check-bib", async (req, res) => {
  const eventId = Number(req.params.eventId);
  const bib = ((req.query.bib as string) || "").trim();
  if (!bib) return res.status(400).json({ error: "bib required" });
  const excludeRiderId = req.query.excludeRiderId ? Number(req.query.excludeRiderId) : null;

  const conditions = [
    eq(registrationsTable.eventId, eventId),
    eq(registrationsTable.bibNumber, bib),
    ne(registrationsTable.status, "void"),
    ...(excludeRiderId ? [ne(registrationsTable.riderId, excludeRiderId)] : []),
  ];

  const existing = await db.select({ id: registrationsTable.id })
    .from(registrationsTable)
    .where(and(...conditions))
    .limit(1);

  return res.json({ taken: existing.length > 0 });
});

// ── Public: classes a rider is already registered for at an event ─────────────
router.get("/public/events/:eventId/rider-classes", async (req, res) => {
  const eventId = Number(req.params.eventId);
  const riderId = Number(req.query.riderId);
  if (!riderId || isNaN(riderId)) return res.json({ registeredClasses: [] });

  const rows = await db.select({ raceClass: registrationsTable.raceClass })
    .from(registrationsTable)
    .where(and(
      eq(registrationsTable.eventId, eventId),
      eq(registrationsTable.riderId, riderId),
      ne(registrationsTable.status, "void"),
    ));

  return res.json({ registeredClasses: rows.map(r => r.raceClass) });
});

// ── Public: event info for the registration form ─────────────────────────────
router.get("/public/events/:eventId/register-info", async (req, res) => {
  const eventId = Number(req.params.eventId);
  const rows = await db.select({
    id: eventsTable.id,
    clubId: eventsTable.clubId,
    name: eventsTable.name,
    date: eventsTable.date,
    state: eventsTable.state,
    location: eventsTable.location,
    trackName: eventsTable.trackName,
    raceClasses: eventsTable.raceClasses,
    status: eventsTable.status,
    entryFee: eventsTable.entryFee,
    paymentEnabled: eventsTable.paymentEnabled,
    requireAma: eventsTable.requireAma,
    maxRiders: eventsTable.maxRiders,
    registrationOpen: eventsTable.registrationOpen,
    registrationClose: eventsTable.registrationClose,
    clubName: clubsTable.name,
    clubLogoUrl: clubsTable.logoUrl,
    imageUrl: eventsTable.imageUrl,
    timingTechnology: eventsTable.timingTechnology,
    transponderRentalEnabled: eventsTable.transponderRentalEnabled,
    transponderRentalFee: eventsTable.transponderRentalFee,
    purchaseOptions: eventsTable.purchaseOptions,
    noDuplicateBibs: eventsTable.noDuplicateBibs,
    requireClubId: eventsTable.requireClubId,
    requireWaiver: eventsTable.requireWaiver,
    requireTransponder: eventsTable.requireTransponder,
  }).from(eventsTable)
    .leftJoin(clubsTable, eq(eventsTable.clubId, clubsTable.id))
    .where(eq(eventsTable.id, eventId));

  if (!rows[0]) return res.status(404).json({ error: "Event not found" });
  const e = rows[0];

  // If waiver is required, fetch the club's waiver text
  let waiverText: string | null = null;
  if (e.requireWaiver) {
    const [settings] = await db.select({ riderAcknowledgement: clubSettingsTable.riderAcknowledgement })
      .from(clubSettingsTable)
      .where(eq(clubSettingsTable.clubId, e.clubId));
    waiverText = settings?.riderAcknowledgement ?? null;
  }

  return res.json({
    ...e,
    entryFee: e.entryFee ? Number(e.entryFee) : null,
    transponderRentalFee: e.transponderRentalFee ? Number(e.transponderRentalFee) : null,
    waiverText,
  });
});

// ── Public: self-service rider registration ───────────────────────────────────
router.post("/public/events/:eventId/register", async (req, res) => {
  const eventId = Number(req.params.eventId);
  const { firstName, lastName, email, phone, dateOfBirth, emergencyContact, emergencyPhone, hometown, homeState, raceClass, bibNumber, amaNumber, clubIdNumber, statsEmailOptIn, sponsors, rentTransponder, myLapsTransponderNumber, selectedPurchaseOptions, compCode, categoryId, waiverAcknowledgedAt, purchaseRfidSticker } = req.body;

  // Accept raceClasses[] (new multi-class) or raceClass string (backward compat)
  const rawClasses = Array.isArray(req.body.raceClasses) ? (req.body.raceClasses as string[]) : null;
  const raceClassList: string[] = rawClasses ?? (raceClass ? [raceClass] : []);

  if (!firstName || !lastName || !email || raceClassList.length === 0) {
    return res.status(400).json({ error: "firstName, lastName, email, and at least one raceClass are required" });
  }
  if (raceClassList.length !== new Set(raceClassList).size) {
    return res.status(400).json({ error: "Duplicate race classes in selection" });
  }

  // Confirm event exists and is open for registration
  const events = await db.select().from(eventsTable).where(eq(eventsTable.id, eventId));
  if (!events[0]) return res.status(404).json({ error: "Event not found" });
  if (events[0].requireAma && !amaNumber) {
    return res.status(400).json({ error: "AMA # is required for this event" });
  }
  if (events[0].requireClubId && !clubIdNumber) {
    return res.status(400).json({ error: "Club ID # is required for this event" });
  }
  if (events[0].requireWaiver && !waiverAcknowledgedAt) {
    return res.status(400).json({ error: "You must accept the club waiver to complete registration" });
  }

  // Fetch waiver text server-side so the snapshot can't be spoofed by the client
  let serverWaiverSnapshot: string | null = null;
  if (events[0].requireWaiver && waiverAcknowledgedAt) {
    const [settings] = await db.select({ riderAcknowledgement: clubSettingsTable.riderAcknowledgement })
      .from(clubSettingsTable)
      .where(eq(clubSettingsTable.clubId, events[0].clubId));
    serverWaiverSnapshot = settings?.riderAcknowledgement ?? null;
    if (!serverWaiverSnapshot) {
      return res.status(400).json({ error: "No waiver text configured for this event's club" });
    }
  }
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
  // Validate each selected class against the event's class list
  if (events[0].raceClasses) {
    for (const cls of raceClassList) {
      if (!events[0].raceClasses.includes(cls)) {
        return res.status(400).json({ error: `Invalid race class for this event: ${cls}` });
      }
    }
  }

  // Enforce per-class rider limits for each selected class
  const limits = (events[0].raceClassLimits ?? {}) as Record<string, number | null>;
  for (const cls of raceClassList) {
    const classLimit = limits[cls];
    if (classLimit != null && classLimit > 0) {
      const classCount = await db.select({ count: sql<number>`count(*)::int` })
        .from(registrationsTable)
        .where(and(eq(registrationsTable.eventId, eventId), eq(registrationsTable.raceClass, cls)));
      if ((classCount[0]?.count ?? 0) >= classLimit) {
        return res.status(409).json({ error: `${cls} is full (${classLimit} rider limit reached)` });
      }
    }
  }

  // Enforce unique bib numbers if the event requires it
  // Exclude the registering rider — same rider registering for multiple classes can keep the same bib
  if (events[0].noDuplicateBibs && bibNumber) {
    // Quick rider lookup by email so we can exclude their existing registrations
    const existingRiderRows = email
      ? await db.select({ id: ridersTable.id }).from(ridersTable).where(sql`lower(${ridersTable.email}) = ${String(email).toLowerCase()}`).limit(1)
      : [];
    const riderIdForBibCheck = existingRiderRows[0]?.id ?? null;

    const bibConditions: Parameters<typeof and>[0][] = [
      eq(registrationsTable.eventId, eventId),
      eq(registrationsTable.bibNumber, String(bibNumber)),
      ne(registrationsTable.status, "void"),
    ];
    if (riderIdForBibCheck) bibConditions.push(ne(registrationsTable.riderId, riderIdForBibCheck));

    const bibTaken = await db.select({ id: registrationsTable.id })
      .from(registrationsTable)
      .where(and(...bibConditions))
      .limit(1);
    if (bibTaken.length > 0) {
      return res.status(409).json({ error: `Bib #${bibNumber} is already taken for this event` });
    }
  }

  // Validate discount code if provided
  let compDiscount = 0;
  let compDiscountType: "fixed" | "percentage" = "fixed";
  let compDiscountRaw = 0;
  let validatedCompCode: string | null = null;
  if (compCode) {
    const codeStr = String(compCode).trim().toUpperCase();

    // 1. Try event-scoped code first
    let [codeRow] = await db.select().from(compCodesTable).where(
      and(eq(compCodesTable.eventId, eventId), eq(compCodesTable.code, codeStr))
    );

    // 2. Fall back to club-level code (event_id IS NULL) for this event's club
    if (!codeRow) {
      const eventClubId = events[0]?.clubId;
      if (eventClubId) {
        [codeRow] = await db.select().from(compCodesTable).where(
          and(
            eq(compCodesTable.clubId, eventClubId),
            isNull(compCodesTable.eventId),
            eq(compCodesTable.code, codeStr),
          )
        );
      }
    }

    if (!codeRow) {
      return res.status(400).json({ error: "Invalid or already-used discount code" });
    }
    if (codeRow.isActive === false) {
      return res.status(400).json({ error: "This discount code is no longer active" });
    }
    if (codeRow.expiresAt && new Date() > codeRow.expiresAt) {
      return res.status(400).json({ error: "This discount code has expired" });
    }
    if (codeRow.usesCount >= codeRow.maxUses) {
      return res.status(400).json({ error: "Invalid or already-used discount code" });
    }
    // Category restriction: only enforce when the caller explicitly passes a categoryId.
    // Entry-fee registrations have no purchase-option category, so skip the check when
    // categoryId is absent — the discount applies to the base entry fee in that case.
    if (categoryId != null) {
      const codeCatIds = (codeRow.categoryIds as number[]) ?? [];
      if (codeCatIds.length > 0 && !codeCatIds.includes(Number(categoryId))) {
        return res.status(400).json({ error: "This discount code is not valid for the selected category" });
      }
    }
    // If this is a rider-specific code, validate that the submitting person matches
    if (codeRow.riderId) {
      const [assignedRider] = await db.select({
        firstName: ridersTable.firstName,
        lastName: ridersTable.lastName,
        email: ridersTable.email,
      }).from(ridersTable).where(eq(ridersTable.id, codeRow.riderId));

      if (!assignedRider) {
        return res.status(400).json({ error: "Invalid comp code" });
      }

      const normalize = (s: string) => s.trim().toLowerCase();
      const firstMatch = normalize(firstName) === normalize(assignedRider.firstName);
      const lastMatch = normalize(lastName) === normalize(assignedRider.lastName);
      const emailMatch = normalize(email) === normalize(assignedRider.email ?? "");

      if (!firstMatch || !lastMatch || !emailMatch) {
        return res.status(400).json({ error: "This discount code is reserved for a specific rider and your details do not match" });
      }
    }
    compDiscountType = (codeRow.discountType as "fixed" | "percentage") ?? "fixed";
    compDiscountRaw = Number(codeRow.amount);
    validatedCompCode = codeRow.code;
  }

  // Find or create rider by email + full name.
  // Matching on name+email (not email alone) ensures that when multiple riders share
  // the same email address (e.g. a parent registering two kids), the correct rider
  // record is linked to the registration rather than whichever row happens to come
  // back first from a plain email query.
  let rider;
  const normFirst = firstName.trim().toLowerCase();
  const normLast  = lastName.trim().toLowerCase();
  const normEmail = email.trim().toLowerCase();
  const existing = await db.select().from(ridersTable).where(
    and(
      sql`lower(${ridersTable.email}) = ${normEmail}`,
      sql`lower(${ridersTable.firstName}) = ${normFirst}`,
      sql`lower(${ridersTable.lastName}) = ${normLast}`,
    )
  );
  if (existing[0]) {
    rider = existing[0];
  } else {
    const [created] = await db.insert(ridersTable).values({
      firstName: firstName.trim(),
      lastName: lastName.trim(),
      email: email.trim(),
      phone: phone || null,
      dateOfBirth: dateOfBirth || null,
      emergencyContact: emergencyContact || null,
      emergencyPhone: emergencyPhone || null,
      bibNumber: bibNumber || null,
      hometown: hometown || null,
      homeState: homeState || null,
    } as any).returning();
    rider = created;
  }

  // Determine if payment is required (accounting for comp discount and purchase options)
  const wantsRental = !!(rentTransponder && events[0].transponderRentalEnabled && events[0].transponderRentalFee);
  const wantsRfidSticker = !!(purchaseRfidSticker && events[0].timingTechnology === "rfid" && events[0].rfidStickerFee);
  const entryFeeNum = events[0].entryFee ? Number(events[0].entryFee) : 0;
  const numClasses = raceClassList.length;
  const totalEntryFees = entryFeeNum * numClasses;
  const rentalFeeNum = wantsRental && events[0].transponderRentalFee ? Number(events[0].transponderRentalFee) : 0;
  const rfidStickerFeeNum = wantsRfidSticker && events[0].rfidStickerFee ? Number(events[0].rfidStickerFee) : 0;
  const purchaseOptsList = Array.isArray(selectedPurchaseOptions)
    ? (selectedPurchaseOptions as Array<{ id: string; name: string; amount: number }>)
    : [];
  const purchaseOptionsTotal = purchaseOptsList.reduce((sum, o) => sum + Number(o.amount), 0);
  if (validatedCompCode) {
    // Comp discount applies to total entry fees (all classes)
    compDiscount = compDiscountType === "percentage"
      ? totalEntryFees * compDiscountRaw / 100
      : compDiscountRaw;
  }
  const netFee = Math.max(0, totalEntryFees + rentalFeeNum + rfidStickerFeeNum + purchaseOptionsTotal - compDiscount);
  const needsPayment = !!events[0].paymentEnabled && netFee > 0;
  const regStatus = needsPayment ? "pending" : "confirmed";

  // Insert one registration row per class
  const sharedRegFields = {
    eventId, riderId: rider.id,
    bibNumber: bibNumber || rider.bibNumber || null,
    status: regStatus, paymentStatus: "unpaid",
    amaNumber: amaNumber || null,
    clubIdNumber: clubIdNumber || null,
    bikeBrand: req.body.bikeBrand || null,
    bikeModel: req.body.bikeModel || null,
    bikeYear: req.body.bikeYear || null,
    sponsors: sponsors || null,
    statsEmailOptIn: !!statsEmailOptIn,
    transponderRental: wantsRental,
    rfidStickerPurchased: wantsRfidSticker,
    myLapsTransponderNumber: myLapsTransponderNumber?.trim() || null,
    compCode: validatedCompCode,
    compDiscount: compDiscount > 0 ? String(compDiscount) : null,
    waiverAcknowledgedAt: waiverAcknowledgedAt ? new Date(waiverAcknowledgedAt) : null,
    waiverSnapshot: serverWaiverSnapshot,
  };
  const insertedRegs = await db.insert(registrationsTable).values(
    raceClassList.map((cls, idx) => ({
      ...sharedRegFields,
      raceClass: cls,
      // Purchase options and transponder rental attach to the first reg only
      selectedPurchaseOptions: idx === 0 ? (Array.isArray(selectedPurchaseOptions) ? selectedPurchaseOptions : []) : [],
    }))
  ).returning();

  // Mark comp code as used
  if (validatedCompCode) {
    await db.update(compCodesTable)
      .set({ usesCount: sql`${compCodesTable.usesCount} + 1` })
      .where(eq(compCodesTable.code, validatedCompCode));
  }

  // Only create the check-in record now if no payment is required.
  // For payment-required registrations, the checkin is created after payment is confirmed.
  // One checkin per rider per event — skip if one already exists (multi-class riders).
  if (!needsPayment) {
    const [existingCheckin] = await db.select({ id: checkinsTable.id })
      .from(checkinsTable)
      .where(and(eq(checkinsTable.eventId, eventId), eq(checkinsTable.riderId, rider.id)))
      .limit(1);
    if (!existingCheckin) {
      await db.insert(checkinsTable).values({
        eventId, riderId: rider.id, raceClass: raceClassList[0],
        bibNumber: bibNumber || rider.bibNumber || null,
        checkedIn: false, rfidLinked: false,
      });
    }
    // Auto-link transponder if the rider entered their own (not a rental)
    if (!wantsRental && myLapsTransponderNumber?.trim()) {
      await autoLinkTransponder(rider.id, eventId, myLapsTransponderNumber);
    }
  }

  // If payment required, create a single Stripe Checkout session covering all classes
  if (needsPayment) {
    try {
      const [club] = await db.select().from(clubsTable).where(eq(clubsTable.id, events[0].clubId));
      if (club?.stripeAccountId) {
        const stripe = await getUncachableStripeClient();
        const appUrl = getAppUrl();

        // Distribute comp discount evenly across classes
        const discountedTotalEntry = Math.max(0, totalEntryFees - compDiscount);
        const perClassFee = numClasses > 0 ? discountedTotalEntry / numClasses : 0;

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const lineItems: any[] = [];

        // One line item per selected class
        for (const cls of raceClassList) {
          if (perClassFee > 0) {
            lineItems.push({
              price_data: {
                currency: "usd",
                product_data: {
                  name: validatedCompCode
                    ? `${events[0].name} — ${cls} Entry (Comp ${validatedCompCode})`
                    : `${events[0].name} — ${cls} Entry`,
                },
                unit_amount: Math.round(perClassFee * 100),
              },
              quantity: 1,
            });
          }
        }

        if (rentalFeeNum > 0) {
          lineItems.push({
            price_data: {
              currency: "usd",
              product_data: { name: "MyLaps Transponder Rental" },
              unit_amount: Math.round(rentalFeeNum * 100),
            },
            quantity: 1,
          });
        }
        if (rfidStickerFeeNum > 0) {
          lineItems.push({
            price_data: {
              currency: "usd",
              product_data: { name: "RFID Sticker" },
              unit_amount: Math.round(rfidStickerFeeNum * 100),
            },
            quantity: 1,
          });
        }

        for (const opt of purchaseOptsList) {
          if (Number(opt.amount) > 0) {
            lineItems.push({
              price_data: {
                currency: "usd",
                product_data: { name: opt.name },
                unit_amount: Math.round(Number(opt.amount) * 100),
              },
              quantity: 1,
            });
          }
        }

        if (lineItems.length === 0) {
          lineItems.push({
            price_data: {
              currency: "usd",
              product_data: { name: `${events[0].name} — ${raceClassList.join(" + ")} Entry` },
              unit_amount: 50,
            },
            quantity: 1,
          });
        }

        const primaryRegId = insertedRegs[0].id;
        const allRegIds = insertedRegs.map(r => r.id).join(",");

        const session = await stripe.checkout.sessions.create({
          mode: "payment",
          line_items: lineItems,
          payment_intent_data: {
            transfer_data: { destination: club.stripeAccountId },
          },
          success_url: `${appUrl}/register/${eventId}?reg_id=${primaryRegId}&session_id={CHECKOUT_SESSION_ID}&payment_success=1`,
          cancel_url: `${appUrl}/register/${eventId}?payment_cancelled=1`,
          metadata: {
            registrationId: String(primaryRegId),   // backward compat
            registrationIds: allRegIds,              // multi-class: comma-sep
            eventId: String(eventId),
          },
          customer_email: email,
        });

        if (session.url) {
          return res.status(201).json({
            requiresPayment: true,
            checkoutUrl: session.url,
            sessionId: session.id,
            registrationId: primaryRegId,
            riderName: `${rider.firstName} ${rider.lastName}`,
            raceClasses: raceClassList,
            eventName: events[0].name,
            entryFee: netFee,
            rentalFee: rentalFeeNum,
            purchaseOptionsTotal,
          });
        }
      }
    } catch (err: any) {
      req.log?.error({ err: err?.message }, "[checkout] Failed to create Stripe Checkout session");
      // Roll back ALL pending registrations so the rider can try again cleanly
      await db.delete(registrationsTable).where(inArray(registrationsTable.id, insertedRegs.map(r => r.id)));
      const isConnectError = err?.message?.toLowerCase().includes("no such destination") || err?.message?.toLowerCase().includes("no such account");
      return res.status(500).json({
        error: isConnectError
          ? "This club's Stripe payment account is not set up correctly. The organizer needs to reconnect their Stripe account in Settings → Payments."
          : "Payment system unavailable. Please try again or contact the event organizer.",
      });
    }
  }

  return res.status(201).json({
    registrationId: insertedRegs[0].id,
    riderName: `${rider.firstName} ${rider.lastName}`,
    raceClasses: raceClassList,
    eventName: events[0].name,
    eventDate: events[0].date,
  });
});

// ── Transponder rental list for an event ───────────────────────────────────────
router.get("/events/:eventId/transponder-rentals", async (req, res) => {
  const eventId = Number(req.params.eventId);
  if (!eventId) return res.status(400).json({ error: "eventId required" });
  const staffCId = getStaffClubId(res);
  if (!await checkEventOwnership(eventId, staffCId, res)) return;

  // Deduplicate by rider: one row per rider (take the first registration's data)
  const rows = await db
    .selectDistinctOn([registrationsTable.riderId], {
      registrationId: registrationsTable.id,
      riderId: registrationsTable.riderId,
      firstName: ridersTable.firstName,
      lastName: ridersTable.lastName,
      email: ridersTable.email,
      bibNumber: registrationsTable.bibNumber,
      transponderNumber: registrationsTable.myLapsTransponderNumber,
      transponderReturned: registrationsTable.transponderReturned,
      raceClass: registrationsTable.raceClass,
      createdAt: registrationsTable.createdAt,
    })
    .from(registrationsTable)
    .innerJoin(ridersTable, eq(registrationsTable.riderId, ridersTable.id))
    .where(and(eq(registrationsTable.eventId, eventId), eq(registrationsTable.transponderRental, true)))
    .orderBy(registrationsTable.riderId, registrationsTable.createdAt);

  // Determine which riders have the app (push token registered).
  const emails = rows.map(r => r.email).filter((e): e is string => !!e);
  const emailsWithToken = new Set<string>();
  if (emails.length > 0) {
    const accounts = await db
      .select({ id: riderAccountsTable.id, email: riderAccountsTable.email })
      .from(riderAccountsTable)
      .where(inArray(riderAccountsTable.email, emails));
    if (accounts.length > 0) {
      const accountIds = accounts.map(a => a.id);
      const tokens = await db
        .select({ riderAccountId: riderPushTokensTable.riderAccountId })
        .from(riderPushTokensTable)
        .where(inArray(riderPushTokensTable.riderAccountId, accountIds));
      const accountIdsWithToken = new Set(tokens.map(t => t.riderAccountId));
      for (const a of accounts) {
        if (accountIdsWithToken.has(a.id)) emailsWithToken.add(a.email);
      }
    }
  }

  return res.json(rows.map(r => ({
    registrationId: r.registrationId,
    riderId: r.riderId,
    riderName: `${r.firstName ?? ""} ${r.lastName ?? ""}`.trim(),
    bibNumber: r.bibNumber ?? null,
    transponderNumber: r.transponderNumber ?? null,
    transponderReturned: r.transponderReturned,
    raceClass: r.raceClass,
    hasPushToken: r.email ? emailsWithToken.has(r.email) : false,
  })));
});

// ── Send transponder return reminder to a single rider ─────────────────────────
router.post("/events/:eventId/transponder-rentals/:riderId/remind", async (req, res) => {
  const eventId = Number(req.params.eventId);
  const riderId = Number(req.params.riderId);
  if (!await checkEventOwnership(eventId, getStaffClubId(res), res)) return;

  const [rider] = await db.select({ email: ridersTable.email, firstName: ridersTable.firstName })
    .from(ridersTable).where(eq(ridersTable.id, riderId));
  if (!rider?.email) return res.status(404).json({ error: "Rider not found or no email" });

  const [account] = await db.select({ id: riderAccountsTable.id })
    .from(riderAccountsTable).where(eq(riderAccountsTable.email, rider.email));
  if (!account) return res.status(404).json({ error: "Rider does not have the app" });

  const tokens = await db.select({ expoPushToken: riderPushTokensTable.expoPushToken })
    .from(riderPushTokensTable).where(eq(riderPushTokensTable.riderAccountId, account.id));
  if (tokens.length === 0) return res.status(404).json({ error: "Rider has no push token" });

  await sendPushNotifications(tokens.map(t => ({
    to: t.expoPushToken,
    title: "Transponder Reminder",
    body: "Please remember to turn in your rented MyLaps transponder.",
  })));

  return res.json({ sent: tokens.length });
});

// ── Send transponder return reminder to all riders who haven't returned yet ────
router.post("/events/:eventId/transponder-rentals/remind-all", async (req, res) => {
  const eventId = Number(req.params.eventId);
  if (!await checkEventOwnership(eventId, getStaffClubId(res), res)) return;

  // All riders with unreturned rentals for this event (one row per rider).
  const unreturned = await db
    .selectDistinctOn([registrationsTable.riderId], {
      riderId: registrationsTable.riderId,
      email: ridersTable.email,
    })
    .from(registrationsTable)
    .innerJoin(ridersTable, eq(registrationsTable.riderId, ridersTable.id))
    .where(and(
      eq(registrationsTable.eventId, eventId),
      eq(registrationsTable.transponderRental, true),
      eq(registrationsTable.transponderReturned, false),
    ))
    .orderBy(registrationsTable.riderId, registrationsTable.createdAt);

  const emails = unreturned.map(r => r.email).filter((e): e is string => !!e);
  if (emails.length === 0) return res.json({ sent: 0 });

  const accounts = await db.select({ id: riderAccountsTable.id })
    .from(riderAccountsTable).where(inArray(riderAccountsTable.email, emails));
  if (accounts.length === 0) return res.json({ sent: 0 });

  const tokens = await db.select({ expoPushToken: riderPushTokensTable.expoPushToken })
    .from(riderPushTokensTable)
    .where(inArray(riderPushTokensTable.riderAccountId, accounts.map(a => a.id)));
  if (tokens.length === 0) return res.json({ sent: 0 });

  await sendPushNotifications(tokens.map(t => ({
    to: t.expoPushToken,
    title: "Transponder Reminder",
    body: "Please remember to turn in your rented MyLaps transponder.",
  })));

  return res.json({ sent: tokens.length });
});

// ── Assign transponder number to a rental registration (event-scoped, auto-expires 24h after event) ─
router.post("/events/:eventId/registrations/:regId/assign-rental-transponder", async (req, res) => {
  const eventId = Number(req.params.eventId);
  const regId = Number(req.params.regId);
  if (!eventId || !regId) return res.status(400).json({ error: "Invalid ids" });
  const staffCId = getStaffClubId(res);
  if (!await checkEventOwnership(eventId, staffCId, res)) return;

  const { transponderNumber } = req.body;
  if (!transponderNumber || typeof transponderNumber !== "string" || !/^\d{1,9}$/.test(transponderNumber.trim())) {
    return res.status(400).json({ error: "transponderNumber must be 1–9 digits" });
  }
  const tag = transponderNumber.trim();

  const [reg] = await db.select({
    id: registrationsTable.id,
    riderId: registrationsTable.riderId,
    transponderRental: registrationsTable.transponderRental,
  }).from(registrationsTable)
    .where(and(eq(registrationsTable.id, regId), eq(registrationsTable.eventId, eventId)));
  if (!reg) return res.status(404).json({ error: "Registration not found" });
  if (!reg.transponderRental) return res.status(400).json({ error: "This registration does not have a transponder rental" });

  const [event] = await db.select({ date: eventsTable.date }).from(eventsTable).where(eq(eventsTable.id, eventId));
  if (!event) return res.status(404).json({ error: "Event not found" });

  // Expiry = event date + 24 hours (event.date is a date string like "2026-06-24")
  const eventDate = new Date(event.date);
  const expiresAt = new Date(eventDate.getTime() + 24 * 60 * 60 * 1000);

  // Guard: transponder must not be assigned to a different rider in this event
  const conflict = await db.select({ riderId: rfidAssignmentsTable.riderId })
    .from(rfidAssignmentsTable)
    .where(and(eq(rfidAssignmentsTable.rfidNumber, tag), eq(rfidAssignmentsTable.eventId, eventId)));
  if (conflict.length > 0 && conflict[0].riderId !== reg.riderId) {
    return res.status(409).json({ error: `Transponder ${tag} is already assigned to another rider for this event` });
  }

  // Upsert rfid_assignment with expiresAt (rental = temporary, does NOT update riders.rfidNumber)
  const existing = await db.select({ id: rfidAssignmentsTable.id })
    .from(rfidAssignmentsTable)
    .where(and(eq(rfidAssignmentsTable.riderId, reg.riderId), eq(rfidAssignmentsTable.eventId, eventId)))
    .limit(1);
  if (existing.length > 0) {
    await db.update(rfidAssignmentsTable)
      .set({ rfidNumber: tag, expiresAt })
      .where(eq(rfidAssignmentsTable.id, existing[0].id));
  } else {
    await db.insert(rfidAssignmentsTable).values({ riderId: reg.riderId, rfidNumber: tag, eventId, expiresAt });
  }

  // Update checkin row so the check-in page reflects the number immediately
  await db.update(checkinsTable)
    .set({ rfidNumber: tag, rfidLinked: true })
    .where(and(eq(checkinsTable.eventId, eventId), eq(checkinsTable.riderId, reg.riderId)));

  // Store on all of this rider's rental registrations for this event
  // (multi-class riders have one row per class — update them all).
  await db.update(registrationsTable)
    .set({ myLapsTransponderNumber: tag })
    .where(and(
      eq(registrationsTable.eventId, eventId),
      eq(registrationsTable.riderId, reg.riderId),
      eq(registrationsTable.transponderRental, true),
    ));

  return res.json({ success: true, transponderNumber: tag, expiresAt: expiresAt.toISOString() });
});

// ── Mark transponder returned ───────────────────────────────────────────────────
router.patch("/events/:eventId/registrations/:regId/transponder-returned", async (req, res) => {
  const eventId = Number(req.params.eventId);
  const regId = Number(req.params.regId);
  if (!eventId || !regId) return res.status(400).json({ error: "Invalid ids" });
  const staffCId = getStaffClubId(res);
  if (!await checkEventOwnership(eventId, staffCId, res)) return;

  const { returned } = req.body; // boolean
  if (typeof returned !== "boolean") return res.status(400).json({ error: "returned (boolean) required" });

  const [reg] = await db.update(registrationsTable)
    .set({ transponderReturned: returned })
    .where(and(eq(registrationsTable.id, regId), eq(registrationsTable.eventId, eventId)))
    .returning({ id: registrationsTable.id, transponderReturned: registrationsTable.transponderReturned });

  if (!reg) return res.status(404).json({ error: "Registration not found" });
  return res.json({ registrationId: reg.id, transponderReturned: reg.transponderReturned });
});

// ── Public: verify Stripe payment and confirm registration(s) ─────────────────
router.post("/public/registrations/:id/verify-payment", async (req, res) => {
  const id = Number(req.params.id);
  const { sessionId } = req.body;
  if (!sessionId) return res.status(400).json({ error: "sessionId required" });

  try {
    const stripe = await getUncachableStripeClient();
    const session = await stripe.checkout.sessions.retrieve(sessionId);

    // Support both multi-class (registrationIds comma-sep) and single-class (registrationId)
    const regIdsStr = session.metadata?.registrationIds || session.metadata?.registrationId;
    if (!regIdsStr) {
      return res.status(403).json({ error: "Session does not match registration" });
    }
    const regIds = regIdsStr.split(",").map(Number).filter(Boolean);
    if (!regIds.includes(id)) {
      return res.status(403).json({ error: "Session does not match registration" });
    }

    if (session.payment_status !== "paid") {
      return res.status(402).json({ error: "Payment not yet completed", paymentStatus: session.payment_status });
    }

    const amountPaidTotal = session.amount_total != null ? session.amount_total / 100 : null;
    // Distribute total evenly across all registrations in this session
    const amountPerReg = amountPaidTotal != null && regIds.length > 0
      ? String(Math.round((amountPaidTotal / regIds.length) * 100) / 100)
      : null;

    const updatedRegs = await db.update(registrationsTable)
      .set({ paymentStatus: "paid", status: "confirmed", paymentMethod: "card", amountPaid: amountPerReg })
      .where(inArray(registrationsTable.id, regIds))
      .returning();

    if (!updatedRegs.length) return res.status(404).json({ error: "Registration not found" });

    const primaryReg = updatedRegs[0];

    // Create one check-in record per rider per event
    const [existingCheckin] = await db.select({ id: checkinsTable.id })
      .from(checkinsTable)
      .where(and(eq(checkinsTable.eventId, primaryReg.eventId), eq(checkinsTable.riderId, primaryReg.riderId)))
      .limit(1);
    if (!existingCheckin) {
      await db.insert(checkinsTable).values({
        eventId: primaryReg.eventId,
        riderId: primaryReg.riderId,
        raceClass: primaryReg.raceClass,
        bibNumber: primaryReg.bibNumber,
        checkedIn: false,
        rfidLinked: false,
      });
    }
    // Auto-link transponder if the rider entered their own number (not a rental)
    if (!primaryReg.transponderRental && primaryReg.myLapsTransponderNumber?.trim()) {
      await autoLinkTransponder(primaryReg.riderId, primaryReg.eventId, primaryReg.myLapsTransponderNumber);
    }

    const [rider] = await db.select().from(ridersTable).where(eq(ridersTable.id, primaryReg.riderId));
    const [event] = await db.select().from(eventsTable).where(eq(eventsTable.id, primaryReg.eventId));

    return res.json({
      registrationId: primaryReg.id,
      riderName: rider ? `${rider.firstName} ${rider.lastName}` : "",
      raceClasses: updatedRegs.map(r => r.raceClass),
      eventName: event?.name ?? "",
      eventDate: event?.date ?? "",
      amountPaid: amountPaidTotal,
    });
  } catch (err: any) {
    req.log?.error({ err: err?.message }, "[verify-payment] Error");
    return res.status(500).json({ error: err?.message ?? "Verification failed" });
  }
});

export default router;
