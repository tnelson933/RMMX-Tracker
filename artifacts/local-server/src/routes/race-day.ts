import { listTeamMembers, saveTeamTags, teamRegistrationId } from "../lib/group-teams";
import { Router } from "express";
import { normalizeActiveTransponderIdentifier, parseCashTendered } from "@workspace/api-zod";
import type { AddonItem } from "@workspace/api-zod";
import { eventTrackrPrice, eventToday } from "@workspace/api-zod";
import { eventTimingTags } from "../lib/cloud-shape";
import { clubSellItems, eventSellPrices, paidAddonsAtEvent, recordCashAddon } from "../lib/addons";
import { getDb, paidAddons, parseBool, parseJson, parseJsonArr } from "../db";
import { RM_TRACKR_NAME, fulfillRmTrackr, markRmTrackrPurchased } from "../lib/rm-trackr";
import { noteRentalHandedOut, rentalsOut } from "./rental-transponders";

/**
 * Race-day registration endpoints that must work offline. Each mirrors the
 * cloud handler in api-server/src/routes/registrations.ts (validation, effects
 * and response shape). Card payments need Stripe, so a `paymentMethod: "card"`
 * request falls through to the cloud pass-through (lib/cloud-proxy.ts).
 */

const router = Router();

function requireUser(req: any, res: any): boolean {
  if (!(req.session as any)?.userId) {
    res.status(401).json({ error: "You're signed out. Sign in again, then try once more." });
    return false;
  }
  return true;
}

type RegRow = {
  id: number;
  event_id: number;
  rider_id: number;
  status: string | null;
  transponder_rental: number;
  rfid_sticker_purchased: number;
  rm_trackr_purchased: number;
};

function loadEventRegistration(eventId: number, regId: number, res: any): RegRow | null {
  const reg = getDb().prepare("SELECT * FROM registrations WHERE id = ?").get(regId) as RegRow | undefined;
  if (!reg) {
    res.status(404).json({ error: "This registration couldn't be found. It may have been cancelled. Refresh the page and try again." });
    return null;
  }
  if (reg.event_id !== eventId) {
    res.status(403).json({ error: "This registration is for a different event. Refresh the page and try again." });
    return null;
  }
  return reg;
}

/** Card and card-reader payments need Stripe: the cloud takes them (lib/cloud-proxy.ts). */
const goesToCloud = (paymentMethod: unknown) => paymentMethod === "card" || paymentMethod === "reader";

/**
 * Same rule as the cloud's addonIsPaid: an add-on chosen at registration is
 * paid when the entry was paid online or it was collected in cash here.
 */
function addonPaid(regId: number, item: AddonItem): boolean {
  const row = getDb().prepare("SELECT event_id, rider_id, payment_status, addons_paid FROM registrations WHERE id = ?").get(regId) as { event_id: number; rider_id: number; payment_status: string | null; addons_paid: string | null } | undefined;
  if (!row) return false;
  return row.payment_status === "paid" || paidAddonsAtEvent(row.event_id)(regId, row.rider_id, row.addons_paid).includes(item);
}

/** Records a cash add-on on every entry the rider has in the event (the check-in tile shows the first). */
function markAddonPaid(eventId: number, riderId: number, item: AddonItem): void {
  const db = getDb();
  const rows = db.prepare("SELECT id, addons_paid FROM registrations WHERE event_id = ? AND rider_id = ?").all(eventId, riderId) as Array<{ id: number; addons_paid: string | null }>;
  for (const r of rows) {
    const list = paidAddons(r.addons_paid);
    if (!list.includes(item)) db.prepare("UPDATE registrations SET addons_paid = ? WHERE id = ?").run(JSON.stringify([...list, item]), r.id);
  }
}

