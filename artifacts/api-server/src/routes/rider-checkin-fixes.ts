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
import { and, eq, ne } from "drizzle-orm";
import { eventTimeZone, normalizeActiveTransponderIdentifier, todayInZone } from "@workspace/api-zod";
import { requireRiderAuth } from "./rider-portal";
import { canManageRider } from "../lib/riderAccess";
import { resolvePurchaseOptions } from "../lib/purchaseOptions";
import { getUncachableStripeClient } from "../stripeClient";

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
  if (!Number.isInteger(regId)) { res.status(400).json({ error: "Invalid registration" }); return null; }
  const [account] = await db.select().from(riderAccountsTable).where(eq(riderAccountsTable.id, req.session.riderAccountId));
  if (!account) { res.status(401).json({ error: "Not authenticated" }); return null; }
  const [reg] = await db.select().from(registrationsTable).where(eq(registrationsTable.id, regId));
  if (!reg || reg.status === "void") { res.status(404).json({ error: "Registration not found" }); return null; }
  const [rider] = await db.select().from(ridersTable).where(eq(ridersTable.id, reg.riderId));
  if (!rider || !(await canManageRider(account, rider))) { res.status(403).json({ error: "Not your registration" }); return null; }
  const [event] = await db.select().from(eventsTable).where(eq(eventsTable.id, reg.eventId));
  if (!event) { res.status(404).json({ error: "Event not found" }); return null; }
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

  const pending = (await riderRegsForEvent(rider.id, event.id)).filter(r => r.status === "pending");
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
  const discount = Math.min(Number(first.compDiscount ?? 0) || 0, totalEntry);

  const lineItems: Array<{ name: string; amount: number }> = [];
  const perClass = pending.length > 0 ? (totalEntry - discount) / pending.length : 0;
  for (const r of pending) if (perClass > 0) lineItems.push({ name: `${event.name} — ${r.raceClass} Entry`, amount: perClass });
  if (pending.some(r => r.transponderRental) && event.transponderRentalEnabled && Number(event.transponderRentalFee) > 0) {
    lineItems.push({ name: "Active Transponder Rental", amount: Number(event.transponderRentalFee) });
  }
  if (pending.some(r => r.rfidStickerPurchased) && event.timingTechnology === "rfid" && Number(event.rfidStickerFee) > 0) {
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
    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      line_items: lineItems.map(li => ({
        price_data: { currency: "usd", product_data: { name: li.name }, unit_amount: Math.round(li.amount * 100) },
        quantity: 1,
      })),
      customer_email: rider.email ?? undefined,
      payment_intent_data: { transfer_data: { destination: club.stripeAccountId } },
      metadata: { registrationIds: pending.map(r => r.id).join(","), type: "registration" },
      success_url: `${appUrl}/register/${event.id}?reg_id=${first.id}&session_id={CHECKOUT_SESSION_ID}&payment_success=1`,
      cancel_url: `${appUrl}/register/${event.id}?payment_cancelled=1`,
    });
    return res.json({ checkoutUrl: session.url, total: lineItems.reduce((s, li) => s + li.amount, 0) });
  } catch (err: any) {
    req.log?.error({ err: err?.message }, "[rider checkout] Stripe error");
    return res.status(502).json({ error: "Couldn't start the payment. Please try again, or pay at the gate." });
  }
});

// ── Waiver ───────────────────────────────────────────────────────────────────
async function waiverFor(event: typeof eventsTable.$inferSelect) {
  const [settings] = await db.select().from(clubSettingsTable).where(eq(clubSettingsTable.clubId, event.clubId));
  if (event.requireLiabilityWaiver) {
    return {
      kind: "liability" as const,
      text: settings?.liabilityWaiverText ?? null,
      pdfUrl: settings?.liabilityWaiverPdfUrl ?? null,
      snapshot: settings?.liabilityWaiverText ?? (settings?.liabilityWaiverPdfUrl ? `[PDF waiver] ${settings.liabilityWaiverPdfUrl}` : null),
    };
  }
  if (event.requireWaiver) {
    return {
      kind: "acknowledgement" as const,
      text: settings?.riderAcknowledgement ?? null,
      pdfUrl: settings?.waiverPdfUrl ?? null,
      snapshot: settings?.riderAcknowledgement ?? (settings?.waiverPdfUrl ? `[PDF waiver] ${settings.waiverPdfUrl}` : null),
    };
  }
  return null;
}

router.get("/rider/registrations/:regId/waiver", requireRiderAuth, async (req, res) => {
  const owned = await loadOwnedRegistration(req, res);
  if (!owned) return;
  const waiver = await waiverFor(owned.event);
  if (!waiver) return res.status(404).json({ error: "This event doesn't require a waiver." });
  const { snapshot: _snapshot, ...shown } = waiver;
  return res.json({ ...shown, eventName: owned.event.name, riderName: `${owned.rider.firstName} ${owned.rider.lastName}`.trim() });
});

