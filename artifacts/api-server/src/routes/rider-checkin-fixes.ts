import { Router } from "express";
import { createHash } from "crypto";
import { db } from "@workspace/db";
import {
  registrationsTable,
  ridersTable,
  eventsTable,
  clubsTable,
  clubSettingsTable,
  riderAccountsTable,
  rfidAssignmentsTable,
  liabilityWaiverSignaturesTable,
} from "@workspace/db";
import { and, eq, ilike, isNotNull, ne, or } from "drizzle-orm";
import { eventTimeZone, normalizeActiveTransponderIdentifier, todayInZone } from "@workspace/api-zod";
import { requireRiderAuth } from "./rider-portal";
import { canManageRider } from "../lib/riderAccess";
import { resolvePurchaseOptions } from "../lib/purchaseOptions";
import { getUncachableStripeClient } from "../stripeClient";
import { confirmRegistrationSession } from "./registrations";
import { riderCardError } from "../lib/stripeErrors";
import type Stripe from "stripe";
import { browserAccount, clubStripeOf, onClub, onClubOrPlatform, paymentIntentAsPaid, RIDER_APP_PAYMENT, transferTo } from "../lib/stripePayments";
import { acknowledgementSnapshot, liabilityWaiverSnapshot, waiverPdfOf } from "../lib/waiverSettings";
import { sendLiabilityWaiverConfirmation } from "../lib/email";

// Lets a rider fix what keeps them from Quick Check-In without staff:
// pay an unfinished registration, sign the waiver, or add the transponder or
// RFID sticker number they already have. Each route only touches the signed-in
// account's own (or managed) rider's registrations.

const router = Router();

function getAppUrl(): string {
  if (process.env.APP_URL) return process.env.APP_URL;
  const domains = process.env.REPLIT_DOMAINS;
  if (domains) return `https://${domains.split(",")[0]}`;
  return "http://localhost:80";
}

/** The registration, its event and rider, if the signed-in account may manage it. Sends the error otherwise. */
async function loadOwnedRegistration(req: any, res: any) {
  const regId = Number(req.params.regId);
  if (!Number.isInteger(regId)) { res.status(400).json({ error: "This link looks broken. Go back and open it again from the list." }); return null; }
  const [account] = await db.select().from(riderAccountsTable).where(eq(riderAccountsTable.id, req.session.riderAccountId));
  if (!account) { res.status(401).json({ error: "You're signed out. Sign in again, then try once more." }); return null; }
  const [reg] = await db.select().from(registrationsTable).where(eq(registrationsTable.id, regId));
  if (!reg || reg.status === "void") { res.status(404).json({ error: "This registration couldn't be found. It may have been cancelled. Refresh the page and try again." }); return null; }
  const [rider] = await db.select().from(ridersTable).where(eq(ridersTable.id, reg.riderId));
  if (!rider || !(await canManageRider(account, rider))) { res.status(403).json({ error: "This registration isn't on your account. Sign in with the account that registered." }); return null; }
  const [event] = await db.select().from(eventsTable).where(eq(eventsTable.id, reg.eventId));
  if (!event) { res.status(404).json({ error: "This event couldn't be found. It may have been deleted. Go back to Events and open it again." }); return null; }
  return { account, reg, rider, event };
}

/** All of this rider's live registrations for the event (one per class). */
function riderRegsForEvent(riderId: number, eventId: number) {
  return db.select().from(registrationsTable).where(and(
    eq(registrationsTable.riderId, riderId),
    eq(registrationsTable.eventId, eventId),
    ne(registrationsTable.status, "void"),
  ));
}

