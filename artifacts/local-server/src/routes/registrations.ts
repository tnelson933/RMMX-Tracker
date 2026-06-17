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
    amountPaid: r.amount_paid,
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
        ri.first_name, ri.last_name, ri.email AS rider_email, ri.phone
       FROM registrations r
       LEFT JOIN riders ri ON r.rider_id = ri.id
       WHERE r.event_id = ?
       ORDER BY ri.last_name`,
    )
    .all(eventId) as Record<string, unknown>[];

  return res.json(
    rows.map((r) => ({
      ...deserializeReg(r),
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
  const { status, paymentStatus, raceClass, bibNumber, amountPaid, paymentMethod } = req.body;

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

export default router;
