import { Router } from "express";
import { normalizeActiveTransponderIdentifier, parseCashTendered } from "@workspace/api-zod";
import { getDb, parseBool, parseJsonArr } from "../db";
import { resolveRegistrationRider } from "../registration-rider";
import { markRiderFieldsDirty } from "../rider-profile-dirty";
import { registrationJson } from "../lib/registration-json";
import { maskDateOfBirth, maskName, maskPhone, maskStreet, maskZip } from "../lib/privacyMask";
import { addRiderTransponderIfFree } from "../lib/rider-transponders";

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
    transponderNumber: r.mylaps_transponder_number,
    myLapsTransponderNumber: r.mylaps_transponder_number,
    clubIdNumber: r.club_id_number,
    amountPaid: r.amount_paid != null ? Number(r.amount_paid) : null,
    paymentMethod: r.payment_method,
    cashTendered: r.cash_tendered ?? null,
    cashChange: r.cash_change ?? null,
    statsEmailOptIn: parseBool(r.stats_email_opt_in as number),
    transponderRental: parseBool(r.transponder_rental as number),
    selectedPurchaseOptions: parseJsonArr(r.selected_purchase_options as string),
    displayFirstName: r.display_first_name,
    displayLastName: r.display_last_name,
    // Group race: the captain's entry carries the team name (the form skips re-entering the team).
    teamName: r.team_name ?? null,
    createdAt: r.created_at,
  };
}

router.get("/events/:eventId/registrations", (req, res) => {
  const userId = (req.session as any).userId;
  if (!userId) return res.status(401).json({ error: "You're signed out. Sign in again, then try once more." });

  const eventId = Number(req.params.eventId);
  const db = getDb();

  const rows = db
    .prepare(
      `SELECT
        r.*,
        ri.first_name, ri.last_name, ri.email AS rider_email, ri.phone,
        ri.date_of_birth, ri.emergency_contact, ri.emergency_phone,
        -- One RFID sticker per rider (the most recent): a rider with several
        -- assignment rows must not repeat the entry. A rental link (with an
        -- expiry) isn't a sticker. Same rule as the cloud.
        (SELECT ra.rfid_number FROM rfid_assignments ra
          WHERE ra.rider_id = r.rider_id AND ra.event_id = r.event_id AND ra.expires_at IS NULL
          ORDER BY ra.id DESC LIMIT 1) AS assigned_rfid_number
       FROM registrations r
       LEFT JOIN riders ri ON r.rider_id = ri.id
       WHERE r.event_id = ?
       ORDER BY r.created_at, r.id`,
    )
    .all(eventId) as Record<string, unknown>[];

  return res.json(
    rows.map((r) => ({
      ...deserializeReg(r),
      rfidNumber: r.assigned_rfid_number ?? null,
      // A name set on the entry itself wins over the rider profile's (like the cloud).
      riderName: `${r.display_first_name ?? r.first_name ?? ""} ${r.display_last_name ?? r.last_name ?? ""}`,
      firstName: r.display_first_name ?? r.first_name ?? "",
      lastName: r.display_last_name ?? r.last_name ?? "",
      email: r.rider_email ?? "",
      phone: r.phone ?? "",
      dateOfBirth: r.date_of_birth ?? "",
      emergencyContact: r.emergency_contact ?? "",
      emergencyPhone: r.emergency_phone ?? "",
      waiverAcknowledgedAt: r.waiver_acknowledged_at ?? null,
    })),
  );
});