// ── Pay an unfinished online registration ────────────────────────────────────
// Charges what the rider was quoted when they registered: entry fee per class
// (early-bird if they registered in time), rental, RFID sticker and purchase
// options, minus their code. Confirmation runs through the existing
// verify-payment flow on the website, like a normal registration.
router.post("/rider/registrations/:regId/checkout", requireRiderAuth, async (req, res) => {
  const owned = await loadOwnedRegistration(req, res);
  if (!owned) return;
  const { rider, event } = owned;

  if (event.status === "completed" || event.status === "results_published") {
    return res.status(409).json({ error: "This event is over. Contact the organizer about payment." });
  }
  const pending = (await riderRegsForEvent(rider.id, event.id)).filter(r => r.status === "pending" && r.paymentStatus !== "paid");
  if (pending.length === 0) return res.status(409).json({ error: "This registration is already paid." });

  const [club] = await db.select().from(clubsTable).where(eq(clubsTable.id, event.clubId));
  if (!event.paymentEnabled || !club?.stripeAccountId) {
    return res.status(409).json({ error: "This event can't take payments in the app right now. Pay at the gate." });
  }

  const first = pending.reduce((a, b) => (a.createdAt <= b.createdAt ? a : b));
  const registeredOn = todayInZone(eventTimeZone(event), first.createdAt);
  const earlyBird = !!(event.earlyBirdEndsAt && event.earlyBirdFee && registeredOn <= event.earlyBirdEndsAt);
  const entryFee = Number(earlyBird ? event.earlyBirdFee : event.entryFee) || 0;
  const totalEntry = entryFee * pending.length;
  // Each entry stores its own share of the code's discount: add them up.
  const discount = Math.min(pending.reduce((sum, r) => sum + (Number(r.compDiscount ?? 0) || 0), 0), totalEntry);

  const lineItems: Array<{ name: string; amount: number }> = [];
  const perClass = pending.length > 0 ? (totalEntry - discount) / pending.length : 0;
  for (const r of pending) if (perClass > 0) lineItems.push({ name: `${event.name} — ${r.raceClass} Entry`, amount: perClass });
  if (pending.some(r => r.transponderRental) && event.transponderRentalEnabled && Number(event.transponderRentalFee) > 0) {
    lineItems.push({ name: "Active Transponder Rental", amount: Number(event.transponderRentalFee) });
  }
  if (pending.some(r => r.rfidStickerPurchased) && Number(event.rfidStickerFee) > 0) {
    lineItems.push({ name: "RFID Sticker", amount: Number(event.rfidStickerFee) });
  }
  for (const r of pending) {
    for (const opt of resolvePurchaseOptions(r.selectedPurchaseOptions, event.purchaseOptions)) {
      if (Number(opt.amount) > 0) lineItems.push({ name: opt.name, amount: Number(opt.amount) });
    }
  }
  if (lineItems.length === 0) return res.status(409).json({ error: "Nothing is due on this registration. See the organizer at the gate." });

  try {
    const stripe = await getUncachableStripeClient();
    const appUrl = getAppUrl();
    const cs = clubStripeOf(club)!;

    // The rider app pays in its own Stripe payment sheet (a PaymentIntent),
    // never on a web page. Confirmed by verify-payment, webhooks and the sweeper.
    if (req.body?.paymentSheet === true) {
      const { getStripePublishableKey } = await import("../stripeClient");
      const publishableKey = await getStripePublishableKey().catch(() => "");
      if (!publishableKey) return res.status(503).json({ error: "Card payments aren't available in the app right now. Pay at the gate." });
      const totalCents = lineItems.reduce((sum, li) => sum + Math.round(li.amount * 100), 0);
      const sheet = (pi: Stripe.PaymentIntent) => res.json({
        paymentSheet: { clientSecret: pi.client_secret, publishableKey, stripeAccount: browserAccount(cs) },
        sessionId: pi.id, registrationId: first.id, total: totalCents / 100,
      });
      for (const id of new Set(pending.map(r => r.stripeSessionId).filter((v): v is string => !!v))) {
        if (id.startsWith("pi_")) {
          // An unfinished sheet from registration or an earlier tap: reuse it if the amount still matches.
          const pi = await onClubOrPlatform(cs, o => stripe.paymentIntents.retrieve(id, undefined, o)).catch(() => null);
          if (!pi || pi.metadata?.source !== RIDER_APP_PAYMENT) continue;
          if (pi.status === "succeeded" || pi.status === "processing") {
            if (pi.status === "succeeded") await confirmRegistrationSession(paymentIntentAsPaid(pi));
            return res.status(409).json({ error: "Your payment went through. It can take a minute to show; pull down to refresh." });
          }
          if (pi.status !== "canceled" && pi.amount === totalCents) return sheet(pi);
          if (pi.status !== "canceled") await onClubOrPlatform(cs, o => stripe.paymentIntents.cancel(id, undefined, o)).catch(() => {});
        } else if (id.startsWith("cs_")) {
          // An open web checkout for the same entries must not be payable as well.
          const s = await onClubOrPlatform(cs, o => stripe.checkout.sessions.retrieve(id, undefined, o)).catch(() => null);
          if (s?.payment_status === "paid") {
            await confirmRegistrationSession(s);
            return res.status(409).json({ error: "Your payment went through. It can take a minute to show; pull down to refresh." });
          }
          if (s?.status === "open") await onClubOrPlatform(cs, o => stripe.checkout.sessions.expire(id, undefined, o)).catch(() => {});
        }
      }
      const pi = await stripe.paymentIntents.create({
        amount: totalCents,
        currency: "usd",
        payment_method_types: ["card"],
        description: `${event.name}: ${pending.map(r => r.raceClass).join(", ")}`.slice(0, 200),
        receipt_email: rider.email ?? undefined,
        ...transferTo(cs),
        metadata: { registrationId: String(first.id), registrationIds: pending.map(r => r.id).join(","), eventId: String(event.id), type: "registration", source: RIDER_APP_PAYMENT },
      }, onClub(cs));
      const classCents = perClass > 0 ? Math.round(perClass * 100) : 0;
      const addOnCents = totalCents - classCents * pending.length;
      for (const [idx, r] of pending.entries()) {
        await db.update(registrationsTable)
          .set({ stripeSessionId: pi.id, amountDue: ((classCents + (idx === 0 ? addOnCents : 0)) / 100).toFixed(2) })
          .where(eq(registrationsTable.id, r.id));
      }
      return sheet(pi);
    }

    // Never start a second charge for the same entries: reuse a checkout that's
    // still open (from registration or an earlier tap), and stop if one was paid.
    // The entries' own checkout sessions first (exact, however busy Stripe is).
    for (const sessionId of new Set(pending.map(r => r.stripeSessionId).filter((v): v is string => !!v))) {
      if (sessionId.startsWith("pi_")) {
        // An in-app payment sheet for the same entries: record it if paid, otherwise
        // cancel it so the rider can't pay twice.
        const pi = await onClubOrPlatform(cs, o => stripe.paymentIntents.retrieve(sessionId, undefined, o)).catch(() => null);
        if (pi?.status === "succeeded") {
          await confirmRegistrationSession(paymentIntentAsPaid(pi));
          return res.status(409).json({ error: "Your payment went through. It can take a minute to show; pull down to refresh." });
        }
        if (pi && pi.metadata?.source === RIDER_APP_PAYMENT && pi.status !== "canceled" && pi.status !== "processing") {
          await onClubOrPlatform(cs, o => stripe.paymentIntents.cancel(sessionId, undefined, o)).catch(() => {});
        }
        continue;
      }
      if (!sessionId.startsWith("cs_")) continue;
      const own = await onClubOrPlatform(cs, o => stripe.checkout.sessions.retrieve(sessionId, undefined, o)).catch(() => null);
      if (own?.payment_status === "paid") {
        await confirmRegistrationSession(own);
        return res.status(409).json({ error: "Your payment went through. It can take a minute to show; pull down to refresh." });
      }
      if (own?.status === "open" && own.url) {
        return res.json({ checkoutUrl: own.url, total: lineItems.reduce((sum, li) => sum + li.amount, 0) });
      }
    }
    const regIds = new Set(pending.map(r => String(r.id)));
    const covers = (s: { metadata?: Record<string, string> | null }) =>
      (s.metadata?.registrationIds ?? "").split(",").some(id => regIds.has(id.trim()));
    const recentSessions = await stripe.checkout.sessions.list({
      created: { gte: Math.floor(Date.now() / 1000) - 24 * 3600 },
      limit: 100,
    }, onClub(cs));
    const mine = recentSessions.data.filter(covers);
    if (mine.some(s => s.status === "complete" && s.payment_status === "paid")) {
      return res.status(409).json({ error: "Your payment went through. It can take a minute to show; pull down to refresh." });
    }
    const open = mine.find(s => s.status === "open" && s.url);
    if (open) return res.json({ checkoutUrl: open.url, total: lineItems.reduce((s, li) => s + li.amount, 0) });

    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      line_items: lineItems.map(li => ({
        price_data: { currency: "usd", product_data: { name: li.name }, unit_amount: Math.round(li.amount * 100) },
        quantity: 1,
      })),
      customer_email: rider.email ?? undefined,
      payment_intent_data: { ...transferTo(cs) },
      metadata: { registrationIds: pending.map(r => r.id).join(","), type: "registration" },
      success_url: `${appUrl}/register/${event.id}?reg_id=${first.id}&session_id={CHECKOUT_SESSION_ID}&payment_success=1`,
      cancel_url: `${appUrl}/register/${event.id}?payment_cancelled=1`,
    }, onClub(cs));
    // Remember the session on each entry, with its own share: class fee, and
    // add-ons on the first entry (same split as the line items above).
    const classCents = perClass > 0 ? Math.round(perClass * 100) : 0;
    const totalCents = lineItems.reduce((sum, li) => sum + Math.round(li.amount * 100), 0);
    const addOnCents = totalCents - classCents * pending.length;
    for (const [idx, r] of pending.entries()) {
      await db.update(registrationsTable)
        .set({ stripeSessionId: session.id, amountDue: ((classCents + (idx === 0 ? addOnCents : 0)) / 100).toFixed(2) })
        .where(eq(registrationsTable.id, r.id));
    }
    return res.json({ checkoutUrl: session.url, total: lineItems.reduce((s, li) => s + li.amount, 0) });
  } catch (err: any) {
    req.log?.error({ err: err?.message }, "[rider checkout] Stripe error");
    return res.status(502).json({ error: riderCardError(err, "Couldn't start the payment. Please try again, or pay at the gate.") });
  }
});