/** How many tags a sale is for: group race teams buy up to one per rider; others buy one. */
function addonQuantity(raw: unknown, event: { group_race: number; riders_per_group: number | null } | undefined): { qty: number } | { error: string } {
  if (raw === undefined || raw === null || raw === "") return { qty: 1 };
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) return { error: "Choose how many to sell (1 or more)." };
  if (n === 1) return { qty: 1 };
  if (event?.group_race !== 1) return { error: "Only group race teams can buy more than one at a time." };
  const max = Math.max(2, event.riders_per_group ?? 2);
  if (n > max) return { error: `A team has ${max} riders, so sell at most ${max} at a time.` };
  return { qty: n };
}

// ── Group race: a team's riders and their transponder numbers ────────────────
router.get("/events/:eventId/registrations/:regId/team", (req, res) => {
  if (!requireUser(req, res)) return;
  const eventId = Number(req.params.eventId);
  const reg = loadEventRegistration(eventId, Number(req.params.regId), res);
  if (!reg) return;
  const event = getDb().prepare("SELECT group_race, riders_per_group FROM events WHERE id = ?").get(eventId) as { group_race: number; riders_per_group: number | null } | undefined;
  if (event?.group_race !== 1) return res.status(400).json({ error: "This event isn't a group race." });
  const teamRegId = teamRegistrationId(eventId, reg.rider_id) ?? reg.id;
  const teamName = (getDb().prepare("SELECT team_name FROM registrations WHERE id = ?").get(reg.id) as { team_name: string | null } | undefined)?.team_name ?? null;
  return res.json({ registrationId: teamRegId, teamName, ridersPerGroup: event.riders_per_group, members: listTeamMembers(teamRegId) });
});

router.put("/events/:eventId/registrations/:regId/team", (req, res) => {
  if (!requireUser(req, res)) return;
  const eventId = Number(req.params.eventId);
  const reg = loadEventRegistration(eventId, Number(req.params.regId), res);
  if (!reg) return;
  if (reg.status === "void") return res.status(400).json({ error: "This registration was cancelled. Restore it on the Registrations page first." });
  const members = Array.isArray(req.body?.members) ? req.body.members : null;
  if (!members) return res.status(400).json({ error: "Nothing to save. Enter the team's numbers and try again." });
  const teamRegId = teamRegistrationId(eventId, reg.rider_id) ?? reg.id;
  const problem = saveTeamTags(eventId, teamRegId, reg.rider_id, members);
  if (problem) return res.status(409).json(problem);
  const teamName = (getDb().prepare("SELECT team_name FROM registrations WHERE id = ?").get(reg.id) as { team_name: string | null } | undefined)?.team_name ?? null;
  return res.json({ registrationId: teamRegId, teamName, members: listTeamMembers(teamRegId) });
});

// ── Check-in add-ons (cash locally; card goes to the cloud) ──────────────────

router.post("/events/:eventId/registrations/:regId/add-transponder-rental", (req, res, next) => {
  if (!requireUser(req, res)) return;
  const { paymentMethod } = req.body ?? {};
  if (goesToCloud(paymentMethod)) return next();
  const eventId = Number(req.params.eventId);
  const reg = loadEventRegistration(eventId, Number(req.params.regId), res);
  if (!reg) return;

  const db = getDb();
  const event = db.prepare("SELECT transponder_rental_enabled, transponder_rental_fee, group_race, riders_per_group FROM events WHERE id = ?")
    .get(eventId) as { transponder_rental_enabled: number; transponder_rental_fee: string | null; group_race: number; riders_per_group: number | null } | undefined;
  const qty = addonQuantity(req.body?.quantity, event);
  if ("error" in qty) return res.status(400).json({ error: qty.error });
  // A rental chosen at registration but not paid yet can be collected here (like the cloud).
  if (event?.group_race !== 1 && reg.transponder_rental === 1 && addonPaid(reg.id, "transponder_rental")) {
    return res.status(400).json({ error: "This rider's transponder rental is already paid." });
  }
  if (!event || event.transponder_rental_enabled !== 1 || !event.transponder_rental_fee || !Number(event.transponder_rental_fee)) {
    return res.status(400).json({ error: "Transponder rentals aren't turned on for this event. Turn them on in the event's settings first." });
  }
  const rentalFee = Math.round(Number(event.transponder_rental_fee) * qty.qty * 100) / 100;

  if (paymentMethod === "cash") {
    const tender = parseCashTendered(req.body?.cashTendered, rentalFee);
    if (tender && "error" in tender) return res.status(400).json({ error: tender.error });
    db.prepare("UPDATE registrations SET transponder_rental = 1 WHERE id = ?").run(reg.id);
    markAddonPaid(eventId, reg.rider_id, "transponder_rental");
    recordCashAddon(eventId, reg.id, "transponder_rental", rentalFee, tender, qty.qty);
    return res.json({ success: true, rentalFee, quantity: qty.qty, cashTendered: tender?.tendered ?? null, cashChange: tender?.change ?? null });
  }
  return res.status(400).json({ error: "Choose Cash, Card or a card reader, then try again." });
});

