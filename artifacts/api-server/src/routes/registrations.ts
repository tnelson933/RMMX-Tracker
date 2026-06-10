import { Router } from "express";
import { db } from "@workspace/db";
import { registrationsTable, ridersTable, checkinsTable, eventsTable, clubsTable, compCodesTable, rfidAssignmentsTable } from "@workspace/db";
import { eq, and, sql, desc, ne, isNull } from "drizzle-orm";
import { getUncachableStripeClient } from "../stripeClient";

const router = Router();

router.get("/public/riders/lookup", async (req, res) => {
  const email = ((req.query.email as string) || "").trim().toLowerCase();
  if (!email) return res.status(400).json({ error: "email required" });

  const riders = await db.select().from(ridersTable)
    .where(sql`lower(${ridersTable.email}) = ${email}`)
    .limit(1);

  if (!riders.length) return res.json({ found: false });

  const rider = riders[0];

  const lastRegs = await db.select({
    amaNumber: registrationsTable.amaNumber,
    clubIdNumber: registrationsTable.clubIdNumber,
    bikeBrand: registrationsTable.bikeBrand,
    bibNumber: registrationsTable.bibNumber,
    sponsors: registrationsTable.sponsors,
  }).from(registrationsTable)
    .where(eq(registrationsTable.riderId, rider.id))
    .orderBy(desc(registrationsTable.createdAt))
    .limit(1);

  const lastReg = lastRegs[0] ?? null;

  return res.json({
    found: true,
    firstName: rider.firstName ?? "",
    lastName: rider.lastName ?? "",
    phone: rider.phone ?? "",
    dateOfBirth: rider.dateOfBirth ?? "",
    emergencyContact: rider.emergencyContact ?? "",
    emergencyPhone: rider.emergencyPhone ?? "",
    hometown: rider.hometown ?? "",
    homeState: (rider as any).homeState ?? "",
    amaNumber: lastReg?.amaNumber ?? "",
    clubIdNumber: lastReg?.clubIdNumber ?? "",
    bikeBrand: lastReg?.bikeBrand ?? "",
    bibNumber: lastReg?.bibNumber?.toString() ?? "",
    sponsors: lastReg?.sponsors ?? "",
  });
});

function getAppUrl(): string {
  if (process.env.APP_URL) return process.env.APP_URL;
  const domains = process.env.REPLIT_DOMAINS;
  if (domains) return `https://${domains.split(",")[0]}`;
  return "http://localhost:80";
}

router.get("/events/:eventId/registrations", async (req, res) => {
  const eventId = Number(req.params.eventId);

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
    createdAt: r.createdAt.toISOString(),
    };
  }));
});