router.post("/events/:eventId/registrations", (req, res) => {
  const userId = (req.session as any).userId;
  if (!userId) return res.status(401).json({ error: "You're signed out. Sign in again, then try once more." });

  const eventId = Number(req.params.eventId);
  const {
    firstName, lastName, email, phone, dateOfBirth, emergencyContact, emergencyPhone,
    streetAddress, city, homeState, zip,
    raceClass, bibNumber, amaNumber, clubIdNumber, bikeBrand, bikeModel, bikeYear,
    sponsors, rentTransponder,
    transponderNumber, selectedPurchaseOptions,
    paymentMethod, amountPaid, status: reqStatus,
    riderId: explicitRiderId,
  } = req.body;

  if (!raceClass) {
    return res.status(400).json({ error: "Choose a class." });
  }
  const rawTransponderNumber =
    transponderNumber ?? req.body.myLapsTransponderNumber;
  const normalizedTransponderNumber =
    normalizeActiveTransponderIdentifier(rawTransponderNumber);
  const hasNonblankTransponder =
    rawTransponderNumber != null &&
    (typeof rawTransponderNumber !== "string" ||
      rawTransponderNumber.trim() !== "");
  if (hasNonblankTransponder && !normalizedTransponderNumber) {
    return res.status(400).json({
      error: "Enter the ID printed on the transponder (up to 9 numbers or letters A–F).",
    });
  }

  const db = getDb();

  const resolution = resolveRegistrationRider(db, {
    ...req.body,
    riderId: explicitRiderId,
  });
  if ("error" in resolution) {
    return res.status(resolution.status).json({ error: resolution.error });
  }
  const { riderId, rider } = resolution;
  const finalStatus = reqStatus || "confirmed";
  const hasPaid =
    paymentMethod && amountPaid != null && parseFloat(String(amountPaid)) >= 0;
  const finalPaymentStatus = hasPaid ? "paid" : "unpaid";

  const regResult = db
    .prepare(
      `INSERT INTO registrations
         (event_id, rider_id, race_class, status, payment_status, payment_method, amount_paid,
           bib_number, ama_number, club_id_number, bike_brand, bike_model, bike_year, sponsors,
           transponder_rental, mylaps_transponder_number,
          selected_purchase_options, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))`,
    )
    .run(
      eventId, riderId, raceClass, finalStatus, finalPaymentStatus,
      paymentMethod || null,
      hasPaid ? String(amountPaid) : null,
      bibNumber || null, amaNumber || null, clubIdNumber || null, bikeBrand || null,
      bikeModel || null, bikeYear || null, sponsors || null,
      rentTransponder ? 1 : 0,
      normalizedTransponderNumber,
      JSON.stringify(selectedPurchaseOptions || []),
    );

  const regId = regResult.lastInsertRowid as number;
  if (normalizedTransponderNumber) {
    // Joins the rider's transponders (they may own several); never replaces a saved one
    // or takes one another rider owns (the event entry still times them here).
    if (addRiderTransponderIfFree(db, Number(riderId), normalizedTransponderNumber, "trackr")) markRiderFieldsDirty(db, riderId, ["transponders"]);
  }

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
    riderName: `${rider.first_name ?? ""} ${rider.last_name ?? ""}`.trim(),
    firstName: rider.first_name,
    lastName: rider.last_name,
    email: rider.email,
    phone: rider.phone ?? null,
  });
});