router.post("/events/:eventId/registrations/:regId/add-rfid-sticker", (req, res, next) => {
  if (!requireUser(req, res)) return;
  const { paymentMethod } = req.body ?? {};
  if (goesToCloud(paymentMethod)) return next();
  const eventId = Number(req.params.eventId);
  const reg = loadEventRegistration(eventId, Number(req.params.regId), res);
  if (!reg) return;
  const db = getDb();
  const event = db.prepare("SELECT group_race, riders_per_group FROM events WHERE id = ?")
    .get(eventId) as { group_race: number; riders_per_group: number | null } | undefined;
  const qty = addonQuantity(req.body?.quantity, event);
  if ("error" in qty) return res.status(400).json({ error: qty.error });
  if (event?.group_race !== 1 && reg.rfid_sticker_purchased === 1 && addonPaid(reg.id, "rfid_sticker")) return res.status(400).json({ error: "This rider's RFID tag is already paid." });
  // The event's sticker fee, or the club's RFID Tag price (Admin → Sell Items).
  const unitFee = event ? eventSellPrices(eventId)?.rfidTag ?? null : null;
  if (unitFee == null) {
    return res.status(400).json({ error: "RFID tags have no price yet. Set one in Admin → Sell Items, or turn on RFID stickers in the event's settings." });
  }
  const stickerFee = Math.round(unitFee * qty.qty * 100) / 100;

  if (paymentMethod === "cash") {
    const tender = parseCashTendered(req.body?.cashTendered, stickerFee);
    if (tender && "error" in tender) return res.status(400).json({ error: tender.error });
    db.prepare("UPDATE registrations SET rfid_sticker_purchased = 1 WHERE event_id = ? AND rider_id = ?")
      .run(eventId, reg.rider_id);
    markAddonPaid(eventId, reg.rider_id, "rfid_sticker");
    recordCashAddon(eventId, reg.id, "rfid_sticker", stickerFee, tender, qty.qty);
    return res.json({ success: true, stickerFee, quantity: qty.qty, cashTendered: tender?.tendered ?? null, cashChange: tender?.change ?? null });
  }
  return res.status(400).json({ error: "Choose Cash, Card or a card reader, then try again." });
});

