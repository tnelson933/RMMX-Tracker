import { Router } from "express";
import { getDb, parseBool, parseJsonArr } from "../db";

const router = Router();

function deserializeReg(r: Record<string, unknown>) {
  return {
    id: r.id,
    eventId: r.event_id,
    riderId: r.rider_id,
    raceClass: r.race_class,
    status: r.status,
    paymentStatus: r.payment_status,
    bibNumber: r.bib_number,
    bikeBrand: r.bike_brand,
    myLapsTransponderNumber: r.mylaps_transponder_number,
    clubIdNumber: r.club_id_number,
    amountPaid: r.amount_paid != null ? Number(r.amount_paid) : null,
    paymentMethod: r.payment_method,
    statsEmailOptIn: parseBool(r.stats_email_opt_in as number),
    transponderRental: parseBool(r.transponder_rental as number),
    selectedPurchaseOptions: parseJsonArr(r.selected_purchase_options as string),
    displayFirstName: r.display_first_name,
    displayLastName: r.display_last_name,
    createdAt: r.created_at,
  };
}

router.get("/events/:eventId/registrations", (req, res) => {
  const userId = (req.session as any).userId;
  if (!userId) return res.status(401).json({ error: "Not authenticated" });

  const eventId = Number(req.params.eventId);
  const db = getDb();

  const rows = db
    .prepare(
      `SELECT
        r.*,
        ri.first_name, ri.last_name, ri.email AS rider_email, ri.phone,
        ra.rfid_number AS assigned_rfid_number
       FROM registrations r
       LEFT JOIN riders ri ON r.rider_id = ri.id
       LEFT JOIN rfid_assignments ra ON ra.rider_id = r.rider_id AND ra.event_id = r.event_id
       WHERE r.event_id = ?
       ORDER BY ri.last_name`,
    )
    .all(eventId) as Record<string, unknown>[];

  return res.json(
    rows.map((r) => ({
      ...deserializeReg(r),
      rfidNumber: r.assigned_rfid_number ?? null,
      riderName: `${r.first_name ?? ""} ${r.last_name ?? ""}`.trim(),
      firstName: r.first_name,
      lastName: r.last_name,
      email: r.rider_email,
      phone: r.phone,
    })),
  );
});

