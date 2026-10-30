import { eventToday } from "@workspace/api-zod";
import { rentalsOut } from "./rental-transponders";
import { releaseRentalLink, rentalExpiry } from "../lib/rentalTransponders";
import { checkMoney, checkOneOf } from "../lib/validateInput";
import { eventDateReached } from "../lib/eventStatus";
import { Router } from "express";
import { db } from "@workspace/db";
import { registrationsTable, ridersTable, checkinsTable, eventsTable, clubsTable, compCodesTable, rfidAssignmentsTable, clubSettingsTable, riderAccountsTable, riderPushTokensTable, raceResultsTable, liabilityWaiverSignaturesTable, rentalTranspondersTable } from "@workspace/db";
import { eq, and, sql, desc, asc, ne, isNull, isNotNull, inArray, or, lt } from "drizzle-orm";
import { getUncachableStripeClient } from "../stripeClient";
import { sendPushNotifications } from "../lib/push";
import { normalizeActiveTransponderIdentifier } from "../lib/riderTimingIdentity";
import { isRegistrationTransponderRequirementSatisfied } from "../lib/registrationTransponderRequirement";
import { resolvePurchaseOptions } from "../lib/purchaseOptions";
import { includesRmTrackr, markRmTrackrPurchased, fulfillRmTrackr } from "../lib/rmTrackr";
import { eventTimingTags } from "../lib/eventTimingTags";
import { ORGANIZER_NO_STRIPE, organizerCardError, riderCardError } from "../lib/stripeErrors";
import { checkinSellPrices, listClubSellItems } from "../lib/sellItems";
import { RM_TRACKR_NAME } from "@workspace/db";
import { canManageRider } from "../lib/riderAccess";
import { riderMobileTokensTable } from "@workspace/db";

/** Payment-check failures: an unknown/invalid Stripe session is the caller's error (404), anything else a 500 without Stripe's internals. */
function sendPaymentCheckError(res: any, err: any) {
  if (err?.type === "StripeInvalidRequestError") {
    return res.status(404).json({ error: "We couldn't find that payment. Refresh the page; if you were charged, contact the event organizer." });
  }
  return res.status(500).json({ error: "Couldn't confirm the payment yet. Wait a moment and refresh the page." });
}

const router = Router();

// ── Auto-link an active transponder when it's provided at registration ──────────
// Saves it to the rider's permanent profile and marks the check-in row linked so
// the check-in screen shows the transponder already linked — no manual entry needed.
// Timing matches it from the registration; RFID sticker rows (rfid_assignments)
// are only for stickers, since one event can use both kinds of reader.
async function autoLinkTransponder(riderId: number, eventId: number, transponderNumber: string) {
  const normalized = normalizeActiveTransponderIdentifier(transponderNumber);
  if (!normalized) {
    throw new Error("Cannot auto-link an invalid active transponder identifier");
  }

  // 1. Store on the rider's permanent profile so it pre-fills next time — only when the
  //    profile has none. A registration (often anonymous) never replaces a saved
  //    transponder; profile owners/managers change it through their own profile edit.
  await db.update(ridersTable)
    .set({ mylapsTransponderId: normalized })
    .where(and(
      eq(ridersTable.id, riderId),
      or(isNull(ridersTable.mylapsTransponderId), eq(ridersTable.mylapsTransponderId, "")),
    ));

  // 2. Mark the check-in row as transponder-linked
  await db.update(checkinsTable)
    .set({ rfidNumber: normalized, rfidLinked: true })
    .where(and(
      eq(checkinsTable.riderId, riderId),
      eq(checkinsTable.eventId, eventId),
    ));
}

function getStaffClubId(res: any): number | null {
  const v = res.locals?.staffClubId;
  return typeof v === "number" ? v : null;
}

/**
 * Gives back the discount-code use a checkout took, once every entry of that
 * checkout carrying the code (same rider, event and code) is void or refunded.
 * Call it only after an entry has just moved from active to void/refunded, so a
 * checkout releases its one use once, when its last entry goes.
 */
export async function releaseCompCodeIfCheckoutInactive(eventId: number, riderId: number, code: string | null | undefined): Promise<void> {
  if (!code) return;
  const [{ active }] = await db.select({ active: sql<number>`count(*)::int` })
    .from(registrationsTable)
    .where(and(
      eq(registrationsTable.eventId, eventId),
      eq(registrationsTable.riderId, riderId),
      eq(registrationsTable.compCode, code),
      ne(registrationsTable.status, "void"),
      ne(registrationsTable.paymentStatus, "refunded"),
    ));
  if (active > 0) return;
  await db.update(compCodesTable)
    .set({ usesCount: sql`GREATEST(${compCodesTable.usesCount} - 1, 0)` })
    .where(eq(compCodesTable.code, code));
}

type RiderRow = typeof ridersTable.$inferSelect;

type RiderResolution =
  | { rider: RiderRow | null }
  | { status: number; error: string };

async function resolveRegistrationRider(
  email: string | null,
  riderId: unknown,
): Promise<RiderResolution> {
  const normalizedEmail = email?.trim().toLowerCase() || null;

  if (riderId !== undefined && riderId !== null && riderId !== "") {
    const parsedRiderId = Number(riderId);
    if (!Number.isInteger(parsedRiderId) || parsedRiderId <= 0) {
      return { status: 400, error: "This link looks broken. Go back and open it again from the list." };
    }
    if (!normalizedEmail) {
      return { status: 400, error: "Enter the rider's email address." };
    }
    const [selected] = await db.select().from(ridersTable).where(eq(ridersTable.id, parsedRiderId));
    if (!selected) {
      return { status: 404, error: "This rider profile couldn't be found. It may have been deleted. Refresh the page and try again." };
    }
    if ((selected.email ?? "").trim().toLowerCase() !== normalizedEmail) {
      return { status: 409, error: "The selected rider profile does not match the supplied email" };
    }
    return { rider: selected };
  }

  if (!normalizedEmail) {
    return { status: 400, error: "Enter an email address." };
  }
  const emailMatches = await db.select().from(ridersTable)
    .where(sql`lower(${ridersTable.email}) = ${normalizedEmail}`)
    .orderBy(asc(ridersTable.id));
  if (emailMatches.length === 0) return { rider: null };
  if (emailMatches.length === 1) return { rider: emailMatches[0] };

  return {
    status: 409,
    error: "profile-selection-required: Multiple rider profiles use this email. Select the correct rider profile before registering.",
  };
}

function submittedRiderProfile(
  body: Record<string, unknown>,
  normalizedTransponderNumber: string | null,
): Partial<typeof ridersTable.$inferInsert> {
  const profile: Record<string, string | null> = {};
  const copy = (source: string, destination = source) => {
    if (!Object.prototype.hasOwnProperty.call(body, source)) return;
    const value = body[source];
    // A blank field keeps the saved value. The public lookup no longer returns
    // contact/DOB/address details, so returning riders often leave them empty.
    if (typeof value === "string" && value.trim()) profile[destination] = value.trim();
  };

  copy("firstName");
  copy("lastName");
  copy("email");
  copy("phone");
  copy("dateOfBirth");
  copy("emergencyContact");
  copy("emergencyPhone");
  copy("streetAddress");
  copy("city");
  copy("homeState");
  copy("zip");
  copy("bibNumber");
  copy("amaNumber");
  copy("bikeBrand", "bikeManufacturer");
  copy("bikeModel");
  copy("bikeYear");
  copy("sponsors");
  if (Object.prototype.hasOwnProperty.call(body, "myLapsTransponderNumber")) {
    profile.mylapsTransponderId = normalizedTransponderNumber;
  }

  return profile;
}

/** Rider account behind this request (web session or mobile Bearer token), without touching the session. */
async function requestRiderAccount(req: any): Promise<{ id: number; email: string } | null> {
  let accountId = (req.session as any)?.riderAccountId as number | undefined;
  if (!accountId) {
    const auth = (req.headers.authorization ?? "") as string;
    if (auth.startsWith("Bearer ")) {
      const [tok] = await db.select({ riderAccountId: riderMobileTokensTable.riderAccountId })
        .from(riderMobileTokensTable).where(eq(riderMobileTokensTable.token, auth.slice(7).trim()));
      accountId = tok?.riderAccountId;
    }
  }
  if (!accountId) return null;
  const [account] = await db.select({ id: riderAccountsTable.id, email: riderAccountsTable.email })
    .from(riderAccountsTable).where(eq(riderAccountsTable.id, accountId));
  return account ?? null;
}

/**
 * For callers who can't manage the matched rider (anonymous or another account),
 * keep only submitted fields the saved profile doesn't have yet. Existing values,
 * including transponder, bib and AMA numbers, are never replaced. The submitted
 * values still go on the registration row.
 */
function fillOnlyEmptyProfileFields(
  existing: RiderRow,
  submitted: Partial<typeof ridersTable.$inferInsert>,
): Partial<typeof ridersTable.$inferInsert> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(submitted)) {
    const current = (existing as Record<string, unknown>)[key];
    const isEmpty = current == null || (typeof current === "string" && current.trim() === "");
    if (isEmpty && value != null && value !== "") out[key] = value;
  }
  return out as Partial<typeof ridersTable.$inferInsert>;
}

async function checkEventOwnership(eventId: number, staffCId: number | null, res: any): Promise<boolean> {
  if (staffCId === null) return true;
  const [evt] = await db.select({ clubId: eventsTable.clubId }).from(eventsTable).where(eq(eventsTable.id, eventId));
  if (!evt || evt.clubId !== staffCId) { res.status(403).json({ error: "Your account doesn't have access to this. If it should, ask your club's owner to check your role on the Team page." }); return false; }
  return true;
}