router.post("/events/:eventId/registrations/:regId/add-rm-trackr", (req, res, next) => {
  if (!requireUser(req, res)) return;
  const { paymentMethod } = req.body ?? {};
  if (goesToCloud(paymentMethod)) return next();
  const eventId = Number(req.params.eventId);
  const reg = loadEventRegistration(eventId, Number(req.params.regId), res);
  if (!reg) return;
  if (reg.status === "void") return res.status(400).json({ error: "This registration was cancelled" });
  const db = getDb();
  const event = db.prepare("SELECT id, group_race, riders_per_group FROM events WHERE id = ?").get(eventId) as { id: number; group_race: number; riders_per_group: number | null } | undefined;
  if (!event) return res.status(404).json({ error: "This event couldn't be found. It may have been deleted. Go back to Events and open it again." });
  const qty = addonQuantity(req.body?.quantity, event);
  if ("error" in qty) return res.status(400).json({ error: qty.error });
  if (event.group_race !== 1 && reg.rm_trackr_purchased === 1 && addonPaid(reg.id, "rm_trackr")) return res.status(400).json({ error: `This rider's ${RM_TRACKR_NAME} is already paid.` });
  // The event's RM TrackR price, or the club's (Admin → Sell Items).
  const unitPrice = eventSellPrices(eventId)?.rmTrackr ?? null;
  if (unitPrice == null) return res.status(400).json({ error: `Your club has hidden the ${RM_TRACKR_NAME} in Admin → Sell Items. Show it there to sell it.` });

  if (paymentMethod === "cash") {
    const price = Math.round(unitPrice * qty.qty * 100) / 100;
    const tender = parseCashTendered(req.body?.cashTendered, price);
    if (tender && "error" in tender) return res.status(400).json({ error: tender.error });
    markRmTrackrPurchased(db, eventId, reg.rider_id);
    markAddonPaid(eventId, reg.rider_id, "rm_trackr");
    recordCashAddon(eventId, reg.id, "rm_trackr", price, tender, qty.qty);
    return res.json({ success: true, price, quantity: qty.qty, cashTendered: tender?.tendered ?? null, cashChange: tender?.change ?? null });
  }
  return res.status(400).json({ error: "Choose Cash, Card or a card reader, then try again." });
});

// ── Transponder rentals ──────────────────────────────────────────────────────

/**
 * The event's rentals as the website lists them (api-server registrations.ts
 * rentalRows): one row per rental entry with the renter's contact details,
 * whether a push reminder could reach them, and the last reminder's outcome.
 * Reminders themselves are sent by the cloud.
 */