router.post("/events/:eventId/registrations", (req, res) => {
  const userId = (req.session as any).userId;
  if (!userId) return res.status(401).json({ error: "Not authenticated" });

  const eventId = Number(req.params.eventId);
  const {
    firstName, lastName, email, phone, dateOfBirth, emergencyContact, emergencyPhone,
    streetAddress, city, homeState, zip,
    raceClass, bibNumber, clubIdNumber, bikeBrand, rentTransponder,
    myLapsTransponderNumber, selectedPurchaseOptions,
    paymentMethod, amountPaid, status: reqStatus,
  } = req.body;

  if (!firstName || !lastName || !email || !raceClass) {
    return res.status(400).json({ error: "firstName, lastName, email, raceClass required" });
  }

  const db = getDb();

  // Find or create rider by email
  let rider = db
    .prepare("SELECT * FROM riders WHERE email = ? LIMIT 1")
    .get(email) as Record<string, unknown> | undefined;

  if (!rider) {
    const r = db
      .prepare(
        `INSERT INTO riders (first_name, last_name, email, phone, date_of_birth,
           emergency_contact, emergency_phone, street_address, city, home_state, zip)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        firstName, lastName, email,
        phone || null, dateOfBirth || null, emergencyContact || null, emergencyPhone || null,
        streetAddress || null, city || null, homeState || null, zip || null,
      );
    rider = db
      .prepare("SELECT * FROM riders WHERE id = ?")
      .get(r.lastInsertRowid) as Record<string, unknown>;
  } else {
    db.prepare(
      `UPDATE riders SET first_name = ?, last_name = ?,
         phone = COALESCE(?, phone), date_of_birth = COALESCE(?, date_of_birth),
         emergency_contact = COALESCE(?, emergency_contact),
         emergency_phone = COALESCE(?, emergency_phone)
       WHERE id = ?`,
    ).run(
      firstName, lastName,
      phone || null, dateOfBirth || null, emergencyContact || null, emergencyPhone || null,
      rider.id,
    );
  }

  const riderId = rider!.id as number;
  const finalStatus = reqStatus || "confirmed";
  const hasPaid =
    paymentMethod && amountPaid != null && parseFloat(String(amountPaid)) >= 0;
  const finalPaymentStatus = hasPaid ? "paid" : "unpaid";

  const regResult = db
    .prepare(
      `INSERT INTO registrations
         (event_id, rider_id, race_class, status, payment_status, payment_method, amount_paid,
          bib_number, club_id_number, bike_brand, transponder_rental, mylaps_transponder_number,
          selected_purchase_options, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))`,
    )
    .run(
      eventId, riderId, raceClass, finalStatus, finalPaymentStatus,
      paymentMethod || null,
      hasPaid ? String(amountPaid) : null,
      bibNumber || null, clubIdNumber || null, bikeBrand || null,
      rentTransponder ? 1 : 0,
      myLapsTransponderNumber || null,
      JSON.stringify(selectedPurchaseOptions || []),
    );

  const regId = regResult.lastInsertRowid as number;

  // Auto-create checkin for confirmed registrations
  if (finalStatus === "confirmed") {
    const existingCheckin = db
      .prepare("SELECT id FROM checkins WHERE event_id = ? AND rider_id = ? LIMIT 1")
      .get(eventId, riderId);
    if (!existingCheckin) {
      db.prepare(
        `INSERT INTO checkins (event_id, rider_id, race_class, bib_number, checked_in, rfid_linked, created_at)
         VALUES (?, ?, ?, ?, 0, 0, datetime('now'))`,
      ).run(eventId, riderId, raceClass, bibNumber || null);
    }
  }

  const reg = db
    .prepare("SELECT * FROM registrations WHERE id = ?")
    .get(regId) as Record<string, unknown>;

  return res.status(201).json({
    ...deserializeReg(reg),
    riderName: `${firstName} ${lastName}`.trim(),
    firstName,
    lastName,
    email,
    phone: phone || null,
  });
});

router.patch("/registrations/:registrationId", (req, res) => {
  const userId = (req.session as any).userId;
  if (!userId) return res.status(401).json({ error: "Not authenticated" });

  const id = Number(req.params.registrationId);
  const { status, paymentStatus, raceClass, bibNumber, amountPaid, paymentMethod, riderId, displayFirstName, displayLastName } = req.body;

  const updates: string[] = [];
  const params: unknown[] = [];

  if (status !== undefined) { updates.push("status = ?"); params.push(status); }
  if (paymentStatus !== undefined) {
    updates.push("payment_status = ?");
    params.push(paymentStatus);
    // Marking as paid without an explicit status change — auto-confirm the registration
    if (paymentStatus === "paid" && status === undefined) {
      updates.push("status = ?");
      params.push("confirmed");
    }
  }
  if (raceClass !== undefined) { updates.push("race_class = ?"); params.push(raceClass); }
  if (bibNumber !== undefined) { updates.push("bib_number = ?"); params.push(bibNumber || null); }
  if (amountPaid !== undefined) { updates.push("amount_paid = ?"); params.push(amountPaid !== null ? String(amountPaid) : null); }
  if (paymentMethod !== undefined) { updates.push("payment_method = ?"); params.push(paymentMethod); }
  if (riderId !== undefined) { updates.push("rider_id = ?"); params.push(Number(riderId)); }
  if (displayFirstName !== undefined) { updates.push("display_first_name = ?"); params.push(displayFirstName || null); }
  if (displayLastName !== undefined) { updates.push("display_last_name = ?"); params.push(displayLastName || null); }

  if (updates.length === 0) {
    return res.status(400).json({ error: "No fields to update" });
  }

  params.push(id);
  const db = getDb();
  db.prepare(`UPDATE registrations SET ${updates.join(", ")} WHERE id = ?`).run(...(params as any[]));

  const updated = db
    .prepare("SELECT * FROM registrations WHERE id = ?")
    .get(id) as Record<string, unknown> | undefined;

  if (!updated) return res.status(404).json({ error: "Not found" });

  // Create a checkin record if the registration is now confirmed and one doesn't exist yet
  if (updated.status === "confirmed") {
    const existingCheckin = db
      .prepare("SELECT id FROM checkins WHERE event_id = ? AND rider_id = ? LIMIT 1")
      .get(updated.event_id as number, updated.rider_id as number);
    if (!existingCheckin) {
      db.prepare(
        `INSERT INTO checkins (event_id, rider_id, race_class, bib_number, checked_in, rfid_linked, created_at)
         VALUES (?, ?, ?, ?, 0, 0, datetime('now'))`
      ).run(updated.event_id, updated.rider_id, updated.race_class, updated.bib_number ?? null);
    }
  }

  return res.json(deserializeReg(updated));
});

// ── Public: look up a rider by email (walk-up registration pre-fill) ─────────
router.get("/public/riders/lookup", (req, res) => {
  const email = ((req.query.email as string) || "").trim().toLowerCase();
  if (!email) return res.status(400).json({ error: "email required" });

  const db = getDb();
  const rider = db
    .prepare("SELECT * FROM riders WHERE lower(email) = ? LIMIT 1")
    .get(email) as Record<string, unknown> | undefined;

  if (!rider) return res.json({ found: false });

  const lastReg = db
    .prepare(
      `SELECT ama_number, club_id_number, bike_brand, bike_model, bike_year, bib_number, sponsors
       FROM registrations WHERE rider_id = ? ORDER BY created_at DESC LIMIT 1`,
    )
    .get(rider.id) as Record<string, unknown> | undefined;

  return res.json({
    found: true,
    firstName: rider.first_name ?? "",
    lastName: rider.last_name ?? "",
    phone: rider.phone ?? "",
    dateOfBirth: rider.date_of_birth ?? "",
    emergencyContact: rider.emergency_contact ?? "",
    emergencyPhone: rider.emergency_phone ?? "",
    streetAddress: rider.street_address ?? "",
    city: rider.city ?? "",
    homeState: rider.home_state ?? "",
    zip: rider.zip ?? "",
    amaNumber: lastReg?.ama_number ?? "",
    clubIdNumber: lastReg?.club_id_number ?? "",
    bikeBrand: lastReg?.bike_brand ?? "",
    bikeModel: lastReg?.bike_model ?? "",
    bikeYear: lastReg?.bike_year ?? "",
    bibNumber: lastReg?.bib_number ? String(lastReg.bib_number) : "",
    sponsors: lastReg?.sponsors ?? "",
  });
});

// ── Public: check if a bib number is already taken for an event ───────────────
// Optional query param: excludeRiderId — rider to exclude (same rider, multiple classes)
router.get("/public/events/:eventId/check-bib", (req, res) => {
  const eventId = Number(req.params.eventId);
  const bib = ((req.query.bib as string) || "").trim();
  if (!bib) return res.status(400).json({ error: "bib required" });
  const excludeRiderId = req.query.excludeRiderId ? Number(req.query.excludeRiderId) : null;

  const db = getDb();
  const existing = excludeRiderId
    ? db.prepare(
        `SELECT id FROM registrations
         WHERE event_id = ? AND bib_number = ? AND status != 'void' AND rider_id != ? LIMIT 1`,
      ).get(eventId, bib, excludeRiderId)
    : db.prepare(
        `SELECT id FROM registrations
         WHERE event_id = ? AND bib_number = ? AND status != 'void' LIMIT 1`,
      ).get(eventId, bib);

  return res.json({ taken: !!existing });
});

// ── Stripe charge — not available on desktop; return graceful error ───────────
router.post("/events/:eventId/registrations/:regId/charge", (req, res) => {
  return res.status(503).json({
    error:
      "Online payment processing is not available in the desktop app. Collect payment manually and mark the registration as paid.",
  });
});

// ── Stripe verify-payment — not available on desktop; return graceful error ───
router.post("/public/registrations/:id/verify-payment", (req, res) => {
  return res.status(503).json({
    error: "Payment verification is not available in the desktop app.",
  });
});

export default router;