router.patch("/registrations/:registrationId", (req, res) => {
  const userId = (req.session as any).userId;
  if (!userId) return res.status(401).json({ error: "You're signed out. Sign in again, then try once more." });

  const id = Number(req.params.registrationId);
  const {
    status, paymentStatus, raceClass, bibNumber, amountPaid, paymentMethod,
    riderId, displayFirstName, displayLastName,
  } = req.body;
  const hasTransponderUpdate =
    req.body.transponderNumber !== undefined ||
    req.body.myLapsTransponderNumber !== undefined;
  const rawTransponderNumber =
    req.body.transponderNumber !== undefined
      ? req.body.transponderNumber
      : req.body.myLapsTransponderNumber;
  const normalizedTransponderNumber =
    normalizeActiveTransponderIdentifier(rawTransponderNumber);
  const hasNonblankTransponder =
    rawTransponderNumber != null &&
    (typeof rawTransponderNumber !== "string" ||
      rawTransponderNumber.trim() !== "");
  if (hasTransponderUpdate && hasNonblankTransponder && !normalizedTransponderNumber) {
    return res.status(400).json({
      error: "Enter the ID printed on the transponder (up to 9 numbers or letters A–F).",
    });
  }

  // Same input checks and wording as the website.
  const oneOf = (field: string, allowed: string[]) =>
    req.body[field] === undefined || allowed.includes(String(req.body[field])) ? null : `${field} must be one of: ${allowed.join(", ")}`;
  const moneyProblem = (() => {
    if (amountPaid === undefined || amountPaid === null || amountPaid === "") return null;
    const n = Number(amountPaid);
    if (!Number.isFinite(n) || n < 0) return "amountPaid must be a dollar amount of 0 or more";
    return n > 100_000 ? "amountPaid is too large" : null;
  })();
  const invalid = oneOf("status", ["pending", "confirmed", "void"]) ?? oneOf("paymentStatus", ["unpaid", "paid", "refunded"]) ?? moneyProblem;
  if (invalid) return res.status(400).json({ error: invalid });

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
  if (amountPaid !== undefined) { updates.push("amount_paid = ?"); params.push(amountPaid === null || amountPaid === "" ? null : String(amountPaid)); }
  if (paymentMethod !== undefined) { updates.push("payment_method = ?"); params.push(paymentMethod); }
  // Cash at the gate: log what the rider handed over and the change given (same rule as the cloud).
  if (paymentMethod === "cash" && req.body.cashTendered !== undefined) {
    const tender = parseCashTendered(req.body.cashTendered, Number(amountPaid ?? 0));
    if (tender && "error" in tender) return res.status(400).json({ error: tender.error });
    if (tender) {
      updates.push("cash_tendered = ?", "cash_change = ?");
      params.push(tender.tendered.toFixed(2), tender.change.toFixed(2));
    }
  }
  if (riderId !== undefined) { updates.push("rider_id = ?"); params.push(Number(riderId)); }
  if (displayFirstName !== undefined) { updates.push("display_first_name = ?"); params.push(displayFirstName || null); }
  if (displayLastName !== undefined) { updates.push("display_last_name = ?"); params.push(displayLastName || null); }
  if (hasTransponderUpdate) {
    updates.push("mylaps_transponder_number = ?");
    params.push(normalizedTransponderNumber);
  }

  if (updates.length === 0) {
    return res.status(400).json({ error: "No fields to update" });
  }

  params.push(id);
  const db = getDb();
  // The rider and class before the change, to carry it over to check-in and results.
  const before = db.prepare("SELECT rider_id, event_id, race_class FROM registrations WHERE id = ?").get(id) as
    | { rider_id: number; event_id: number; race_class: string }
    | undefined;
  if (!before) return res.status(404).json({ error: "That item couldn't be found. It may have been deleted. Refresh the page and try again." });
  db.prepare(`UPDATE registrations SET ${updates.join(", ")} WHERE id = ?`).run(...(params as any[]));

  const updated = db
    .prepare("SELECT * FROM registrations WHERE id = ?")
    .get(id) as Record<string, unknown> | undefined;

  if (!updated) return res.status(404).json({ error: "That item couldn't be found. It may have been deleted. Refresh the page and try again." });

  // Entry moved to another rider: their check-in row for the event moves too
  // (unless the new rider already has one for that class).
  if (riderId !== undefined && before.rider_id !== Number(riderId)) {
    const toMove = db.prepare("SELECT id, race_class FROM checkins WHERE event_id = ? AND rider_id = ? LIMIT 1")
      .get(before.event_id, before.rider_id) as { id: number; race_class: string } | undefined;
    const targetHas = toMove
      ? db.prepare("SELECT id FROM checkins WHERE event_id = ? AND rider_id = ? AND race_class = ? LIMIT 1").get(before.event_id, Number(riderId), toMove.race_class)
      : undefined;
    if (toMove && !targetHas) db.prepare("UPDATE checkins SET rider_id = ? WHERE id = ?").run(Number(riderId), toMove.id);
  }
  // Class changed: the rider's check-in row and any results follow, as on the website.
  if (raceClass !== undefined && before.race_class && raceClass !== before.race_class) {
    const cascadeRiderId = Number(updated.rider_id);
    const alreadyInNewClass = db.prepare("SELECT id FROM checkins WHERE event_id = ? AND rider_id = ? AND race_class = ? LIMIT 1")
      .get(before.event_id, cascadeRiderId, raceClass);
    if (!alreadyInNewClass) {
      db.prepare("UPDATE checkins SET race_class = ? WHERE event_id = ? AND rider_id = ? AND race_class = ?")
        .run(raceClass, before.event_id, cascadeRiderId, before.race_class);
    }
    db.prepare("UPDATE race_results SET race_class = ? WHERE event_id = ? AND rider_id = ? AND race_class = ?")
      .run(raceClass, before.event_id, cascadeRiderId, before.race_class);
  }
  if (normalizedTransponderNumber) {
    // Joins the rider's transponders (they may own several); never replaces a saved one
    // or takes one another rider owns (the event entry still times them here).
    if (addRiderTransponderIfFree(db, Number(updated.rider_id), normalizedTransponderNumber, "trackr")) markRiderFieldsDirty(db, Number(updated.rider_id), ["transponders"]);
  }

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

  const rider = db.prepare("SELECT first_name, last_name FROM riders WHERE id = ?").get(updated.rider_id as number) as any;
  return res.json({
    ...registrationJson(updated),
    transponderNumber: updated.mylaps_transponder_number ?? null,
    riderName: rider ? `${rider.first_name} ${rider.last_name}` : "",
    amountPaid: updated.amount_paid ? Number(updated.amount_paid) : null,
  });
});