// ── Waiver ───────────────────────────────────────────────────────────────────
/**
 * The form this rider still has to sign for the event: the liability waiver first,
 * then the acknowledgement (when the event requires both, both are needed).
 */
async function waiverFor(event: typeof eventsTable.$inferSelect, riderId: number) {
  const [settings] = await db.select().from(clubSettingsTable).where(eq(clubSettingsTable.clubId, event.clubId));
  let liabilitySigned = false;
  if (event.requireLiabilityWaiver) {
    const [sig] = await db.select({ id: liabilityWaiverSignaturesTable.id })
      .from(liabilityWaiverSignaturesTable)
      .innerJoin(registrationsTable, eq(registrationsTable.id, liabilityWaiverSignaturesTable.registrationId))
      .where(and(eq(liabilityWaiverSignaturesTable.eventId, event.id), eq(registrationsTable.eventId, event.id), eq(registrationsTable.riderId, riderId)))
      .limit(1);
    liabilitySigned = !!sig;
  }
  let acknowledged = true;
  if (event.requireWaiver) {
    const [acked] = await db.select({ id: registrationsTable.id }).from(registrationsTable).where(and(
      eq(registrationsTable.eventId, event.id), eq(registrationsTable.riderId, riderId),
      ne(registrationsTable.status, "void"), isNotNull(registrationsTable.waiverAcknowledgedAt),
    )).limit(1);
    acknowledged = !!acked;
  }
  if (event.requireLiabilityWaiver && (!liabilitySigned || acknowledged)) {
    return {
      kind: "liability" as const,
      text: settings?.liabilityWaiverText ?? null,
      pdfUrl: settings?.liabilityWaiverPdfUrl ?? null,
      snapshot: liabilityWaiverSnapshot(settings),
      fields: settings?.liabilityWaiverFields ?? null,
    };
  }
  if (event.requireWaiver) {
    return {
      kind: "acknowledgement" as const,
      text: settings?.riderAcknowledgement ?? null,
      pdfUrl: settings?.waiverPdfUrl ?? null,
      snapshot: acknowledgementSnapshot(settings),
      fields: null,
    };
  }
  return null;
}

