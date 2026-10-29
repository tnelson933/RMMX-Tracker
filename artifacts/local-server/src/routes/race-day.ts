import { Router } from "express";
import { normalizeActiveTransponderIdentifier } from "@workspace/api-zod";
import { getDb, parseBool, parseJson, parseJsonArr } from "../db";
import { RM_TRACKR_NAME, RM_TRACKR_PRICE, fulfillRmTrackr, markRmTrackrPurchased } from "../lib/rm-trackr";

/**
 * Race-day registration endpoints that must work offline. Each mirrors the
 * cloud handler in api-server/src/routes/registrations.ts (validation, effects
 * and response shape). Card payments need Stripe, so a `paymentMethod: "card"`
 * request falls through to the cloud pass-through (lib/cloud-proxy.ts).
 */

const router = Router();

function requireUser(req: any, res: any): boolean {
  if (!(req.session as any)?.userId) {
    res.status(401).json({ error: "Unauthorized" });
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
    res.status(404).json({ error: "Registration not found" });
    return null;
  }
  if (reg.event_id !== eventId) {
    res.status(403).json({ error: "Registration does not belong to this event" });
    return null;
  }
  return reg;
}

// ── Check-in add-ons (cash locally; card goes to the cloud) ──────────────────

router.post("/events/:eventId/registrations/:regId/add-transponder-rental", (req, res, next) => {
  if (!requireUser(req, res)) return;
  const { paymentMethod } = req.body ?? {};
  if (paymentMethod === "card") return next();
  const eventId = Number(req.params.eventId);
  const reg = loadEventRegistration(eventId, Number(req.params.regId), res);
  if (!reg) return;
  if (reg.transponder_rental === 1) return res.status(400).json({ error: "Rider already has a transponder rental" });

  const db = getDb();
  const event = db.prepare("SELECT transponder_rental_enabled, transponder_rental_fee FROM events WHERE id = ?")
    .get(eventId) as { transponder_rental_enabled: number; transponder_rental_fee: string | null } | undefined;
  if (!event || event.transponder_rental_enabled !== 1 || !event.transponder_rental_fee || !Number(event.transponder_rental_fee)) {
    return res.status(400).json({ error: "Transponder rental is not enabled for this event" });
  }
  const rentalFee = Number(event.transponder_rental_fee);

  if (paymentMethod === "cash") {
    db.prepare("UPDATE registrations SET transponder_rental = 1 WHERE id = ?").run(reg.id);
    return res.json({ success: true, rentalFee });
  }
  return res.status(400).json({ error: "paymentMethod must be 'cash' or 'card'" });
});

router.post("/events/:eventId/registrations/:regId/add-rfid-sticker", (req, res, next) => {
  if (!requireUser(req, res)) return;
  const { paymentMethod } = req.body ?? {};
  if (paymentMethod === "card") return next();
  const eventId = Number(req.params.eventId);
  const reg = loadEventRegistration(eventId, Number(req.params.regId), res);
  if (!reg) return;
  if (reg.rfid_sticker_purchased === 1) return res.status(400).json({ error: "Rider already has an RFID sticker" });

  const db = getDb();
  const event = db.prepare("SELECT rfid_sticker_fee FROM events WHERE id = ?")
    .get(eventId) as { rfid_sticker_fee: string | null } | undefined;
  if (!event?.rfid_sticker_fee || !Number(event.rfid_sticker_fee)) {
    return res.status(400).json({ error: "RFID sticker is not enabled for this event" });
  }
  const stickerFee = Number(event.rfid_sticker_fee);

  if (paymentMethod === "cash") {
    db.prepare("UPDATE registrations SET rfid_sticker_purchased = 1 WHERE event_id = ? AND rider_id = ?")
      .run(eventId, reg.rider_id);
    return res.json({ success: true, stickerFee });
  }
  return res.status(400).json({ error: "paymentMethod must be 'cash' or 'card'" });
});

router.post("/events/:eventId/registrations/:regId/add-rm-trackr", (req, res, next) => {
  if (!requireUser(req, res)) return;
  const { paymentMethod } = req.body ?? {};
  if (paymentMethod === "card") return next();
  const eventId = Number(req.params.eventId);
  const reg = loadEventRegistration(eventId, Number(req.params.regId), res);
  if (!reg) return;
  if (reg.status === "void") return res.status(400).json({ error: "This registration was cancelled" });
  if (reg.rm_trackr_purchased === 1) return res.status(400).json({ error: `Rider already purchased an ${RM_TRACKR_NAME}` });

  const db = getDb();
  const event = db.prepare("SELECT id FROM events WHERE id = ?").get(eventId);
  if (!event) return res.status(404).json({ error: "Event not found" });

  if (paymentMethod === "cash") {
    markRmTrackrPurchased(db, eventId, reg.rider_id);
    return res.json({ success: true, price: RM_TRACKR_PRICE });
  }
  return res.status(400).json({ error: "paymentMethod must be 'cash' or 'card'" });
});