router.get("/public/riders/lookup", async (req, res) => {
  const email = ((req.query.email as string) || "").trim().toLowerCase();
  if (!email) return res.status(400).json({ error: "Enter an email address." });

  const riders = await db.select().from(ridersTable)
    .where(sql`lower(${ridersTable.email}) = ${email}`)
    .orderBy(asc(ridersTable.id));

  if (!riders.length) return res.json({ found: false, count: 0, riders: [] });

  // Contact, DOB, address and emergency details only go to a signed-in organizer
  // or the rider account that owns this email. Anonymous callers get racing info.
  let canSeePrivate = !!(req.session as any)?.userId;
  const riderAccountId = (req.session as any)?.riderAccountId as number | undefined;
  if (!canSeePrivate && riderAccountId) {
    const [account] = await db.select({ email: riderAccountsTable.email })
      .from(riderAccountsTable).where(eq(riderAccountsTable.id, riderAccountId));
    canSeePrivate = account?.email?.trim().toLowerCase() === email;
  }
  const priv = (v: string | null | undefined) => (canSeePrivate ? v ?? "" : "");

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
    myLapsTransponderNumber: registrationsTable.myLapsTransponderNumber,
    createdAt: registrationsTable.createdAt,
    id: registrationsTable.id,
  }).from(registrationsTable)
    .where(inArray(registrationsTable.riderId, riderIds))
    .orderBy(desc(registrationsTable.createdAt), desc(registrationsTable.id));

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
      email: rider.email ?? "",
      phone: priv(rider.phone),
      dateOfBirth: priv(rider.dateOfBirth),
      emergencyContact: priv(rider.emergencyContact),
      emergencyPhone: priv(rider.emergencyPhone),
      streetAddress: priv(rider.streetAddress),
      city: priv(rider.city),
      homeState: rider.homeState ?? "",
      zip: priv(rider.zip),
      amaNumber: lastReg?.amaNumber ?? rider.amaNumber ?? "",
      clubIdNumber: lastReg?.clubIdNumber ?? "",
      bikeBrand: lastReg?.bikeBrand ?? rider.bikeManufacturer ?? "",
      bikeModel: lastReg?.bikeModel ?? rider.bikeModel ?? "",
      bikeYear: lastReg?.bikeYear ?? rider.bikeYear ?? "",
      bibNumber: lastReg?.bibNumber?.toString() ?? rider.bibNumber ?? "",
      sponsors: lastReg?.sponsors ?? rider.sponsors ?? "",
      myLapsTransponderNumber: lastReg?.myLapsTransponderNumber ?? rider.mylapsTransponderId ?? "",
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
    // RFID stickers only: a rental transponder link (with an expiry) isn't a sticker.
    .where(isNull(rfidAssignmentsTable.expiresAt))
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
    streetAddress, city, homeState, zip, amaNumber, sponsors,
    // Active transponder fields (legacy API property retained for compatibility)
    rentTransponder, myLapsTransponderNumber,
    // Purchase options
    selectedPurchaseOptions,
  } = req.body;

  if (!raceClass) return res.status(400).json({ error: "Choose a class." });

  const [eventData] = await db.select().from(eventsTable).where(eq(eventsTable.id, eventId));
  const normalizedTransponderNumber =
    normalizeActiveTransponderIdentifier(myLapsTransponderNumber);
  const hasNonblankTransponder =
    myLapsTransponderNumber != null &&
    (typeof myLapsTransponderNumber !== "string" || myLapsTransponderNumber.trim() !== "");
  if (hasNonblankTransponder && !normalizedTransponderNumber) {
    return res.status(400).json({
      error: "Enter the ID printed on the transponder (up to 9 numbers or letters A–F).",
    });
  }
  if (!isRegistrationTransponderRequirementSatisfied(
    eventData,
    {
      transponderNumber: normalizedTransponderNumber,
      rentTransponder,
      buyTransponder: includesRmTrackr(resolvePurchaseOptions(selectedPurchaseOptions, eventData?.purchaseOptions)),
    },
  )) {
    return res.status(400).json({
      error: "Enter the rider's active transponder number, or select a rental or an RM TrackR purchase.",
    });
  }

  let resolvedRiderId: number;
  let rider: RiderRow;

  if (email || riderId) {
    const resolution = await resolveRegistrationRider(
      email == null ? null : String(email),
      riderId,
    );
    if ("error" in resolution) return res.status(resolution.status).json({ error: resolution.error });
    const profileFields = submittedRiderProfile(req.body, normalizedTransponderNumber);
    if (resolution.rider) {
      if (Object.keys(profileFields).length > 0) {
        const [updated] = await db.update(ridersTable)
          .set(profileFields)
          .where(eq(ridersTable.id, resolution.rider.id))
          .returning();
        rider = updated;
      } else {
        rider = resolution.rider;
      }
      resolvedRiderId = rider.id;
    } else {
      if (!firstName || !lastName) {
        return res.status(400).json({ error: "Enter the rider's first and last name." });
      }
      const [created] = await db.insert(ridersTable).values({
        ...profileFields,
        firstName: String(firstName).trim(),
        lastName: String(lastName).trim(),
        email: String(email).trim(),
      }).returning();
      rider = created;
      resolvedRiderId = created.id;
    }
  } else {
    return res.status(400).json({ error: "Pick a rider, or enter a new rider's first name, last name and email." });
  }

  // Determine if payment is required — on-site registrations start pending when the event has a fee
  const needsPayment = !!(eventData?.paymentEnabled && eventData?.entryFee);
  // A rental is recorded even when the event charges nothing for it.
  const wantsRental = !!(rentTransponder && eventData?.transponderRentalEnabled);

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
    amaNumber: amaNumber || null,
    clubIdNumber: clubIdNumber || null,
    sponsors: sponsors || null,
    status: needsPayment ? "pending" : "confirmed",
    paymentStatus: "unpaid",
    transponderRental: wantsRental,
    myLapsTransponderNumber: normalizedTransponderNumber,
    selectedPurchaseOptions: resolvePurchaseOptions(selectedPurchaseOptions, eventData?.purchaseOptions),
    rmTrackrPurchased: includesRmTrackr(resolvePurchaseOptions(selectedPurchaseOptions, eventData?.purchaseOptions)),
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
      }).onConflictDoNothing();
    }
  }

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
  const invalid =
    checkOneOf(req.body, "status", ["pending", "confirmed", "void"]) ??
    checkOneOf(req.body, "paymentStatus", ["unpaid", "paid", "refunded"]) ??
    checkMoney(req.body, ["amountPaid"]);
  if (invalid) return res.status(400).json({ error: invalid });
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
  // null / "" clears the amount (String(null) used to store the text "null").
  if (amountPaid !== undefined) updates.amountPaid = amountPaid === null || amountPaid === "" ? null : String(amountPaid);
  if (paymentMethod !== undefined) updates.paymentMethod = paymentMethod;
  if (displayFirstName !== undefined) updates.displayFirstName = displayFirstName;
  if (displayLastName !== undefined) updates.displayLastName = displayLastName;
  if (newRiderId !== undefined) updates.riderId = newRiderId;

  // Snapshot the current riderId and raceClass BEFORE updating so we can cascade
  const [before] = await db.select({
    riderId: registrationsTable.riderId, eventId: registrationsTable.eventId, raceClass: registrationsTable.raceClass,
    status: registrationsTable.status, paymentStatus: registrationsTable.paymentStatus, compCode: registrationsTable.compCode,
  })
    .from(registrationsTable).where(eq(registrationsTable.id, id));
  const oldRiderId = before?.riderId;
  const oldRaceClass = before?.raceClass;

  if (before) {
    if (!await checkEventOwnership(before.eventId, getStaffClubId(res), res)) return;
  } else {
    return res.status(404).json({ error: "That item couldn't be found. It may have been deleted. Refresh the page and try again." });
  }

  const [reg] = await db.update(registrationsTable).set(updates as any).where(eq(registrationsTable.id, id)).returning();
  if (!reg) return res.status(404).json({ error: "That item couldn't be found. It may have been deleted. Refresh the page and try again." });

  // Voiding or refunding the last entry of a checkout gives its discount-code use back.
  const wasActive = before.status !== "void" && before.paymentStatus !== "refunded";
  const nowInactive = reg.status === "void" || reg.paymentStatus === "refunded";
  if (wasActive && nowInactive && before.compCode) {
    await releaseCompCodeIfCheckoutInactive(reg.eventId, before.riderId, before.compCode);
  }

  // If riderId changed, re-point exactly one checkin row for this rider+event to the new rider
  if (newRiderId !== undefined && oldRiderId && oldRiderId !== newRiderId) {
    const [checkinToMove] = await db.select({ id: checkinsTable.id, raceClass: checkinsTable.raceClass })
      .from(checkinsTable)
      .where(and(eq(checkinsTable.eventId, reg.eventId), eq(checkinsTable.riderId, oldRiderId)))
      .limit(1);
    // One check-in per rider, event and class (unique index): leave it if the new
    // rider already has that one.
    const [targetHas] = checkinToMove ? await db.select({ id: checkinsTable.id }).from(checkinsTable)
      .where(and(eq(checkinsTable.eventId, reg.eventId), eq(checkinsTable.riderId, newRiderId), eq(checkinsTable.raceClass, checkinToMove.raceClass)))
      .limit(1) : [];
    if (checkinToMove && !targetHas) {
      await db.update(checkinsTable)
        .set({ riderId: newRiderId })
        .where(eq(checkinsTable.id, checkinToMove.id));
    }
  }

  // If raceClass changed, cascade to checkins and race_results for this rider+event
  if (raceClass !== undefined && oldRaceClass && raceClass !== oldRaceClass) {
    const cascadeRiderId = reg.riderId;
    // Update the rider's check-in record so they appear in the correct class at gate
    // (unless they already have one for the new class: one per rider/event/class).
    const [alreadyInNewClass] = await db.select({ id: checkinsTable.id }).from(checkinsTable)
      .where(and(eq(checkinsTable.eventId, reg.eventId), eq(checkinsTable.riderId, cascadeRiderId), eq(checkinsTable.raceClass, raceClass)))
      .limit(1);
    if (!alreadyInNewClass) await db.update(checkinsTable)
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
    if (!reg) return res.status(404).json({ error: "This registration couldn't be found. It may have been cancelled. Refresh the page and try again." });
    if (reg.eventId !== eventId) return res.status(403).json({ error: "This registration is for a different event. Refresh the page and try again." });
    if (reg.paymentStatus === "paid") return res.status(409).json({ error: "This entry is already paid." });
    if (reg.status === "void") return res.status(409).json({ error: "This entry was cancelled." });

    const stripeForCheck = await getUncachableStripeClient();
    // A checkout already started for this entry: if it was paid, record it; if
    // it's still open, reuse it rather than starting a second charge.
    if (reg.stripeSessionId) {
      const previous = await stripeForCheck.checkout.sessions.retrieve(reg.stripeSessionId).catch(() => null);
      if (previous?.payment_status === "paid") {
        await confirmRegistrationSession(previous);
        return res.status(409).json({ error: "This entry was already paid by card. Refresh to see it." });
      }
      if (previous?.status === "open" && previous.url) {
        return res.json({ checkoutUrl: previous.url, sessionId: previous.id });
      }
    }

    const [event] = await db.select().from(eventsTable).where(eq(eventsTable.id, eventId));
    if (!event?.entryFee) return res.status(400).json({ error: "This event has no entry fee set. Add one on the event's Edit page, then try again." });

    const [club] = await db.select().from(clubsTable).where(eq(clubsTable.id, event.clubId));
    if (!club?.stripeAccountId) return res.status(400).json({ error: ORGANIZER_NO_STRIPE });

    const stripe = await getUncachableStripeClient();
    const appUrl = getAppUrl();
    const todayStr = eventToday(event);
    const earlyBirdActive = !!(event.earlyBirdEndsAt && todayStr <= event.earlyBirdEndsAt && event.earlyBirdFee);
    const entryFee = earlyBirdActive ? Number(event.earlyBirdFee) : Number(event.entryFee);
    const rentalFee = (reg.transponderRental && event.transponderRentalEnabled && event.transponderRentalFee)
      ? Number(event.transponderRentalFee)
      : 0;

    const [rider] = await db.select().from(ridersTable).where(eq(ridersTable.id, reg.riderId));

    // Re-price stored selections from the event config (older rows may hold client-supplied amounts).
    const purchaseOptsList = resolvePurchaseOptions(reg.selectedPurchaseOptions, event.purchaseOptions);
    const purchaseOptionsTotal = purchaseOptsList.reduce((sum, o) => sum + Number(o.amount), 0);

    // Same price as registering online: the rider's comp discount comes off the entry.
    const entryAfterDiscount = Math.max(0, entryFee - (Number(reg.compDiscount ?? 0) || 0));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const lineItems: any[] = entryAfterDiscount > 0 ? [
      {
        price_data: {
          currency: "usd",
          product_data: { name: `${event.name} — ${reg.raceClass} Entry` },
          unit_amount: Math.round(entryAfterDiscount * 100),
        },
        quantity: 1,
      },
    ] : [];
    if (reg.rfidStickerPurchased && Number(event.rfidStickerFee) > 0) {
      lineItems.push({
        price_data: { currency: "usd", product_data: { name: "RFID Sticker" }, unit_amount: Math.round(Number(event.rfidStickerFee) * 100) },
        quantity: 1,
      });
    }

    if (rentalFee > 0) {
      lineItems.push({
        price_data: {
          currency: "usd",
          product_data: { name: "Active Transponder Rental" },
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

    if (lineItems.length === 0) return res.status(409).json({ error: "Nothing is due on this entry. Mark it paid instead." });

    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      line_items: lineItems,
      customer_email: rider?.email ?? undefined,
      payment_intent_data: {
        transfer_data: { destination: club.stripeAccountId },
      },
      metadata: { registrationId: String(regId), registrationIds: String(regId), type: "registration" },
      success_url: `${appUrl}/events/${eventId}/registrations`,
      cancel_url: `${appUrl}/events/${eventId}/registrations`,
    });
    const chargeCents = lineItems.reduce((sum, li) => sum + li.price_data.unit_amount * li.quantity, 0);
    await db.update(registrationsTable)
      .set({ stripeSessionId: session.id, amountDue: (chargeCents / 100).toFixed(2) })
      .where(eq(registrationsTable.id, regId));

    return res.json({ checkoutUrl: session.url, sessionId: session.id, entryFee, rentalFee, purchaseOptionsTotal });
  } catch (err: any) {
    req.log?.error({ err: err?.message }, "[charge] Error");
    return res.status(500).json({ error: organizerCardError(err) });
  }
});