router.post("/rider/registrations/:regId/waiver", requireRiderAuth, async (req, res) => {
  const owned = await loadOwnedRegistration(req, res);
  if (!owned) return;
  const { account, reg, rider, event } = owned;
  const { signerName, consentToEsign, asGuardian } = req.body ?? {};
  if (!String(signerName ?? "").trim()) return res.status(400).json({ error: "Type your full name to sign." });
  if (!consentToEsign) return res.status(400).json({ error: "Check the box to agree to sign electronically." });

  const waiver = await waiverFor(event);
  if (!waiver?.snapshot) return res.status(409).json({ error: "The waiver isn't available in the app. Sign it at the gate." });

  if (waiver.kind === "acknowledgement") {
    await db.update(registrationsTable)
      .set({ waiverAcknowledgedAt: new Date(), waiverSnapshot: waiver.snapshot })
      .where(and(eq(registrationsTable.riderId, rider.id), eq(registrationsTable.eventId, event.id), ne(registrationsTable.status, "void")));
    return res.json({ ok: true });
  }

  const guardian = !!asGuardian;
  await db.insert(liabilityWaiverSignaturesTable).values({
    clubId: event.clubId,
    eventId: event.id,
    registrationId: reg.id,
    signerName: String(signerName).trim(),
    signerEmail: account.email.toLowerCase(),
    signerIp: req.ip ?? null,
    signerUserAgent: req.get("user-agent") ?? null,
    consentToEsign: true,
    waiverContentHash: createHash("sha256").update(waiver.snapshot, "utf8").digest("hex"),
    waiverSnapshot: waiver.snapshot,
    signerType: guardian ? "guardian" : "self",
    minorRiderName: guardian ? `${rider.firstName} ${rider.lastName}`.trim() : null,
    signedAt: new Date(),
  });
  return res.json({ ok: true });
});

// ── Active timing transponder number ─────────────────────────────────────────
router.post("/rider/registrations/:regId/transponder", requireRiderAuth, async (req, res) => {
  const owned = await loadOwnedRegistration(req, res);
  if (!owned) return;
  const { rider, event } = owned;
  if (!["active_transponder", "mylaps"].includes(event.timingTechnology)) {
    return res.status(400).json({ error: "This event doesn't use active transponders." });
  }
  const number = normalizeActiveTransponderIdentifier(String(req.body?.transponderNumber ?? ""));
  if (!number) return res.status(400).json({ error: "Enter the ID printed on your transponder (up to 9 numbers or letters A–F)." });

  const others = await db.select({ riderId: registrationsTable.riderId }).from(registrationsTable).where(and(
    eq(registrationsTable.eventId, event.id),
    eq(registrationsTable.myLapsTransponderNumber, number),
    ne(registrationsTable.status, "void"),
    ne(registrationsTable.riderId, rider.id),
  )).limit(1);
  if (others.length) return res.status(409).json({ error: "That transponder number is already used by another rider at this event. Check the number, or see the organizer." });

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
  if (event.timingTechnology !== "rfid") return res.status(400).json({ error: "This event doesn't use RFID stickers." });
  const number = String(req.body?.rfidNumber ?? "").trim().toUpperCase();
  if (!/^[A-Z0-9]{1,32}$/.test(number)) return res.status(400).json({ error: "Enter the number printed on your RFID sticker (letters and numbers only)." });

  const [taken] = await db.select({ riderId: rfidAssignmentsTable.riderId }).from(rfidAssignmentsTable).where(and(
    eq(rfidAssignmentsTable.eventId, event.id),
    eq(rfidAssignmentsTable.rfidNumber, number),
  )).limit(1);
  if (taken && taken.riderId !== rider.id) {
    return res.status(409).json({ error: "That sticker number is already assigned to another rider at this event. Check the number, or see the organizer." });
  }

  const [existing] = await db.select({ id: rfidAssignmentsTable.id }).from(rfidAssignmentsTable)
    .where(and(eq(rfidAssignmentsTable.eventId, event.id), eq(rfidAssignmentsTable.riderId, rider.id))).limit(1);
  if (existing) await db.update(rfidAssignmentsTable).set({ rfidNumber: number }).where(eq(rfidAssignmentsTable.id, existing.id));
  else await db.insert(rfidAssignmentsTable).values({ riderId: rider.id, eventId: event.id, rfidNumber: number });
  await db.update(ridersTable).set({ rfidNumber: number }).where(eq(ridersTable.id, rider.id));
  return res.json({ ok: true, rfidNumber: number });
});

export default router;