function rentalRows(eventId: number, registrationId?: number) {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT r.id AS registration_id, r.rider_id, ri.first_name, ri.last_name, ri.email, ri.phone,
              ri.emergency_contact, ri.emergency_phone,
              r.bib_number, r.mylaps_transponder_number, r.transponder_returned, r.race_class,
              r.rental_reminder_status, r.rental_reminder_at, e.name AS event_name, e.date AS event_date
       FROM registrations r
       JOIN riders ri ON ri.id = r.rider_id
       JOIN events e ON e.id = r.event_id
       WHERE r.event_id = ? AND r.transponder_rental = 1 AND r.status != 'void'
         AND (? IS NULL OR r.id = ?)
       ORDER BY ri.last_name, ri.first_name, r.id`,
    )
    .all(eventId, registrationId ?? null, registrationId ?? null) as any[];

  // Riders with the app, and those with notifications on (rider_accounts +
  // rider_push_tokens as last pulled from the cloud).
  const hasApp = new Set<string>();
  const hasToken = new Set<string>();
  try {
    for (const acct of db.prepare(
      `SELECT lower(trim(a.email)) AS email, (SELECT COUNT(*) FROM rider_push_tokens t WHERE t.rider_account_id = a.id) AS tokens
       FROM rider_accounts a`,
    ).all() as Array<{ email: string; tokens: number }>) {
      hasApp.add(acct.email);
      if (acct.tokens > 0) hasToken.add(acct.email);
    }
  } catch {
    // Older databases without the push tables: nobody shows as having the app.
  }
  const statusText = (status: string | null): string | null => {
    switch (status) {
      case "sent": return "Push notification sent";
      case "no_app": return "Not sent: the rider doesn't have the RM Roost app";
      case "no_notifications": return "Not sent: the rider hasn't turned on notifications in the app";
      case "failed": return "Not sent: the notification service didn't accept it. Try again in a few minutes.";
      default: return null;
    }
  };
  // What an unreturned transponder costs: the event's RM TrackR price, else the club's.
  const event = db.prepare("SELECT club_id, purchase_options FROM events WHERE id = ?").get(eventId) as any;
  const replacementCharge = event
    ? eventTrackrPrice(parseJsonArr<object>(event.purchase_options)) ?? clubSellItems(event.club_id).find(i => i.kind === "rm_trackr")?.price ?? null
    : null;

  return rows.map((r) => {
    const email = r.email ? String(r.email).trim().toLowerCase() : "";
    const reach = !email || !hasApp.has(email) ? "no_app" : !hasToken.has(email) ? "no_notifications" : "sent";
    return {
      registrationId: r.registration_id,
      riderId: r.rider_id,
      eventId,
      eventName: r.event_name,
      eventDate: String(r.event_date).slice(0, 10),
      riderName: `${r.first_name ?? ""} ${r.last_name ?? ""}`.trim() || "Rider",
      email: r.email ?? null,
      phone: r.phone ?? null,
      emergencyContact: r.emergency_contact ?? null,
      emergencyPhone: r.emergency_phone ?? null,
      bibNumber: r.bib_number ?? null,
      transponderNumber: r.mylaps_transponder_number ?? null,
      transponderReturned: parseBool(r.transponder_returned),
      raceClass: r.race_class,
      hasPushToken: reach === "sent",
      notifyBlockedReason: reach === "sent" ? null : statusText(reach),
      reminderStatus: r.rental_reminder_status ?? null,
      reminderMessage: statusText(r.rental_reminder_status ?? null),
      reminderAt: r.rental_reminder_at ?? null,
      replacementCharge,
    };
  });
}

router.get("/events/:eventId/transponder-rentals", (req, res) => {
  if (!requireUser(req, res)) return;
  const eventId = Number(req.params.eventId);
  if (!eventId) return res.status(400).json({ error: "Choose an event first." });
  return res.json(rentalRows(eventId));
});

// One rental, for the renter panel.
router.get("/events/:eventId/transponder-rentals/registrations/:registrationId", (req, res) => {
  if (!requireUser(req, res)) return;
  const [row] = rentalRows(Number(req.params.eventId), Number(req.params.registrationId));
  if (!row) return res.status(404).json({ error: "That rental wasn't found. It may have been cancelled. Refresh the page and try again." });
  return res.json(row);
});

/** Same rule as the cloud (api-server lib/rentalTransponders.ts): noon UTC the day after the last race day. */
export function rentalExpiry(event: { date: string; end_date?: string | null }): string {
  const lastDay = event.end_date && event.end_date > event.date ? event.end_date : event.date;
  const [y, m, d] = String(lastDay).slice(0, 10).split("-").map(Number);
  if (!y || !m || !d) return new Date(Date.now() + 36 * 60 * 60_000).toISOString();
  return new Date(Date.UTC(y, m - 1, d + 1, 12, 0, 0)).toISOString();
}

/** Rental links whose event is over are removed automatically (organizers never clear them). */
export function sweepExpiredRentals(): number {
  return getDb().prepare("DELETE FROM rfid_assignments WHERE expires_at IS NOT NULL AND expires_at < ?")
    .run(new Date().toISOString()).changes;
}

// Assign a transponder to a rental (event-scoped, expires after the event).
router.post("/events/:eventId/registrations/:regId/assign-rental-transponder", (req, res) => {
  if (!requireUser(req, res)) return;
  const eventId = Number(req.params.eventId);
  const regId = Number(req.params.regId);
  if (!eventId || !regId) return res.status(400).json({ error: "This link looks broken. Go back and open it again from the list." });

  const tag = normalizeActiveTransponderIdentifier(req.body?.transponderNumber);
  if (!tag) {
    return res.status(400).json({
      error: "Enter the ID printed on the transponder (up to 9 numbers or letters A–F).",
    });
  }

  const db = getDb();
  const reg = db.prepare("SELECT id, rider_id, transponder_rental FROM registrations WHERE id = ? AND event_id = ?")
    .get(regId, eventId) as { id: number; rider_id: number; transponder_rental: number } | undefined;
  if (!reg) return res.status(404).json({ error: "This registration couldn't be found. It may have been cancelled. Refresh the page and try again." });
  if (reg.transponder_rental !== 1) return res.status(400).json({ error: "This registration doesn't have a rental transponder." });

  const event = db.prepare("SELECT date, end_date, club_id FROM events WHERE id = ?").get(eventId) as { date: string; end_date: string | null; club_id: number } | undefined;
  if (!event) return res.status(404).json({ error: "This event couldn't be found. It may have been deleted. Go back to Events and open it again." });
  // The unit is the rider's only for this event; removed automatically after it.
  const expiresAt = rentalExpiry(event);

  const conflict = db
    .prepare("SELECT rider_id FROM rfid_assignments WHERE lower(trim(rfid_number)) = ? AND event_id = ? LIMIT 1")
    .get(tag, eventId) as { rider_id: number } | undefined;
  if (conflict && conflict.rider_id !== reg.rider_id) {
    return res.status(409).json({ error: `Transponder ${tag} is already assigned to another rider for this event` });
  }

  // A unit still out from an earlier event (not marked returned) can't go to a new rider.
  const stillOut = rentalsOut(event.club_id).get(tag);
  if (stillOut && stillOut.eventId !== eventId) {
    return res.status(409).json({
      error: `Rental ${tag} is still out from ${stillOut.eventName} (${stillOut.eventDate}). Mark it returned on that event's Transponder Rentals tab first.`,
    });
  }

  db.transaction(() => {
    // Keep the club's rental inventory complete, and a unit handed out isn't missing.
    noteRentalHandedOut(event.club_id, tag);
    // Rental = temporary: does NOT update riders.rfid_number.
    const existing = db.prepare("SELECT id FROM rfid_assignments WHERE rider_id = ? AND event_id = ? LIMIT 1")
      .get(reg.rider_id, eventId) as { id: number } | undefined;
    if (existing) {
      db.prepare("UPDATE rfid_assignments SET rfid_number = ?, expires_at = ? WHERE id = ?").run(tag, expiresAt, existing.id);
    } else {
      db.prepare("INSERT INTO rfid_assignments (rider_id, event_id, rfid_number, expires_at) VALUES (?, ?, ?, ?)")
        .run(reg.rider_id, eventId, tag, expiresAt);
    }
    db.prepare("UPDATE checkins SET rfid_number = ?, rfid_linked = 1 WHERE event_id = ? AND rider_id = ?")
      .run(tag, eventId, reg.rider_id);
    // Multi-class riders have one rental row per class: update them all.
    db.prepare(
      "UPDATE registrations SET mylaps_transponder_number = ? WHERE event_id = ? AND rider_id = ? AND transponder_rental = 1",
    ).run(tag, eventId, reg.rider_id);
    fulfillRmTrackr(db, eventId, reg.rider_id, tag);
  })();

  return res.json({ success: true, transponderNumber: tag, expiresAt });
});