router.get("/rider/registrations/:regId/waiver", requireRiderAuth, async (req, res) => {
  const owned = await loadOwnedRegistration(req, res);
  if (!owned) return;
  const waiver = await waiverFor(owned.event, owned.rider.id);
  if (!waiver) return res.status(404).json({ error: "This event doesn't require a waiver." });
  const { snapshot: _snapshot, fields: _fields, ...shown } = waiver;
  return res.json({ ...shown, eventName: owned.event.name, riderName: `${owned.rider.firstName} ${owned.rider.lastName}`.trim() });
});

router.post("/rider/registrations/:regId/waiver", requireRiderAuth, async (req, res) => {
  const owned = await loadOwnedRegistration(req, res);
  if (!owned) return;
  const { account, reg, rider, event } = owned;
  const { signerName, consentToEsign, asGuardian } = req.body ?? {};
  if (!String(signerName ?? "").trim()) return res.status(400).json({ error: "Type your full name to sign." });
  if (!consentToEsign) return res.status(400).json({ error: "Check the box to agree to sign electronically." });

  const waiver = await waiverFor(event, rider.id);
  if (!waiver?.snapshot) return res.status(409).json({ error: "The waiver isn't available in the app. Sign it at the gate." });

  if (waiver.kind === "acknowledgement") {
    await db.update(registrationsTable)
      .set({ waiverAcknowledgedAt: new Date(), waiverSnapshot: waiver.snapshot })
      .where(and(eq(registrationsTable.riderId, rider.id), eq(registrationsTable.eventId, event.id), ne(registrationsTable.status, "void")));
    return res.json({ ok: true });
  }

  const guardian = !!asGuardian;
  const signedAt = new Date();
  const contentHash = createHash("sha256").update(waiver.snapshot, "utf8").digest("hex");
  await db.insert(liabilityWaiverSignaturesTable).values({
    clubId: event.clubId,
    eventId: event.id,
    registrationId: reg.id,
    signerName: String(signerName).trim(),
    signerEmail: account.email.toLowerCase(),
    signerIp: req.ip ?? null,
    signerUserAgent: req.get("user-agent") ?? null,
    consentToEsign: true,
    waiverContentHash: contentHash,
    waiverSnapshot: waiver.snapshot,
    // Where the name, date and signature go on the club's PDF, as when the rider signed.
    fieldLayout: waiverPdfOf(waiver.snapshot) ? (waiver.fields ?? null) : null,
    signerType: guardian ? "guardian" : "self",
    minorRiderName: guardian ? `${rider.firstName} ${rider.lastName}`.trim() : null,
    signedAt,
  });
  sendLiabilityWaiverConfirmation({
    to: account.email,
    signerName: String(signerName).trim(),
    eventName: event.name,
    signedAt: signedAt.toISOString(),
    contentHash,
    waiverSnapshot: waiver.snapshot,
  }).catch(() => {});
  // Both forms required: tell the app the acknowledgement is still to do.
  const next = await waiverFor(event, rider.id);
  return res.json({ ok: true, ...(next?.kind === "acknowledgement" ? { next: "acknowledgement" } : {}) });
});