// ── Public: look up a rider by email (walk-up registration pre-fill) ─────────
router.get("/public/riders/lookup", (req, res) => {
  const email = ((req.query.email as string) || "").trim().toLowerCase();
  if (!email) return res.status(400).json({ error: "Enter an email address." });

  const db = getDb();
  const riders = db
    .prepare("SELECT * FROM riders WHERE lower(trim(email)) = ? ORDER BY id ASC")
    .all(email) as Record<string, unknown>[];

  if (!riders.length) {
    return res.json({ found: false, count: 0, riders: [] });
  }

  const latestRegistration = db
    .prepare(
      `SELECT ama_number, club_id_number, bike_brand, bike_model, bike_year,
              bib_number, sponsors, mylaps_transponder_number
       FROM registrations
       WHERE rider_id = ?
       ORDER BY created_at DESC, id DESC
       LIMIT 1`,
    );

  // Contact, DOB, address and emergency details go in full only to the signed-in
  // organizer; a device on the track's network that isn't signed in gets them partly hidden.
  const canSeePrivate = !!(req.session as any)?.userId;
  const priv = (v: unknown, mask: (v: string | null | undefined) => string) =>
    (canSeePrivate ? (v as string | null) ?? "" : mask(v as string | null));

  // Numbers a rider used on a group race team (filed on the team, not their entry).
  const teamRows = db.prepare(
    "SELECT rfid_number, trackr_number, trackr_choice FROM team_members WHERE rider_id = ? ORDER BY updated_at DESC, id DESC",
  );
  const lastTeam = (riderId: unknown) => {
    const last: { rfidNumber: string | null; trackrNumber: string | null } = { rfidNumber: null, trackrNumber: null };
    for (const t of teamRows.all(riderId) as Array<Record<string, any>>) {
      // A rented transponder went back after that event.
      last.rfidNumber = last.rfidNumber ?? t.rfid_number ?? null;
      last.trackrNumber = last.trackrNumber ?? (t.trackr_choice === "rent" ? null : t.trackr_number ?? null);
    }
    return last;
  };

  const result = riders.map((rider) => {
    const lastReg = latestRegistration.get(rider.id) as
      | Record<string, unknown>
      | undefined;
    const team = lastTeam(rider.id);
    return {
      id: rider.id,
      firstName: rider.first_name ?? "",
      lastName: rider.last_name ?? "",
      email: rider.email ?? "",
      /** Some details are partly hidden ("*") for anyone who isn't signed in, as on the website. */
      detailsHidden: !canSeePrivate,
      rfidNumber: rider.rfid_number || team.rfidNumber || "",
      phone: priv(rider.phone, maskPhone),
      dateOfBirth: priv(rider.date_of_birth, maskDateOfBirth),
      emergencyContact: priv(rider.emergency_contact, maskName),
      emergencyPhone: priv(rider.emergency_phone, maskPhone),
      streetAddress: priv(rider.street_address, maskStreet),
      city: rider.city ?? "",
      homeState: rider.home_state ?? "",
      zip: priv(rider.zip, maskZip),
      amaNumber: lastReg?.ama_number ?? rider.ama_number ?? "",
      clubIdNumber: lastReg?.club_id_number ?? "",
      bikeBrand: lastReg?.bike_brand ?? rider.bike_manufacturer ?? "",
      bikeModel: lastReg?.bike_model ?? rider.bike_model ?? "",
      bikeYear: lastReg?.bike_year ?? rider.bike_year ?? "",
      bibNumber:
        lastReg?.bib_number != null
          ? String(lastReg.bib_number)
          : rider.bib_number ?? "",
      sponsors: lastReg?.sponsors ?? rider.sponsors ?? "",
      myLapsTransponderNumber:
        lastReg?.mylaps_transponder_number || rider.mylaps_transponder_id || team.trackrNumber || "",
    };
  });

  return res.json({
    found: true,
    count: result.length,
    riders: result,
  });
});

// Public: classes a rider is already registered for at an event (same answer as the cloud).
router.get("/public/events/:eventId/rider-classes", (req, res) => {
  const eventId = Number(req.params.eventId);
  const riderId = Number(req.query.riderId);
  if (!riderId || isNaN(riderId)) return res.json({ registeredClasses: [] });
  // An unfinished payment doesn't hold the class; registering again clears it.
  const rows = getDb().prepare(
    `SELECT race_class FROM registrations
     WHERE event_id = ? AND rider_id = ? AND COALESCE(status, '') != 'void'
       AND (payment_status = 'paid' OR status = 'confirmed')`,
  ).all(eventId, riderId) as Array<{ race_class: string }>;
  return res.json({ registeredClasses: rows.map(r => r.race_class) });
});

// ── Public: check if a bib number is already taken for an event ───────────────
// Optional query param: excludeRiderId — rider to exclude (same rider, multiple classes)
router.get("/public/events/:eventId/check-bib", (req, res) => {
  const eventId = Number(req.params.eventId);
  const bib = ((req.query.bib as string) || "").trim();
  if (!bib) return res.status(400).json({ error: "Enter a bib number." });
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

// Card charges and Stripe payment verification are not handled locally: the
// cloud pass-through (lib/cloud-proxy.ts) forwards them when online.

export default router;