router.patch("/events/:eventId/registrations/:regId/transponder-returned", (req, res) => {
  if (!requireUser(req, res)) return;
  const eventId = Number(req.params.eventId);
  const regId = Number(req.params.regId);
  if (!eventId || !regId) return res.status(400).json({ error: "This link looks broken. Go back and open it again from the list." });
  const { returned } = req.body ?? {};
  if (typeof returned !== "boolean") return res.status(400).json({ error: "Something was missing from that request. Refresh the page and try again." });

  const db = getDb();
  const result = db.prepare("UPDATE registrations SET transponder_returned = ? WHERE id = ? AND event_id = ?")
    .run(returned ? 1 : 0, regId, eventId);
  if (result.changes === 0) return res.status(404).json({ error: "This registration couldn't be found. It may have been cancelled. Refresh the page and try again." });
  // Returned: the unit is no longer this rider's, so its timing link goes now.
  if (returned) {
    const reg = db.prepare("SELECT rider_id FROM registrations WHERE id = ?").get(regId) as { rider_id: number } | undefined;
    if (reg) db.prepare("DELETE FROM rfid_assignments WHERE event_id = ? AND rider_id = ? AND expires_at IS NOT NULL").run(eventId, reg.rider_id);
  }
  return res.json({ registrationId: regId, transponderReturned: returned });
});