/** True when another rider's profile already carries this transponder/sticker number. */
async function numberOnAnotherProfile(number: string, riderId: number): Promise<boolean> {
  const [hit] = await db.select({ id: ridersTable.id }).from(ridersTable).where(and(
    ne(ridersTable.id, riderId),
    or(ilike(ridersTable.mylapsTransponderId, number), ilike(ridersTable.rfidNumber, number)),
  )).limit(1);
  return !!hit;
}

// ── Active timing transponder number ─────────────────────────────────────────
router.post("/rider/registrations/:regId/transponder", requireRiderAuth, async (req, res) => {
  const owned = await loadOwnedRegistration(req, res);
  if (!owned) return;
  const { rider, event } = owned;
  const number = normalizeActiveTransponderIdentifier(String(req.body?.transponderNumber ?? ""));
  if (!number) return res.status(400).json({ error: "Enter the ID printed on your transponder (up to 9 numbers or letters A–F)." });

  const others = await db.select({ riderId: registrationsTable.riderId }).from(registrationsTable).where(and(
    eq(registrationsTable.eventId, event.id),
    eq(registrationsTable.myLapsTransponderNumber, number),
    ne(registrationsTable.status, "void"),
    ne(registrationsTable.riderId, rider.id),
  )).limit(1);
  if (others.length) return res.status(409).json({ error: "That transponder number is already used by another rider at this event. Check the number, or see the organizer." });
  // A number on another rider's profile is theirs at every event.
  if (await numberOnAnotherProfile(number, rider.id)) {
    return res.status(409).json({ error: "That transponder number belongs to another rider. Check the number, or see the organizer." });
  }
  // This screen only fills in a missing number; changing one goes through the organizer.
  const regs = await riderRegsForEvent(rider.id, event.id);
  if (regs.some(r => r.myLapsTransponderNumber && r.myLapsTransponderNumber.toUpperCase() !== number)) {
    return res.status(409).json({ error: "You already have a transponder number for this event. See the organizer to change it." });
  }

  await db.update(registrationsTable)
    .set({ myLapsTransponderNumber: number })
    .where(and(eq(registrationsTable.riderId, rider.id), eq(registrationsTable.eventId, event.id), ne(registrationsTable.status, "void")));
  await db.update(ridersTable).set({ mylapsTransponderId: number }).where(eq(ridersTable.id, rider.id));
  return res.json({ ok: true, transponderNumber: number });
});