// ── Organizer: add transponder rental to an existing registration (on-site) ───
router.post("/events/:eventId/registrations/:regId/add-transponder-rental", async (req, res) => {
  const eventId = Number(req.params.eventId);
  if (!await checkEventOwnership(eventId, getStaffClubId(res), res)) return;
  const regId = Number(req.params.regId);
  const { paymentMethod } = req.body; // 'cash' | 'card'

  const [reg] = await db.select().from(registrationsTable).where(eq(registrationsTable.id, regId));
  if (!reg) return res.status(404).json({ error: "This registration couldn't be found. It may have been cancelled. Refresh the page and try again." });
  if (reg.eventId !== eventId) return res.status(403).json({ error: "This registration is for a different event. Refresh the page and try again." });
  if (reg.transponderRental) return res.status(400).json({ error: "This rider already has a rental transponder for this event." });

  const [event] = await db.select().from(eventsTable).where(eq(eventsTable.id, eventId));
  if (!event?.transponderRentalEnabled || !event.transponderRentalFee) {
    return res.status(400).json({ error: "Transponder rentals aren't turned on for this event. Turn them on in the event's settings first." });
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
        return res.status(400).json({ error: ORGANIZER_NO_STRIPE });
      }

      const stripe = await getUncachableStripeClient();
      const appUrl = getAppUrl();
      const [rider] = await db.select().from(ridersTable).where(eq(ridersTable.id, reg.riderId));

      const session = await stripe.checkout.sessions.create({
        mode: "payment",
        line_items: [{
          price_data: {
            currency: "usd",
            product_data: { name: "Active Transponder Rental" },
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
      return res.status(500).json({ error: organizerCardError(err) });
    }
  }

  return res.status(400).json({ error: "Choose Cash or Card, then try again." });
});

// ── Organizer: add RFID sticker purchase at check-in gate ─────────────────────
router.post("/events/:eventId/registrations/:regId/add-rfid-sticker", async (req, res) => {
  const eventId = Number(req.params.eventId);
  if (!await checkEventOwnership(eventId, getStaffClubId(res), res)) return;
  const regId = Number(req.params.regId);
  const { paymentMethod } = req.body; // 'cash' | 'card'

  const [reg] = await db.select().from(registrationsTable).where(eq(registrationsTable.id, regId));
  if (!reg) return res.status(404).json({ error: "This registration couldn't be found. It may have been cancelled. Refresh the page and try again." });
  if (reg.eventId !== eventId) return res.status(403).json({ error: "This registration is for a different event. Refresh the page and try again." });
  if (reg.rfidStickerPurchased) return res.status(400).json({ error: "This rider already has an RFID sticker for this event." });

  const [event] = await db.select().from(eventsTable).where(eq(eventsTable.id, eventId));
  // The event's sticker fee, or the club's RFID Tag price (Admin → Sell Items).
  const stickerFee = event ? checkinSellPrices(event, await listClubSellItems(event.clubId)).rfidTag : null;
  if (!event || stickerFee == null) {
    return res.status(400).json({ error: "RFID tags have no price yet. Set one in Admin → Sell Items, or turn on RFID stickers in the event's settings." });
  }

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
        return res.status(400).json({ error: ORGANIZER_NO_STRIPE });
      }

      const stripe = await getUncachableStripeClient();
      const appUrl = getAppUrl();
      const [rider] = await db.select().from(ridersTable).where(eq(ridersTable.id, reg.riderId));

      const session = await stripe.checkout.sessions.create({
        mode: "payment",
        line_items: [{
          price_data: {
            currency: "usd",
            product_data: { name: "RFID Tag" },
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
      return res.status(500).json({ error: organizerCardError(err) });
    }
  }

  return res.status(400).json({ error: "Choose Cash or Card, then try again." });
});

// ── Organizer: what check-in can sell at this event, and for how much ─────────
router.get("/events/:eventId/sell-prices", async (req, res) => {
  const eventId = Number(req.params.eventId);
  if (!await checkEventOwnership(eventId, getStaffClubId(res), res)) return;
  const [event] = await db.select().from(eventsTable).where(eq(eventsTable.id, eventId));
  if (!event) return res.status(404).json({ error: "This event couldn't be found. It may have been deleted. Go back to Events and open it again." });
  return res.json(checkinSellPrices(event, await listClubSellItems(event.clubId)));
});

// ── Organizer: sell an RM TrackR at the check-in gate (POS) ────────────────────
// Cash marks it purchased now; card returns a Stripe Checkout session the
// employee opens on their device to key in the card, or shows as a QR code for
// the rider to pay on their phone. Card numbers never touch our servers.
router.post("/events/:eventId/registrations/:regId/add-rm-trackr", async (req, res) => {
  const eventId = Number(req.params.eventId);
  if (!await checkEventOwnership(eventId, getStaffClubId(res), res)) return;
  const regId = Number(req.params.regId);
  const { paymentMethod } = req.body; // 'cash' | 'card'

  const [reg] = await db.select().from(registrationsTable).where(eq(registrationsTable.id, regId));
  if (!reg) return res.status(404).json({ error: "This registration couldn't be found. It may have been cancelled. Refresh the page and try again." });
  if (reg.eventId !== eventId) return res.status(403).json({ error: "This registration is for a different event. Refresh the page and try again." });
  if (reg.status === "void") return res.status(400).json({ error: "This registration was cancelled" });
  if (reg.rmTrackrPurchased) return res.status(400).json({ error: `This rider already bought an ${RM_TRACKR_NAME} for this registration.` });

  const [event] = await db.select().from(eventsTable).where(eq(eventsTable.id, eventId));
  if (!event) return res.status(404).json({ error: "This event couldn't be found. It may have been deleted. Go back to Events and open it again." });
  // The event's RM TrackR price, or the club's (Admin → Sell Items).
  const price = checkinSellPrices(event, await listClubSellItems(event.clubId)).rmTrackr;
  if (price == null) return res.status(400).json({ error: `Your club has hidden the ${RM_TRACKR_NAME} in Admin → Sell Items. Show it there to sell it.` });

  if (paymentMethod === "cash") {
    await markRmTrackrPurchased(eventId, reg.riderId);
    return res.json({ success: true, price });
  }

  if (paymentMethod === "card") {
    try {
      const [club] = await db.select().from(clubsTable).where(eq(clubsTable.id, event.clubId));
      if (!club?.stripeAccountId) {
        return res.status(400).json({ error: ORGANIZER_NO_STRIPE });
      }

      const stripe = await getUncachableStripeClient();
      const appUrl = getAppUrl();
      const [rider] = await db.select().from(ridersTable).where(eq(ridersTable.id, reg.riderId));

      const session = await stripe.checkout.sessions.create({
        mode: "payment",
        line_items: [{
          price_data: {
            currency: "usd",
            product_data: { name: RM_TRACKR_NAME },
            unit_amount: Math.round(price * 100),
          },
          quantity: 1,
        }],
        customer_email: rider?.email ?? undefined,
        payment_intent_data: {
          transfer_data: { destination: club.stripeAccountId },
        },
        metadata: { registrationId: String(regId), type: "rm_trackr" },
        success_url: `${appUrl}/events/${eventId}/checkin`,
        cancel_url: `${appUrl}/events/${eventId}/checkin`,
      });

      return res.json({ checkoutUrl: session.url, sessionId: session.id, price });
    } catch (err: any) {
      req.log?.error({ err: err?.message }, "[add-rm-trackr] Error");
      return res.status(500).json({ error: organizerCardError(err) });
    }
  }

  return res.status(400).json({ error: "Choose Cash or Card, then try again." });
});

// ── Public: verify RM TrackR Stripe payment and mark purchased ─────────────────
router.post("/public/registrations/:id/verify-rm-trackr", async (req, res) => {
  const id = Number(req.params.id);
  const { sessionId } = req.body;
  if (!sessionId) return res.status(400).json({ error: "This payment link is incomplete. Start the payment again." });

  try {
    const stripe = await getUncachableStripeClient();
    const session = await stripe.checkout.sessions.retrieve(sessionId);

    if (session.metadata?.registrationId !== String(id) || session.metadata?.type !== "rm_trackr") {
      return res.status(403).json({ error: "This payment link doesn't match this RM TrackR purchase. Start the payment again." });
    }
    if (session.payment_status !== "paid") {
      return res.status(402).json({ error: "The payment hasn't finished yet. Finish paying in the Stripe window, then try again." });
    }

    const [reg] = await db.select({ riderId: registrationsTable.riderId, eventId: registrationsTable.eventId })
      .from(registrationsTable).where(eq(registrationsTable.id, id));
    if (!reg) return res.status(404).json({ error: "This registration couldn't be found. It may have been cancelled. Refresh the page and try again." });

    await markRmTrackrPurchased(reg.eventId, reg.riderId);
    return res.json({ paid: true });
  } catch (err: any) {
    req.log?.error({ err: err?.message }, "[verify-rm-trackr] Error");
    return sendPaymentCheckError(res, err);
  }
});

// ── Public: verify RFID sticker Stripe payment and mark purchased ──────────────
router.post("/public/registrations/:id/verify-rfid-sticker", async (req, res) => {
  const id = Number(req.params.id);
  const { sessionId } = req.body;
  if (!sessionId) return res.status(400).json({ error: "This payment link is incomplete. Start the payment again." });

  try {
    const stripe = await getUncachableStripeClient();
    const session = await stripe.checkout.sessions.retrieve(sessionId);

    if (session.metadata?.registrationId !== String(id) || session.metadata?.type !== "rfid_sticker") {
      return res.status(403).json({ error: "This payment link doesn't match this sticker purchase. Start the payment again." });
    }
    if (session.payment_status !== "paid") {
      return res.status(402).json({ error: "The payment hasn't finished yet. Finish paying in the Stripe window, then try again." });
    }

    const [reg] = await db.select({ riderId: registrationsTable.riderId, eventId: registrationsTable.eventId })
      .from(registrationsTable).where(eq(registrationsTable.id, id));
    if (!reg) return res.status(404).json({ error: "This registration couldn't be found. It may have been cancelled. Refresh the page and try again." });

    await db.update(registrationsTable)
      .set({ rfidStickerPurchased: true })
      .where(and(eq(registrationsTable.eventId, reg.eventId), eq(registrationsTable.riderId, reg.riderId)));

    return res.json({ paid: true });
  } catch (err: any) {
    req.log?.error({ err: err?.message }, "[verify-rfid-sticker] Error");
    return sendPaymentCheckError(res, err);
  }
});

// ── Public: verify transponder rental Stripe payment and activate rental ──────
router.post("/public/registrations/:id/verify-transponder-rental", async (req, res) => {
  const id = Number(req.params.id);
  const { sessionId } = req.body;
  if (!sessionId) return res.status(400).json({ error: "This payment link is incomplete. Start the payment again." });

  try {
    const stripe = await getUncachableStripeClient();
    const session = await stripe.checkout.sessions.retrieve(sessionId);

    if (session.metadata?.registrationId !== String(id) || session.metadata?.type !== "transponder_rental") {
      return res.status(403).json({ error: "This payment link doesn't match this rental. Start the payment again." });
    }
    if (session.payment_status !== "paid") {
      return res.status(402).json({ error: "The payment hasn't finished yet. Finish paying in the Stripe window, then try again." });
    }

    const [reg] = await db.update(registrationsTable)
      .set({ transponderRental: true })
      .where(eq(registrationsTable.id, id))
      .returning();

    if (!reg) return res.status(404).json({ error: "This registration couldn't be found. It may have been cancelled. Refresh the page and try again." });

    return res.json({ paid: true });
  } catch (err: any) {
    req.log?.error({ err: err?.message }, "[verify-transponder-rental] Error");
    return sendPaymentCheckError(res, err);
  }
});

// ── Organizer: waiver acknowledgment history for a rider ──────────────────────
router.get("/clubs/:clubId/riders/:riderId/waiver-acknowledgments", async (req, res) => {
  const session = req.session as any;
  if (!session?.userId) return res.status(401).json({ error: "You're signed out. Sign in again, then try once more." });

  const clubId = Number(req.params.clubId);
  const riderId = Number(req.params.riderId);

  // Enforce club scope: non-super-admin staff may only query their own club
  const staffCId = getStaffClubId(res);
  if (staffCId !== null && staffCId !== clubId) {
    return res.status(403).json({ error: "Your account doesn't have access to this. If it should, ask your club's owner to check your role on the Team page." });
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
  if (!bib) return res.status(400).json({ error: "Enter a bib number." });
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
    raceClassDetails: eventsTable.raceClassDetails,
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
    contingencyBrands: eventsTable.contingencyBrands,
    noDuplicateBibs: eventsTable.noDuplicateBibs,
    requireClubId: eventsTable.requireClubId,
    requireWaiver: eventsTable.requireWaiver,
    requireLiabilityWaiver: eventsTable.requireLiabilityWaiver,
    requireTransponder: eventsTable.requireTransponder,
    earlyBirdFee: eventsTable.earlyBirdFee,
    earlyBirdEndsAt: eventsTable.earlyBirdEndsAt,
  }).from(eventsTable)
    .leftJoin(clubsTable, eq(eventsTable.clubId, clubsTable.id))
    .where(eq(eventsTable.id, eventId));

  if (!rows[0]) return res.status(404).json({ error: "This event couldn't be found. It may have been deleted. Go back to Events and open it again." });
  const e = rows[0];

  // Fetch club settings: waiver text + pdf + default class details
  const [settings] = await db.select({
    riderAcknowledgement: clubSettingsTable.riderAcknowledgement,
    waiverPdfUrl: clubSettingsTable.waiverPdfUrl,
    liabilityWaiverText: clubSettingsTable.liabilityWaiverText,
    liabilityWaiverPdfUrl: clubSettingsTable.liabilityWaiverPdfUrl,
    liabilityWaiverFields: clubSettingsTable.liabilityWaiverFields,
    defaultClasses: clubSettingsTable.defaultClasses,
  }).from(clubSettingsTable).where(eq(clubSettingsTable.clubId, e.clubId));

  const waiverText: string | null = e.requireWaiver ? (settings?.riderAcknowledgement ?? null) : null;
  const waiverPdfUrl: string | null = e.requireWaiver ? (settings?.waiverPdfUrl ?? null) : null;
  const liabilityWaiverText: string | null = e.requireLiabilityWaiver ? (settings?.liabilityWaiverText ?? null) : null;
  const liabilityWaiverPdfUrl: string | null = e.requireLiabilityWaiver ? (settings?.liabilityWaiverPdfUrl ?? null) : null;
  const liabilityWaiverFields = e.requireLiabilityWaiver ? (settings?.liabilityWaiverFields ?? null) : null;

  // Build classDetails: start from club-level defaults, then overlay per-event overrides
  const classDetails: Record<string, string> = {};
  const defaultClasses = (settings?.defaultClasses ?? []) as { id: string; name: string; details?: string }[];
  for (const dc of defaultClasses) {
    if (dc.details && dc.details.trim()) classDetails[dc.name] = dc.details.trim();
  }
  const eventLevelDetails = (e.raceClassDetails ?? {}) as Record<string, string>;
  for (const [cls, detail] of Object.entries(eventLevelDetails)) {
    if (detail && detail.trim()) classDetails[cls] = detail.trim();
  }

  return res.json({
    ...e,
    // Which kinds of tag the event's readers use (RM TrackR, RFID or both).
    timingTags: await eventTimingTags(eventId),
    entryFee: e.entryFee ? Number(e.entryFee) : null,
    earlyBirdFee: e.earlyBirdFee ? Number(e.earlyBirdFee) : null,
    earlyBirdEndsAt: e.earlyBirdEndsAt ?? null,
    transponderRentalFee: e.transponderRentalFee ? Number(e.transponderRentalFee) : null,
    classDetails,
    waiverText,
    waiverPdfUrl,
    liabilityWaiverText,
    liabilityWaiverPdfUrl,
    liabilityWaiverFields,
  });
});

// ── Public: self-service rider registration ───────────────────────────────────
router.post("/public/events/:eventId/register", async (req, res) => {
  const eventId = Number(req.params.eventId);
  const { firstName, lastName, email, phone, dateOfBirth, emergencyContact, emergencyPhone, hometown, homeState, streetAddress, city, zip, raceClass, bibNumber, amaNumber, clubIdNumber, statsEmailOptIn, sponsors, rentTransponder, myLapsTransponderNumber, selectedPurchaseOptions, compCode, waiverAcknowledgedAt, purchaseRfidSticker, riderId: hintedRiderId } = req.body;

  // Accept raceClasses[] (new multi-class) or raceClass string (backward compat)
  const rawClasses = Array.isArray(req.body.raceClasses) ? (req.body.raceClasses as string[]) : null;
  const raceClassList: string[] = rawClasses ?? (raceClass ? [raceClass] : []);

  if (!firstName || !lastName || !email || raceClassList.length === 0) {
    return res.status(400).json({ error: "Enter the rider's first name, last name and email, and choose at least one class." });
  }
  if (raceClassList.length !== new Set(raceClassList).size) {
    return res.status(400).json({ error: "The same class is picked twice. Remove the duplicate and try again." });
  }

  // Confirm event exists and is open for registration
  const events = await db.select().from(eventsTable).where(eq(eventsTable.id, eventId));
  if (!events[0]) return res.status(404).json({ error: "This event couldn't be found. It may have been deleted. Go back to Events and open it again." });
  const normalizedTransponderNumber =
    normalizeActiveTransponderIdentifier(myLapsTransponderNumber);
  const hasNonblankTransponder =
    myLapsTransponderNumber != null &&
    (typeof myLapsTransponderNumber !== "string" || myLapsTransponderNumber.trim() !== "");
  if (hasNonblankTransponder && !normalizedTransponderNumber) {
    return res.status(400).json({
      error: "Enter the ID printed on the transponder (up to 9 numbers or letters A–F).",
    });
  }
  if (!isRegistrationTransponderRequirementSatisfied(
    events[0],
    {
      transponderNumber: normalizedTransponderNumber,
      rentTransponder,
      buyTransponder: includesRmTrackr(resolvePurchaseOptions(selectedPurchaseOptions, events[0].purchaseOptions)),
    },
  )) {
    return res.status(400).json({
      error: "Enter your transponder number, or choose to rent or buy one.",
    });
  }
  if (events[0].requireAma && !amaNumber) {
    return res.status(400).json({ error: "AMA # is required for this event" });
  }
  if (events[0].requireClubId && !clubIdNumber) {
    return res.status(400).json({ error: "Club ID # is required for this event" });
  }
  if (events[0].requireWaiver && !waiverAcknowledgedAt) {
    return res.status(400).json({ error: "You must accept the club waiver to complete registration" });
  }

  const liabilityWaiverSignatureId = req.body.liabilityWaiverSignatureId ? Number(req.body.liabilityWaiverSignatureId) : null;
  if (events[0].requireLiabilityWaiver) {
    if (!liabilityWaiverSignatureId) {
      return res.status(400).json({ error: "You must sign the liability waiver to complete registration" });
    }
    const [sig] = await db.select({
      id: liabilityWaiverSignaturesTable.id,
      eventId: liabilityWaiverSignaturesTable.eventId,
      registrationId: liabilityWaiverSignaturesTable.registrationId,
      signerEmail: liabilityWaiverSignaturesTable.signerEmail,
    })
      .from(liabilityWaiverSignaturesTable)
      .where(eq(liabilityWaiverSignaturesTable.id, liabilityWaiverSignatureId));
    if (!sig || sig.eventId !== eventId) {
      return res.status(400).json({ error: "The waiver signature couldn't be confirmed. Sign the waiver again." });
    }
    // A signature belongs to one registration and to the person registering: it must be
    // unused and signed with the registration email (or the signed-in rider account's email).
    if (sig.registrationId != null) {
      return res.status(400).json({ error: "This liability waiver signature was already used for another registration. Please sign the waiver again." });
    }
    const signer = sig.signerEmail.trim().toLowerCase();
    const riderAccountForWaiver = await requestRiderAccount(req);
    const allowedSignerEmails = [String(email).trim().toLowerCase(), riderAccountForWaiver?.email.trim().toLowerCase()].filter(Boolean);
    if (!allowedSignerEmails.includes(signer)) {
      return res.status(400).json({ error: "The liability waiver was signed with a different email address. Please sign it with the email you are registering with." });
    }
  }

  // Fetch waiver text server-side so the snapshot can't be spoofed by the client
  let serverWaiverSnapshot: string | null = null;
  if (events[0].requireWaiver && waiverAcknowledgedAt) {
    const [settings] = await db.select({ riderAcknowledgement: clubSettingsTable.riderAcknowledgement, waiverPdfUrl: clubSettingsTable.waiverPdfUrl })
      .from(clubSettingsTable)
      .where(eq(clubSettingsTable.clubId, events[0].clubId));
    serverWaiverSnapshot = settings?.riderAcknowledgement ?? (settings?.waiverPdfUrl ? `[PDF waiver] ${settings.waiverPdfUrl}` : null);
    if (!serverWaiverSnapshot) {
      return res.status(400).json({ error: "No waiver configured for this event's club" });
    }
  }
  // The date check backs up the status sweep: never take a rider registration
  // on or after the event date, even if the status hasn't been advanced yet.
  if (events[0].status !== "registration_open" || eventDateReached(events[0])) {
    return res.status(409).json({ error: "Registration for this event isn't open. Check the event page for registration dates." });
  }
  const now = new Date();
  if (events[0].registrationOpen && now < new Date(events[0].registrationOpen)) {
    return res.status(409).json({ error: "Registration for this event hasn't opened yet. Check the event page for when it opens." });
  }
  if (events[0].registrationClose && now > new Date(events[0].registrationClose)) {
    return res.status(409).json({ error: "Registration for this event has closed. Contact the event organizer if you still want to race." });
  }
  // Validate each selected class against the event's class list
  if (events[0].raceClasses) {
    for (const cls of raceClassList) {
      if (!events[0].raceClasses.includes(cls)) {
        return res.status(400).json({ error: `${cls} isn't a class at this event. Choose a class from the list.` });
      }
    }
  }

  // Resolve identity before duplicate-bib checks. A selected profile is authoritative
  // as long as its email matches; typed names are profile edits, not identity checks.
  const riderResolution = await resolveRegistrationRider(
    String(email),
    hintedRiderId,
  );
  if ("error" in riderResolution) {
    return res.status(riderResolution.status).json({ error: riderResolution.error });
  }
  const resolvedExistingRider = riderResolution.rider;

  // One entry per rider per class. An earlier checkout the rider never finished
  // is cleared so they can register again, unless Stripe says it was paid.
  if (resolvedExistingRider) {
    const earlier = await db.select().from(registrationsTable).where(and(
      eq(registrationsTable.eventId, eventId),
      eq(registrationsTable.riderId, resolvedExistingRider.id),
      inArray(registrationsTable.raceClass, raceClassList),
      ne(registrationsTable.status, "void"),
    ));
    for (const prior of earlier) {
      if (prior.paymentStatus !== "paid" && prior.status === "pending" && prior.stripeSessionId) {
        const stripe = await getUncachableStripeClient().catch(() => null);
        const session = stripe ? await stripe.checkout.sessions.retrieve(prior.stripeSessionId).catch(() => null) : null;
        if (session?.payment_status === "paid") await confirmRegistrationSession(session);
        else if (session?.status === "open") await stripe!.checkout.sessions.expire(prior.stripeSessionId).catch(() => {});
      }
    }
    const current = earlier.length
      ? await db.select().from(registrationsTable).where(inArray(registrationsTable.id, earlier.map(r => r.id)))
      : [];
    const settled = current.filter(r => r.status !== "void" && (r.paymentStatus === "paid" || r.status === "confirmed"));
    if (settled.length) {
      return res.status(409).json({ error: `Already registered for ${[...new Set(settled.map(r => r.raceClass))].join(", ")} at this event.` });
    }
    const abandoned = current.filter(r => r.status === "pending" && r.paymentStatus !== "paid");
    if (abandoned.length) {
      await db.update(registrationsTable).set({ status: "void" }).where(inArray(registrationsTable.id, abandoned.map(r => r.id)));
      // The abandoned checkout no longer uses its discount code.
      for (const code of new Set(abandoned.map(r => r.compCode).filter((c): c is string => !!c))) {
        await releaseCompCodeIfCheckoutInactive(eventId, resolvedExistingRider.id, code);
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
        .where(and(eq(registrationsTable.eventId, eventId), eq(registrationsTable.raceClass, cls), ne(registrationsTable.status, "void")));
      if ((classCount[0]?.count ?? 0) >= classLimit) {
        return res.status(409).json({ error: `${cls} is full (${classLimit} riders). Choose another class, or contact the event organizer.` });
      }
    }
  }

  // Enforce unique bib numbers if the event requires it
  // Exclude the registering rider — same rider registering for multiple classes can keep the same bib
  if (events[0].noDuplicateBibs && bibNumber) {
    const riderIdForBibCheck = resolvedExistingRider?.id ?? null;

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
  let validatedCompCodeId: number | null = null;
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
      return res.status(400).json({ error: "That discount code isn't valid or has already been used. Check the code and try again." });
    }
    if (codeRow.isActive === false) {
      return res.status(400).json({ error: "This discount code is no longer active" });
    }
    if (codeRow.expiresAt && new Date() > codeRow.expiresAt) {
      return res.status(400).json({ error: "This discount code has expired" });
    }
    if (codeRow.usesCount >= codeRow.maxUses) {
      return res.status(400).json({ error: "That discount code isn't valid or has already been used. Check the code and try again." });
    }
    // Category restriction: codes only discount entry fees, so a code limited to
    // categories applies only when this event's entry-fee category is one of them.
    // The category comes from the event, never from the request.
    const codeCatIds = ((codeRow.categoryIds as number[]) ?? []).map(Number);
    if (codeCatIds.length > 0) {
      const entryCat = events[0].entryFeeCategoryId;
      if (entryCat == null || !codeCatIds.includes(Number(entryCat))) {
        return res.status(400).json({ error: "This discount code is not valid for this event's entry fee" });
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
        return res.status(400).json({ error: "That comp code isn't valid. Check the spelling and try again." });
      }

      const normalize = (s: string) => s.trim().toLowerCase();
      const firstMatch = normalize(firstName) === normalize(assignedRider.firstName);
      const lastMatch = normalize(lastName) === normalize(assignedRider.lastName);
      const emailMatch = normalize(email) === normalize(assignedRider.email ?? "");

      if (!firstMatch || !lastMatch || !emailMatch) {
        return res.status(400).json({ error: "This discount code is reserved for a specific rider. Check that your name and email match the code's rider." });
      }
    }
    compDiscountType = (codeRow.discountType as "fixed" | "percentage") ?? "fixed";
    compDiscountRaw = Number(codeRow.amount);
    validatedCompCode = codeRow.code;
    validatedCompCodeId = codeRow.id;
  }

  // Claim one use of the code atomically, so two riders can't both take the last use.
  if (validatedCompCodeId != null) {
    const [claimed] = await db.update(compCodesTable)
      .set({ usesCount: sql`${compCodesTable.usesCount} + 1` })
      .where(and(eq(compCodesTable.id, validatedCompCodeId), lt(compCodesTable.usesCount, compCodesTable.maxUses)))
      .returning({ id: compCodesTable.id });
    if (!claimed) {
      return res.status(400).json({ error: "That discount code isn't valid or has already been used. Check the code and try again." });
    }
  }
  const releaseCompCodeUse = async () => {
    if (validatedCompCodeId == null) return;
    await db.update(compCodesTable)
      .set({ usesCount: sql`GREATEST(${compCodesTable.usesCount} - 1, 0)` })
      .where(eq(compCodesTable.id, validatedCompCodeId));
  };

  // A caller signed in as the profile's owner or manager may edit the saved profile
  // with what they submit (blank fields keep saved values). Anyone else, anonymous
  // or a different account, only fills fields the profile doesn't have yet.
  let rider: RiderRow;
  const profileFields = submittedRiderProfile(req.body, normalizedTransponderNumber);
  if (resolvedExistingRider) {
    const callerAccount = await requestRiderAccount(req);
    const callerManages = callerAccount ? await canManageRider(callerAccount, resolvedExistingRider) : false;
    const fieldsToSave = callerManages
      ? profileFields
      : fillOnlyEmptyProfileFields(resolvedExistingRider, profileFields);
    if (Object.keys(fieldsToSave).length > 0) {
      const [updated] = await db.update(ridersTable)
        .set(fieldsToSave)
        .where(eq(ridersTable.id, resolvedExistingRider.id))
        .returning();
      rider = updated;
    } else {
      rider = resolvedExistingRider;
    }
  } else {
    const [created] = await db.insert(ridersTable).values({
      ...profileFields,
      firstName: firstName.trim(),
      lastName: lastName.trim(),
      email: email.trim(),
    }).returning();
    rider = created;
  }

  // Determine if payment is required (accounting for comp discount and purchase options)
  // A rental is recorded even when the event charges nothing for it.
  const wantsRental = !!(rentTransponder && events[0].transponderRentalEnabled);
  const wantsRfidSticker = !!(purchaseRfidSticker && events[0].rfidStickerFee);
  const todayStrReg = eventToday(events[0]);
  const earlyBirdActiveReg = !!(events[0].earlyBirdEndsAt && todayStrReg <= events[0].earlyBirdEndsAt && events[0].earlyBirdFee);
  const entryFeeNum = earlyBirdActiveReg
    ? Number(events[0].earlyBirdFee)
    : (events[0].entryFee ? Number(events[0].entryFee) : 0);
  const numClasses = raceClassList.length;
  const totalEntryFees = entryFeeNum * numClasses;
  const rentalFeeNum = wantsRental && events[0].transponderRentalFee ? Number(events[0].transponderRentalFee) : 0;
  const rfidStickerFeeNum = wantsRfidSticker && events[0].rfidStickerFee ? Number(events[0].rfidStickerFee) : 0;
  // Prices come from the event's configured options, never from the request body.
  const purchaseOptsList = resolvePurchaseOptions(selectedPurchaseOptions, events[0].purchaseOptions);
  const purchaseOptionsTotal = purchaseOptsList.reduce((sum, o) => sum + Number(o.amount), 0);
  // All money below is in whole cents so the Stripe total, each entry's stored
  // amount due and the stored discount always add up to the same figure.
  const entryCents = Math.round(entryFeeNum * 100);
  const totalEntryCents = entryCents * numClasses;
  let discountCents = 0;
  if (validatedCompCode) {
    // Codes discount entry fees only (all classes); add-ons (rentals, stickers,
    // RM TrackR, purchase options) are always paid, so a large code can't zero them.
    // Percentages are rounded to the cent once, on the total.
    discountCents = Math.min(
      totalEntryCents,
      compDiscountType === "percentage"
        ? Math.round(totalEntryCents * compDiscountRaw / 100)
        : Math.round(compDiscountRaw * 100),
    );
  }
  compDiscount = discountCents / 100;
  // Each entry carries its own share of the discount (the leftover cents on the
  // first entry), so per-entry charges and the usage report sum to the real total.
  const discountShareCents = raceClassList.map((_, idx) =>
    Math.floor(discountCents / numClasses) + (idx === 0 ? discountCents % numClasses : 0));
  const classChargeCents = discountShareCents.map(share => entryCents - share);
  const addOnCents = Math.round(rentalFeeNum * 100) + Math.round(rfidStickerFeeNum * 100)
    + purchaseOptsList.reduce((sum, o) => sum + (Number(o.amount) > 0 ? Math.round(Number(o.amount) * 100) : 0), 0);
  const netCents = classChargeCents.reduce((a, b) => a + b, 0) + addOnCents;
  const netFee = netCents / 100;
  const needsPayment = !!events[0].paymentEnabled && netCents > 0;
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
    rmTrackrPurchased: includesRmTrackr(purchaseOptsList),
    myLapsTransponderNumber: normalizedTransponderNumber,
    compCode: validatedCompCode,
    waiverAcknowledgedAt: waiverAcknowledgedAt ? new Date(waiverAcknowledgedAt) : null,
    waiverSnapshot: serverWaiverSnapshot,
  };
  const insertedRegs = await db.insert(registrationsTable).values(
    raceClassList.map((cls, idx) => ({
      ...sharedRegFields,
      raceClass: cls,
      // This entry's share of the code's discount (not the whole discount).
      compDiscount: discountShareCents[idx] > 0 ? (discountShareCents[idx] / 100).toFixed(2) : null,
      // Purchase options and transponder rental attach to the first reg only
      selectedPurchaseOptions: idx === 0 ? purchaseOptsList : [],
    }))
  ).returning();

  // Two submissions at once (a double tap, two tabs, two riders after the last
  // spot): both pass the checks above. After saving, the earlier entry wins.
  const lostRace: string[] = [];
  for (const reg of insertedRegs) {
    const [{ earlierDuplicate, aheadInClass }] = await db.select({
      earlierDuplicate: sql<number>`count(*) filter (where ${registrationsTable.riderId} = ${reg.riderId} and ${registrationsTable.id} < ${reg.id})::int`,
      aheadInClass: sql<number>`count(*) filter (where ${registrationsTable.id} < ${reg.id})::int`,
    }).from(registrationsTable).where(and(
      eq(registrationsTable.eventId, eventId),
      eq(registrationsTable.raceClass, reg.raceClass),
      ne(registrationsTable.status, "void"),
    ));
    const classLimit = limits[reg.raceClass];
    if (earlierDuplicate > 0) lostRace.push(`Already registered for ${reg.raceClass} at this event.`);
    else if (classLimit != null && classLimit > 0 && aheadInClass >= classLimit) lostRace.push(`${reg.raceClass} is full (${classLimit} rider limit reached)`);
  }
  if (lostRace.length) {
    await db.delete(registrationsTable).where(inArray(registrationsTable.id, insertedRegs.map(r => r.id)));
    await releaseCompCodeUse();
    return res.status(409).json({ error: lostRace[0] });
  }

  // Link liability waiver signature to the registration
  if (events[0].requireLiabilityWaiver && liabilityWaiverSignatureId && insertedRegs[0]?.id) {
    await db.update(liabilityWaiverSignaturesTable)
      .set({ registrationId: insertedRegs[0].id })
      .where(and(
        eq(liabilityWaiverSignaturesTable.id, liabilityWaiverSignatureId),
        isNull(liabilityWaiverSignaturesTable.registrationId),
      ));
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
      }).onConflictDoNothing();
    }
    // Auto-link transponder if the rider entered their own (not a rental)
    if (!wantsRental && normalizedTransponderNumber) {
      await autoLinkTransponder(rider.id, eventId, normalizedTransponderNumber);
    }
  }

  // If payment required, create a single Stripe Checkout session covering all classes
  if (needsPayment) {
    try {
      const [club] = await db.select().from(clubsTable).where(eq(clubsTable.id, events[0].clubId));
      if (club?.stripeAccountId) {
        const stripe = await getUncachableStripeClient();
        const appUrl = getAppUrl();

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const lineItems: any[] = [];

        // One line item per selected class, each at its entry fee minus its share
        // of the discount (the same cents stored on the entry).
        for (const [idx, cls] of raceClassList.entries()) {
          if (classChargeCents[idx] > 0) {
            lineItems.push({
              price_data: {
                currency: "usd",
                product_data: {
                  name: validatedCompCode
                    ? `${events[0].name} — ${cls} Entry (Comp ${validatedCompCode})`
                    : `${events[0].name} — ${cls} Entry`,
                },
                unit_amount: classChargeCents[idx],
              },
              quantity: 1,
            });
          }
        }

        if (rentalFeeNum > 0) {
          lineItems.push({
            price_data: {
              currency: "usd",
              product_data: { name: "Active Transponder Rental" },
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

        // netCents > 0 is the sum of these line items, so there is always at least
        // one. Never invent a charge the entries don't record.
        const lineItemCents = lineItems.reduce((sum, li) => sum + li.price_data.unit_amount * li.quantity, 0);
        if (lineItems.length === 0 || lineItemCents !== netCents) {
          throw new Error(`Checkout total mismatch (${lineItemCents} vs ${netCents} cents)`);
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

        // Each entry's own charge: its class fee; add-ons ride on the first entry.
        for (const [idx, reg] of insertedRegs.entries()) {
          const cents = (classChargeCents[idx] ?? 0) + (idx === 0 ? addOnCents : 0);
          await db.update(registrationsTable)
            .set({ stripeSessionId: session.id, amountDue: (cents / 100).toFixed(2) })
            .where(eq(registrationsTable.id, reg.id));
        }

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
      // Payment is due but no Stripe Checkout page was created (club has no
      // connected Stripe account, or Stripe returned no URL). Never fall
      // through to a "registered" response: undo it like any payment failure.
      throw Object.assign(new Error("No checkout session"), { code: "NO_CHECKOUT" });
    } catch (err: any) {
      req.log?.error({ err: err?.message }, "[checkout] Failed to create Stripe Checkout session");
      // Roll back ALL pending registrations so the rider can try again cleanly: free the
      // waiver signature for reuse and give back the discount-code use.
      const rolledBackIds = insertedRegs.map(r => r.id);
      await db.update(liabilityWaiverSignaturesTable)
        .set({ registrationId: null })
        .where(inArray(liabilityWaiverSignaturesTable.registrationId, rolledBackIds));
      await db.delete(registrationsTable).where(inArray(registrationsTable.id, rolledBackIds));
      await releaseCompCodeUse();
      if (err?.code === "NO_CHECKOUT") {
        return res.status(503).json({ error: "This event can't take online payments right now, so registration couldn't be completed. Please contact the event organizer." });
      }
      return res.status(500).json({
        error: riderCardError(err, "Card payments aren't working right now. Please try again in a few minutes, or contact the event organizer."),
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
  if (!eventId) return res.status(400).json({ error: "Choose an event first." });
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
  if (!rider?.email) return res.status(404).json({ error: "This rider has no email address on file. Add one on the rider's profile, then try again." });

  const [account] = await db.select({ id: riderAccountsTable.id })
    .from(riderAccountsTable).where(eq(riderAccountsTable.email, rider.email));
  if (!account) return res.status(404).json({ error: "This rider hasn't installed the RM Roost app, so they can't get notifications." });

  const tokens = await db.select({ expoPushToken: riderPushTokensTable.expoPushToken })
    .from(riderPushTokensTable).where(eq(riderPushTokensTable.riderAccountId, account.id));
  if (tokens.length === 0) return res.status(404).json({ error: "This rider hasn't turned on notifications in the RM Roost app." });

  await sendPushNotifications(tokens.map(t => ({
    to: t.expoPushToken,
    title: "Transponder Reminder",
    body: "Please remember to turn in your rented active transponder.",
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
    body: "Please remember to turn in your rented active transponder.",
  })));

  return res.json({ sent: tokens.length });
});

// ── Assign transponder number to a rental registration (event-scoped, auto-expires 24h after event) ─
router.post("/events/:eventId/registrations/:regId/assign-rental-transponder", async (req, res) => {
  const eventId = Number(req.params.eventId);
  const regId = Number(req.params.regId);
  if (!eventId || !regId) return res.status(400).json({ error: "This link looks broken. Go back and open it again from the list." });
  const staffCId = getStaffClubId(res);
  if (!await checkEventOwnership(eventId, staffCId, res)) return;

  const { transponderNumber } = req.body;
  const tag = normalizeActiveTransponderIdentifier(transponderNumber);
  if (!tag) {
    return res.status(400).json({
      error: "Enter the ID printed on the transponder (up to 9 numbers or letters A–F).",
    });
  }

  const [reg] = await db.select({
    id: registrationsTable.id,
    riderId: registrationsTable.riderId,
    transponderRental: registrationsTable.transponderRental,
  }).from(registrationsTable)
    .where(and(eq(registrationsTable.id, regId), eq(registrationsTable.eventId, eventId)));
  if (!reg) return res.status(404).json({ error: "This registration couldn't be found. It may have been cancelled. Refresh the page and try again." });
  if (!reg.transponderRental) return res.status(400).json({ error: "This registration doesn't have a rental transponder." });

  const [event] = await db.select({ date: eventsTable.date, endDate: eventsTable.endDate, clubId: eventsTable.clubId })
    .from(eventsTable).where(eq(eventsTable.id, eventId));
  if (!event) return res.status(404).json({ error: "This event couldn't be found. It may have been deleted. Go back to Events and open it again." });

  // The unit is the rider's only for this event: the link expires the morning
  // after the last race day and is then removed automatically (lib/rentalTransponders.ts).
  const expiresAt = rentalExpiry(event);

  // Guard: transponder must not be assigned to a different rider in this event
  const conflict = await db.select({ riderId: rfidAssignmentsTable.riderId })
    .from(rfidAssignmentsTable)
    .where(and(
      sql`lower(trim(${rfidAssignmentsTable.rfidNumber})) = ${tag}`,
      eq(rfidAssignmentsTable.eventId, eventId),
    ));
  if (conflict.length > 0 && conflict[0].riderId !== reg.riderId) {
    return res.status(409).json({ error: `Transponder ${tag} is already assigned to another rider for this event` });
  }

  // A unit still out from an earlier event (not marked returned) can't go to a new rider.
  const stillOut = (await rentalsOut(event.clubId)).get(tag);
  if (stillOut && stillOut.eventId !== eventId) {
    return res.status(409).json({
      error: `Rental ${tag} is still out from ${stillOut.eventName} (${stillOut.eventDate}). Mark it returned on that event's Transponder Rentals tab first.`,
    });
  }
  // Keep the club's rental inventory complete, and a unit handed out isn't missing.
  await db.insert(rentalTranspondersTable).values({ clubId: event.clubId, transponderNumber: tag })
    .onConflictDoUpdate({ target: [rentalTranspondersTable.clubId, rentalTranspondersTable.transponderNumber], set: { missing: false } });

  // Upsert the rental link: the rider's assignment row with an expiry (rental =
  // temporary, does NOT update riders.rfidNumber). It's kept apart from an RFID
  // sticker row (no expiry), since one event can use both kinds of reader.
  const existing = await db.select({ id: rfidAssignmentsTable.id })
    .from(rfidAssignmentsTable)
    .where(and(eq(rfidAssignmentsTable.riderId, reg.riderId), eq(rfidAssignmentsTable.eventId, eventId), isNotNull(rfidAssignmentsTable.expiresAt)))
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

  // A rental is not the rider's purchase: never mark a bought RM TrackR fulfilled with it.

  return res.json({ success: true, transponderNumber: tag, expiresAt: expiresAt.toISOString() });
});

// ── Mark transponder returned ───────────────────────────────────────────────────
router.patch("/events/:eventId/registrations/:regId/transponder-returned", async (req, res) => {
  const eventId = Number(req.params.eventId);
  const regId = Number(req.params.regId);
  if (!eventId || !regId) return res.status(400).json({ error: "This link looks broken. Go back and open it again from the list." });
  const staffCId = getStaffClubId(res);
  if (!await checkEventOwnership(eventId, staffCId, res)) return;

  const { returned } = req.body; // boolean
  if (typeof returned !== "boolean") return res.status(400).json({ error: "Something was missing from that request. Refresh the page and try again." });

  const [reg] = await db.update(registrationsTable)
    .set({ transponderReturned: returned })
    .where(and(eq(registrationsTable.id, regId), eq(registrationsTable.eventId, eventId)))
    .returning({ id: registrationsTable.id, transponderReturned: registrationsTable.transponderReturned, riderId: registrationsTable.riderId });

  if (!reg) return res.status(404).json({ error: "This registration couldn't be found. It may have been cancelled. Refresh the page and try again." });
  // Returned: the unit is no longer this rider's, so its timing link goes now.
  if (returned && reg.riderId != null) await releaseRentalLink(eventId, reg.riderId);
  return res.json({ registrationId: reg.id, transponderReturned: reg.transponderReturned });
});

// ── Organizer: list rider-initiated cancellations for an event ────────────────
router.get("/events/:eventId/cancellations", async (req, res) => {
  const session = req.session as any;
  if (!session?.userId) return res.status(401).json({ error: "You're signed out. Sign in again, then try once more." });
  const staffCId = getStaffClubId(res);
  const eventId = Number(req.params.eventId);
  if (!eventId || !(await checkEventOwnership(eventId, staffCId, res))) return;

  const rows = await db
    .select({
      id: registrationsTable.id,
      eventId: registrationsTable.eventId,
      riderId: registrationsTable.riderId,
      raceClass: registrationsTable.raceClass,
      bibNumber: registrationsTable.bibNumber,
      amountPaid: registrationsTable.amountPaid,
      paymentMethod: registrationsTable.paymentMethod,
      paymentStatus: registrationsTable.paymentStatus,
      cancelledAt: registrationsTable.cancelledAt,
      refundVerifiedAt: registrationsTable.refundVerifiedAt,
      riderFirstName: ridersTable.firstName,
      riderLastName: ridersTable.lastName,
    })
    .from(registrationsTable)
    .leftJoin(ridersTable, eq(registrationsTable.riderId, ridersTable.id))
    .where(and(
      eq(registrationsTable.eventId, eventId),
      eq(registrationsTable.cancellationSource, "rider"),
    ))
    .orderBy(desc(registrationsTable.cancelledAt));

  const cancellations = rows.map(r => ({
    id: r.id,
    eventId: r.eventId,
    riderId: r.riderId,
    riderName: `${r.riderFirstName ?? ""} ${r.riderLastName ?? ""}`.trim(),
    raceClass: r.raceClass,
    bibNumber: r.bibNumber ?? null,
    amountPaid: r.amountPaid != null ? Number(r.amountPaid) : null,
    paymentMethod: r.paymentMethod ?? null,
    paymentStatus: r.paymentStatus ?? null,
    cancelledAt: r.cancelledAt?.toISOString() ?? "",
    refundVerifiedAt: r.refundVerifiedAt?.toISOString() ?? null,
  }));

  const unverifiedCount = cancellations.filter(c => c.refundVerifiedAt == null).length;

  return res.json({ cancellations, unverifiedCount });
});

// ── Organizer: mark refund as verified ────────────────────────────────────────
router.patch("/events/:eventId/cancellations/:registrationId/verify", async (req, res) => {
  const session = req.session as any;
  if (!session?.userId) return res.status(401).json({ error: "You're signed out. Sign in again, then try once more." });
  const staffCId = getStaffClubId(res);
  const eventId = Number(req.params.eventId);
  const registrationId = Number(req.params.registrationId);
  if (!eventId || !(await checkEventOwnership(eventId, staffCId, res))) return;

  const [reg] = await db
    .select({ id: registrationsTable.id, cancellationSource: registrationsTable.cancellationSource })
    .from(registrationsTable)
    .where(and(
      eq(registrationsTable.id, registrationId),
      eq(registrationsTable.eventId, eventId),
    ));

  if (!reg) return res.status(404).json({ error: "This registration couldn't be found. It may have been cancelled. Refresh the page and try again." });
  if (reg.cancellationSource !== "rider") return res.status(400).json({ error: "Only cancellations a rider started can be refunded here. Refund it from the registration instead." });

  const now = new Date();
  const [updated] = await db
    .update(registrationsTable)
    .set({ refundVerifiedAt: now })
    .where(eq(registrationsTable.id, registrationId))
    .returning();

  const [rider] = await db
    .select({ firstName: ridersTable.firstName, lastName: ridersTable.lastName })
    .from(ridersTable)
    .where(eq(ridersTable.id, updated.riderId));

  return res.json({
    id: updated.id,
    eventId: updated.eventId,
    riderId: updated.riderId,
    riderName: `${rider?.firstName ?? ""} ${rider?.lastName ?? ""}`.trim(),
    raceClass: updated.raceClass,
    bibNumber: updated.bibNumber ?? null,
    amountPaid: updated.amountPaid != null ? Number(updated.amountPaid) : null,
    paymentMethod: updated.paymentMethod ?? null,
    paymentStatus: updated.paymentStatus ?? null,
    cancelledAt: updated.cancelledAt?.toISOString() ?? "",
    refundVerifiedAt: updated.refundVerifiedAt?.toISOString() ?? null,
  });
});

// ── Public: verify Stripe payment and confirm registration(s) ─────────────────
/**
 * Records a paid Stripe Checkout session against the entries it covers: paid,
 * confirmed, the amount each entry was charged, a check-in row, and the
 * rider's own transponder. Safe to run more than once (the rider's browser,
 * Stripe's webhook and the background check can all deliver the same
 * session). Cancelled entries are never re-confirmed. Returns the entries
 * that are now paid.
 */
export async function confirmRegistrationSession(
  session: { id: string; payment_status: string | null; amount_total: number | null; metadata?: Record<string, string> | null },
) {
  if (session.payment_status !== "paid") return [];
  const sessionType = session.metadata?.type;
  if (sessionType && sessionType !== "registration") return [];
  const regIdsStr = session.metadata?.registrationIds || session.metadata?.registrationId;
  const regIds = (regIdsStr ?? "").split(",").map(Number).filter(Boolean);
  if (regIds.length === 0) return [];

  const regs = await db.select().from(registrationsTable).where(inArray(registrationsTable.id, regIds));
  // Each entry's own charge when it was stored at checkout; otherwise split the
  // total, with any leftover cent on the last entry so the parts add up.
  const totalCents = session.amount_total ?? 0;
  const evenCents = regIds.length ? Math.floor(totalCents / regIds.length) : 0;
  const amountFor = (regId: number) => {
    const reg = regs.find(r => r.id === regId);
    if (reg?.amountDue != null && reg.stripeSessionId === session.id) return String(reg.amountDue);
    const cents = regId === regIds[regIds.length - 1] ? totalCents - evenCents * (regIds.length - 1) : evenCents;
    return (cents / 100).toFixed(2);
  };

  const updatedRegs: Array<typeof registrationsTable.$inferSelect> = [];
  for (const regId of regIds) {
    // Only entries still waiting for payment are confirmed. Voided (cancelled) and
    // refunded entries are never flipped back to paid by a later payment check.
    const [row] = await db.update(registrationsTable)
      .set({
        paymentStatus: "paid",
        status: "confirmed",
        paymentMethod: "card",
        stripeSessionId: session.id,
        // Keep an amount the organizer corrected; only fill it in the first time.
        amountPaid: sql`coalesce(${registrationsTable.amountPaid}, ${amountFor(regId)})`,
      })
      .where(and(
        eq(registrationsTable.id, regId),
        ne(registrationsTable.status, "void"),
        eq(registrationsTable.paymentStatus, "unpaid"),
      ))
      .returning();
    if (row) {
      updatedRegs.push(row);
      continue;
    }
    // Already recorded by another delivery (webhook, redirect or background check):
    // report it as paid without writing it again.
    const [already] = await db.select().from(registrationsTable).where(and(
      eq(registrationsTable.id, regId),
      ne(registrationsTable.status, "void"),
      eq(registrationsTable.paymentStatus, "paid"),
      eq(registrationsTable.stripeSessionId, session.id),
    ));
    if (already) updatedRegs.push(already);
  }
  if (!updatedRegs.length) return updatedRegs;

  // One check-in record per rider per event (and class). The webhook and the
  // rider's redirect can confirm at the same moment, so the unique index
  // (migration 0012) settles the race instead of a read-then-insert.
  const primaryReg = updatedRegs[0];
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
    }).onConflictDoNothing();
  }
  // Auto-link transponder if the rider entered their own number (not a rental)
  if (!primaryReg.transponderRental && primaryReg.myLapsTransponderNumber?.trim()) {
    await autoLinkTransponder(primaryReg.riderId, primaryReg.eventId, primaryReg.myLapsTransponderNumber).catch(() => {});
  }
  return updatedRegs;
}

router.post("/public/registrations/:id/verify-payment", async (req, res) => {
  const id = Number(req.params.id);
  const { sessionId } = req.body;
  if (!sessionId) return res.status(400).json({ error: "This payment link is incomplete. Start the payment again." });

  try {
    const stripe = await getUncachableStripeClient();
    const session = await stripe.checkout.sessions.retrieve(sessionId);

    // Support both multi-class (registrationIds comma-sep) and single-class (registrationId)
    const regIdsStr = session.metadata?.registrationIds || session.metadata?.registrationId;
    if (!regIdsStr) {
      return res.status(403).json({ error: "This payment link doesn't match this registration. Start the payment again from the registration." });
    }
    // Add-on sessions (transponder_rental, rfid_sticker, ...) also carry a registrationId;
    // they must never confirm the registration itself.
    const sessionType = session.metadata?.type;
    if (sessionType && sessionType !== "registration") {
      return res.status(403).json({ error: "This payment link doesn't match this registration. Start the payment again from the registration." });
    }
    const regIds = regIdsStr.split(",").map(Number).filter(Boolean);
    if (!regIds.includes(id)) {
      return res.status(403).json({ error: "This payment link doesn't match this registration. Start the payment again from the registration." });
    }

    if (session.payment_status !== "paid") {
      return res.status(402).json({ error: "The payment hasn't finished yet. Finish paying in the Stripe window, then try again.", paymentStatus: session.payment_status });
    }

    const amountPaidTotal = session.amount_total != null ? session.amount_total / 100 : null;
    const updatedRegs = await confirmRegistrationSession(session);
    if (!updatedRegs.length) {
      return res.status(409).json({ error: "This registration was cancelled or no longer exists. Contact the event organizer about your payment." });
    }
    const primaryReg = updatedRegs.find(r => r.id === id) ?? updatedRegs[0];

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
    return sendPaymentCheckError(res, err);
  }
});

export default router;