// ── Rider-initiated cancellations ────────────────────────────────────────────

function serializeCancellation(r: any) {
  return {
    id: r.id,
    eventId: r.event_id,
    riderId: r.rider_id,
    riderName: `${r.first_name ?? ""} ${r.last_name ?? ""}`.trim(),
    raceClass: r.race_class,
    bibNumber: r.bib_number ?? null,
    amountPaid: r.amount_paid != null ? Number(r.amount_paid) : null,
    paymentMethod: r.payment_method ?? null,
    paymentStatus: r.payment_status ?? null,
    cancelledAt: r.cancelled_at ?? "",
    refundVerifiedAt: r.refund_verified_at ?? null,
  };
}

router.get("/events/:eventId/cancellations", (req, res) => {
  if (!requireUser(req, res)) return;
  const eventId = Number(req.params.eventId);
  if (!eventId) return res.status(400).json({ error: "Invalid eventId" });
  const rows = getDb()
    .prepare(
      `SELECT r.*, ri.first_name, ri.last_name
       FROM registrations r
       LEFT JOIN riders ri ON ri.id = r.rider_id
       WHERE r.event_id = ? AND r.cancellation_source = 'rider'
       ORDER BY r.cancelled_at DESC`,
    )
    .all(eventId) as any[];
  const cancellations = rows.map(serializeCancellation);
  const unverifiedCount = cancellations.filter((c) => c.refundVerifiedAt == null).length;
  return res.json({ cancellations, unverifiedCount });
});

router.patch("/events/:eventId/cancellations/:registrationId/verify", (req, res) => {
  if (!requireUser(req, res)) return;
  const eventId = Number(req.params.eventId);
  const registrationId = Number(req.params.registrationId);
  if (!eventId) return res.status(400).json({ error: "Invalid eventId" });

  const db = getDb();
  const reg = db.prepare("SELECT id, cancellation_source FROM registrations WHERE id = ? AND event_id = ?")
    .get(registrationId, eventId) as { id: number; cancellation_source: string | null } | undefined;
  if (!reg) return res.status(404).json({ error: "This registration couldn't be found. It may have been cancelled. Refresh the page and try again." });
  if (reg.cancellation_source !== "rider") return res.status(400).json({ error: "Only cancellations a rider started can be refunded here. Refund it from the registration instead." });

  db.prepare("UPDATE registrations SET refund_verified_at = ? WHERE id = ?").run(new Date().toISOString(), registrationId);
  const updated = db
    .prepare(
      `SELECT r.*, ri.first_name, ri.last_name FROM registrations r
       LEFT JOIN riders ri ON ri.id = r.rider_id WHERE r.id = ?`,
    )
    .get(registrationId);
  return res.json(serializeCancellation(updated));
});

// ── Public: event info for the registration form / check-in waiver ───────────