router.post("/events/:eventId/registrations", async (req, res) => {
  const eventId = Number(req.params.eventId);
  const {
    riderId, raceClass, bibNumber, bikeBrand, clubIdNumber,
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
  if (eventData?.noDuplicateBibs && bibNumber) {
    const bibTaken = await db.select({ id: registrationsTable.id })
      .from(registrationsTable)
      .where(and(
        eq(registrationsTable.eventId, eventId),
        eq(registrationsTable.bibNumber, String(bibNumber)),
        ne(registrationsTable.status, "void"),
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
    clubIdNumber: clubIdNumber || null,
    status: needsPayment ? "pending" : "confirmed",
    paymentStatus: "unpaid",
    transponderRental: wantsRental,
    myLapsTransponderNumber: myLapsTransponderNumber?.trim() || null,
    selectedPurchaseOptions: Array.isArray(selectedPurchaseOptions) ? selectedPurchaseOptions : [],
  }).returning();

  // Only create the check-in record immediately for free events.
  // For paid events, check-in is created when payment is confirmed.
  if (!needsPayment) {
    await db.insert(checkinsTable).values({
      eventId, riderId: resolvedRiderId, raceClass,
      bibNumber: bibNumber || null,
      checkedIn: false, rfidLinked: false,
    }).onConflictDoNothing();
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

  // Snapshot the current riderId BEFORE updating so we can re-point the checkin row
  const [before] = await db.select({ riderId: registrationsTable.riderId, eventId: registrationsTable.eventId })
    .from(registrationsTable).where(eq(registrationsTable.id, id));
  const oldRiderId = before?.riderId;

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

// ── Public: check if a bib number is already taken for an event ───────────────
router.get("/public/events/:eventId/check-bib", async (req, res) => {
  const eventId = Number(req.params.eventId);
  const bib = ((req.query.bib as string) || "").trim();
  if (!bib) return res.status(400).json({ error: "bib required" });

  const existing = await db.select({ id: registrationsTable.id })
    .from(registrationsTable)
    .where(and(
      eq(registrationsTable.eventId, eventId),
      eq(registrationsTable.bibNumber, bib),
      ne(registrationsTable.status, "void"),
    ))
    .limit(1);

  return res.json({ taken: existing.length > 0 });
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
  }).from(eventsTable)
    .leftJoin(clubsTable, eq(eventsTable.clubId, clubsTable.id))
    .where(eq(eventsTable.id, eventId));

  if (!rows[0]) return res.status(404).json({ error: "Event not found" });
  const e = rows[0];
  return res.json({
    ...e,
    entryFee: e.entryFee ? Number(e.entryFee) : null,
    transponderRentalFee: e.transponderRentalFee ? Number(e.transponderRentalFee) : null,
  });
});

// ── Public: self-service rider registration ───────────────────────────────────
router.post("/public/events/:eventId/register", async (req, res) => {
  const eventId = Number(req.params.eventId);
  const { firstName, lastName, email, phone, dateOfBirth, emergencyContact, emergencyPhone, hometown, homeState, raceClass, bibNumber, amaNumber, clubIdNumber, statsEmailOptIn, sponsors, rentTransponder, myLapsTransponderNumber, selectedPurchaseOptions, compCode, categoryId } = req.body;

  if (!firstName || !lastName || !email || !raceClass) {
    return res.status(400).json({ error: "firstName, lastName, email, and raceClass are required" });
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

  // Enforce unique bib numbers if the event requires it
  if (events[0].noDuplicateBibs && bibNumber) {
    const bibTaken = await db.select({ id: registrationsTable.id })
      .from(registrationsTable)
      .where(and(
        eq(registrationsTable.eventId, eventId),
        eq(registrationsTable.bibNumber, String(bibNumber)),
        ne(registrationsTable.status, "void"),
      ))
      .limit(1);
    if (bibTaken.length > 0) {
      return res.status(409).json({ error: `Bib #${bibNumber} is already taken for this event` });
    }
  }

  // Validate comp code if provided
  let compDiscount = 0;
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
      return res.status(400).json({ error: "Invalid or already-used comp code" });
    }
    if (codeRow.isActive === false) {
      return res.status(400).json({ error: "This comp code is no longer active" });
    }
    if (codeRow.expiresAt && new Date() > codeRow.expiresAt) {
      return res.status(400).json({ error: "This comp code has expired" });
    }
    if (codeRow.usesCount >= codeRow.maxUses) {
      return res.status(400).json({ error: "Invalid or already-used comp code" });
    }
    // Category restriction: if code is restricted to categories, a matching categoryId must be provided
    const codeCatIds = (codeRow.categoryIds as number[]) ?? [];
    if (codeCatIds.length > 0) {
      if (categoryId == null || !codeCatIds.includes(Number(categoryId))) {
        return res.status(400).json({ error: "This comp code is not valid for the selected category" });
      }
    }
    compDiscount = Number(codeRow.amount);
    validatedCompCode = codeRow.code;
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
      hometown: hometown || null,
      homeState: homeState || null,
    } as any).returning();
    rider = created;
  }

  // Determine if payment is required (accounting for comp discount and purchase options)
  const wantsRental = !!(rentTransponder && events[0].transponderRentalEnabled && events[0].transponderRentalFee);
  const entryFeeNum = events[0].entryFee ? Number(events[0].entryFee) : 0;
  const rentalFeeNum = wantsRental && events[0].transponderRentalFee ? Number(events[0].transponderRentalFee) : 0;
  const purchaseOptsList = Array.isArray(selectedPurchaseOptions)
    ? (selectedPurchaseOptions as Array<{ id: string; name: string; amount: number }>)
    : [];
  const purchaseOptionsTotal = purchaseOptsList.reduce((sum, o) => sum + Number(o.amount), 0);
  const netFee = Math.max(0, entryFeeNum + rentalFeeNum + purchaseOptionsTotal - compDiscount);
  const needsPayment = !!events[0].paymentEnabled && netFee > 0;
  const regStatus = needsPayment ? "pending" : "confirmed";

  const [reg] = await db.insert(registrationsTable).values({
    eventId, riderId: rider.id, raceClass,
    bibNumber: bibNumber || rider.bibNumber || null,
    status: regStatus, paymentStatus: "unpaid",
    amaNumber: amaNumber || null,
    clubIdNumber: clubIdNumber || null,
    bikeBrand: req.body.bikeBrand || null,
    sponsors: sponsors || null,
    statsEmailOptIn: !!statsEmailOptIn,
    transponderRental: wantsRental,
    myLapsTransponderNumber: myLapsTransponderNumber?.trim() || null,
    selectedPurchaseOptions: Array.isArray(selectedPurchaseOptions) ? selectedPurchaseOptions : [],
    compCode: validatedCompCode,
    compDiscount: compDiscount > 0 ? String(compDiscount) : null,
  }).returning();

  // Mark comp code as used
  if (validatedCompCode) {
    await db.update(compCodesTable)
      .set({ usesCount: sql`${compCodesTable.usesCount} + 1` })
      .where(eq(compCodesTable.code, validatedCompCode));
  }

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
  if (needsPayment) {
    try {
      const [club] = await db.select().from(clubsTable).where(eq(clubsTable.id, events[0].clubId));
      if (club?.stripeAccountId) {
        const stripe = await getUncachableStripeClient();
        const appUrl = getAppUrl();

        const discountedEntryFee = Math.max(0, entryFeeNum - compDiscount);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const lineItems: any[] = [];

        if (discountedEntryFee > 0) {
          lineItems.push({
            price_data: {
              currency: "usd",
              product_data: {
                name: validatedCompCode
                  ? `${events[0].name} — ${raceClass} Entry (Comp ${validatedCompCode})`
                  : `${events[0].name} — ${raceClass} Entry`,
              },
              unit_amount: Math.round(discountedEntryFee * 100),
            },
            quantity: 1,
          });
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
              product_data: { name: `${events[0].name} — ${raceClass} Entry` },
              unit_amount: 50,
            },
            quantity: 1,
          });
        }

        const session = await stripe.checkout.sessions.create({
          mode: "payment",
          line_items: lineItems,
          payment_intent_data: {
            transfer_data: { destination: club.stripeAccountId },
          },
          success_url: `${appUrl}/register/${eventId}?reg_id=${reg.id}&session_id={CHECKOUT_SESSION_ID}&payment_success=1`,
          cancel_url: `${appUrl}/register/${eventId}?payment_cancelled=1`,
          metadata: { registrationId: String(reg.id), eventId: String(eventId) },
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
            entryFee: netFee,
            rentalFee: rentalFeeNum,
            purchaseOptionsTotal,
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
      .set({ paymentStatus: "paid", status: "confirmed", paymentMethod: "card", amountPaid: amountPaid != null ? String(amountPaid) : null })
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