// ── Transponder rentals ──────────────────────────────────────────────────────

router.get("/events/:eventId/transponder-rentals", (req, res) => {
  if (!requireUser(req, res)) return;
  const eventId = Number(req.params.eventId);
  if (!eventId) return res.status(400).json({ error: "eventId required" });
  const db = getDb();

  // One row per rider: their first rental registration for the event.
  const rows = db
    .prepare(
      `SELECT r.id AS registration_id, r.rider_id, ri.first_name, ri.last_name, ri.email,
              r.bib_number, r.mylaps_transponder_number, r.transponder_returned, r.race_class
       FROM registrations r
       JOIN riders ri ON ri.id = r.rider_id
       WHERE r.event_id = ? AND r.transponder_rental = 1
         AND r.id = (
           SELECT r2.id FROM registrations r2
           WHERE r2.event_id = r.event_id AND r2.rider_id = r.rider_id AND r2.transponder_rental = 1
           ORDER BY r2.created_at ASC, r2.id ASC LIMIT 1
         )
       ORDER BY r.rider_id`,
    )
    .all(eventId) as any[];

  // Riders with the app: rider_accounts + rider_push_tokens synced from the cloud.
  let emailsWithToken = new Set<string>();
  try {
    emailsWithToken = new Set(
      (db.prepare(
        `SELECT DISTINCT lower(a.email) AS email FROM rider_accounts a
         JOIN rider_push_tokens t ON t.rider_account_id = a.id`,
      ).all() as Array<{ email: string }>).map((r) => r.email),
    );
  } catch {
    // Older databases without the push tables: nobody shows as having the app.
  }

  return res.json(rows.map((r) => ({
    registrationId: r.registration_id,
    riderId: r.rider_id,
    riderName: `${r.first_name ?? ""} ${r.last_name ?? ""}`.trim(),
    bibNumber: r.bib_number ?? null,
    transponderNumber: r.mylaps_transponder_number ?? null,
    transponderReturned: parseBool(r.transponder_returned),
    raceClass: r.race_class,
    hasPushToken: r.email ? emailsWithToken.has(String(r.email).toLowerCase()) : false,
  })));
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
  if (!eventId || !regId) return res.status(400).json({ error: "Invalid ids" });

  const tag = normalizeActiveTransponderIdentifier(req.body?.transponderNumber);
  if (!tag) {
    return res.status(400).json({
      error: "transponderNumber must be a 1–9 character hexadecimal active transponder ID",
    });
  }

  const db = getDb();
  const reg = db.prepare("SELECT id, rider_id, transponder_rental FROM registrations WHERE id = ? AND event_id = ?")
    .get(regId, eventId) as { id: number; rider_id: number; transponder_rental: number } | undefined;
  if (!reg) return res.status(404).json({ error: "Registration not found" });
  if (reg.transponder_rental !== 1) return res.status(400).json({ error: "This registration does not have a transponder rental" });

  const event = db.prepare("SELECT date, end_date FROM events WHERE id = ?").get(eventId) as { date: string; end_date: string | null } | undefined;
  if (!event) return res.status(404).json({ error: "Event not found" });
  // The unit is the rider's only for this event; removed automatically after it.
  const expiresAt = rentalExpiry(event);

  const conflict = db
    .prepare("SELECT rider_id FROM rfid_assignments WHERE lower(trim(rfid_number)) = ? AND event_id = ? LIMIT 1")
    .get(tag, eventId) as { rider_id: number } | undefined;
  if (conflict && conflict.rider_id !== reg.rider_id) {
    return res.status(409).json({ error: `Transponder ${tag} is already assigned to another rider for this event` });
  }

  db.transaction(() => {
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
  if (!eventId || !regId) return res.status(400).json({ error: "Invalid ids" });
  const { returned } = req.body ?? {};
  if (typeof returned !== "boolean") return res.status(400).json({ error: "returned (boolean) required" });

  const db = getDb();
  const result = db.prepare("UPDATE registrations SET transponder_returned = ? WHERE id = ? AND event_id = ?")
    .run(returned ? 1 : 0, regId, eventId);
  if (result.changes === 0) return res.status(404).json({ error: "Registration not found" });
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
  if (!reg) return res.status(404).json({ error: "Registration not found" });
  if (reg.cancellation_source !== "rider") return res.status(400).json({ error: "Not a rider-initiated cancellation" });

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
  if (!e) return res.status(404).json({ error: "Event not found" });

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

  return res.json({
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