router.get("/public/events/:eventId/register-info", (req, res) => {
  const eventId = Number(req.params.eventId);
  const db = getDb();
  const e = db
    .prepare(
      `SELECT e.*, c.name AS club_name, c.logo_url AS club_logo_url
       FROM events e LEFT JOIN clubs c ON c.id = e.club_id
       WHERE e.id = ?`,
    )
    .get(eventId) as any;
  if (!e) return res.status(404).json({ error: "This event couldn't be found. It may have been deleted. Go back to Events and open it again." });

  const settings = db.prepare("SELECT * FROM club_settings WHERE id = ?").get(e.club_id) as any;
  const requireWaiver = e.require_waiver === 1;
  const requireLiabilityWaiver = e.require_liability_waiver === 1;

  // Club-level class details first, then per-event overrides (as the cloud does).
  const classDetails: Record<string, string> = {};
  for (const dc of parseJsonArr<{ name: string; details?: string }>(settings?.default_classes)) {
    if (dc?.details && dc.details.trim()) classDetails[dc.name] = dc.details.trim();
  }
  for (const [cls, detail] of Object.entries(parseJson<Record<string, string>>(e.race_class_details, {}))) {
    if (typeof detail === "string" && detail.trim()) classDetails[cls] = detail.trim();
  }

  const money = (v: unknown) => (v != null && v !== "" ? Number(v) : null);
  // The entry fee charged today (early sign-up price by the track's local date).
  const earlyBirdActive = !!(e.early_bird_ends_at && eventToday({ state: e.state, trackLat: e.track_lat, trackLng: e.track_lng }) <= e.early_bird_ends_at && e.early_bird_fee);

  return res.json({
    earlyBirdActive,
    currentEntryFee: earlyBirdActive ? Number(e.early_bird_fee) : (e.entry_fee ? Number(e.entry_fee) : null),
    // Which kinds of tag the event's readers use (RM TrackR, RFID or both).
    timingTags: eventTimingTags(db, eventId),
    rfidStickerFee: e.rfid_sticker_fee && Number(e.rfid_sticker_fee) > 0 ? Number(e.rfid_sticker_fee) : null,
    contingencyBrands: parseJson<string[] | null>(e.contingency_brands, null),
    groupRace: e.group_race === 1,
    ridersPerGroup: e.riders_per_group ?? null,
    id: e.id,
    clubId: e.club_id,
    name: e.name,
    date: e.date,
    state: e.state ?? "",
    location: e.location ?? null,
    trackName: e.track_name ?? null,
    raceClasses: parseJsonArr(e.race_classes),
    raceClassDetails: parseJson(e.race_class_details, {}),
    status: e.status,
    entryFee: money(e.entry_fee),
    paymentEnabled: e.payment_enabled === 1,
    requireAma: e.require_ama === 1,
    maxRiders: e.max_riders ?? null,
    registrationOpen: e.registration_open ?? null,
    registrationClose: e.registration_close ?? null,
    clubName: e.club_name ?? null,
    clubLogoUrl: e.club_logo_url ?? null,
    imageUrl: e.image_url ?? null,
    timingTechnology: e.timing_technology ?? "rfid",
    transponderRentalEnabled: e.transponder_rental_enabled === 1,
    transponderRentalFee: money(e.transponder_rental_fee),
    purchaseOptions: parseJsonArr(e.purchase_options),
    noDuplicateBibs: e.no_duplicate_bibs === 1,
    requireClubId: e.require_club_id === 1,
    requireWaiver,
    requireLiabilityWaiver,
    requireTransponder: e.require_transponder === 1,
    earlyBirdFee: money(e.early_bird_fee),
    earlyBirdEndsAt: e.early_bird_ends_at ?? null,
    classDetails,
    waiverText: requireWaiver ? (settings?.rider_acknowledgement ?? null) : null,
    waiverPdfUrl: requireWaiver ? (settings?.waiver_pdf_url ?? null) : null,
    liabilityWaiverText: requireLiabilityWaiver ? (settings?.liability_waiver_text ?? null) : null,
    liabilityWaiverPdfUrl: requireLiabilityWaiver ? (settings?.liability_waiver_pdf_url ?? null) : null,
    liabilityWaiverFields: requireLiabilityWaiver ? parseJson(settings?.liability_waiver_fields, null) : null,
  });
});

export default router;