// ── RFID sticker the rider already has ───────────────────────────────────────
router.post("/rider/registrations/:regId/rfid", requireRiderAuth, async (req, res) => {
  const owned = await loadOwnedRegistration(req, res);
  if (!owned) return;
  const { rider, event } = owned;
  const number = String(req.body?.rfidNumber ?? "").trim().toUpperCase();
  if (!/^[A-Z0-9]{1,32}$/.test(number)) return res.status(400).json({ error: "Enter the number printed on your RFID sticker (letters and numbers only)." });

  const [taken] = await db.select({ riderId: rfidAssignmentsTable.riderId }).from(rfidAssignmentsTable).where(and(
    eq(rfidAssignmentsTable.eventId, event.id),
    eq(rfidAssignmentsTable.rfidNumber, number),
  )).limit(1);
  if (taken && taken.riderId !== rider.id) {
    return res.status(409).json({ error: "That sticker number is already assigned to another rider at this event. Check the number, or see the organizer." });
  }
  if (await numberOnAnotherProfile(number, rider.id)) {
    return res.status(409).json({ error: "That sticker number belongs to another rider. Check the number, or see the organizer." });
  }

  const [existing] = await db.select({ id: rfidAssignmentsTable.id, rfidNumber: rfidAssignmentsTable.rfidNumber }).from(rfidAssignmentsTable)
    .where(and(eq(rfidAssignmentsTable.eventId, event.id), eq(rfidAssignmentsTable.riderId, rider.id))).limit(1);
  // This screen only fills in a missing sticker; changing one goes through the organizer.
  if (existing?.rfidNumber && existing.rfidNumber.toUpperCase() !== number) {
    return res.status(409).json({ error: "You already have a sticker number for this event. See the organizer to change it." });
  }
  if (existing) await db.update(rfidAssignmentsTable).set({ rfidNumber: number }).where(eq(rfidAssignmentsTable.id, existing.id));
  else await db.insert(rfidAssignmentsTable).values({ riderId: rider.id, eventId: event.id, rfidNumber: number });
  await db.update(ridersTable).set({ rfidNumber: number }).where(eq(ridersTable.id, rider.id));
  return res.json({ ok: true, rfidNumber: number });
});

export default router;
