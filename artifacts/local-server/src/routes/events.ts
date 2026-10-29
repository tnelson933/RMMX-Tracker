import { Router } from "express";
import { normalizeActiveTransponderIdentifier } from "@workspace/api-zod";
import { getDb } from "../db";
import { resolveRegistrationRider } from "../registration-rider";
import { markRiderFieldsDirty } from "../rider-profile-dirty";
import { randomUUID } from "node:crypto";
import { includesRmTrackr, RM_TRACKR_OPTION_ID, RM_TRACKR_NAME, RM_TRACKR_PRICE } from "../lib/rm-trackr";

const router = Router();

function computeAutoStatus(event: any): string | null {
  const { status } = event;
  if (!["draft", "registration_open", "registration_closed"].includes(status)) return null;
  const now = new Date();
  const open = event.registration_open ? new Date(event.registration_open) : null;
  const close = event.registration_close ? new Date(event.registration_close) : null;
  let correct: string;
  if (open && now >= open) {
    correct = (!close || now < close) ? "registration_open" : "registration_closed";
  } else {
    correct = "draft";
  }
  // Registration is over once the event date arrives, whether or not a close
  // date was set (matches the cloud API's event status rules).
  if (correct !== "draft") {
    const todayStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
    const eventDateStr = event.date ? String(event.date).substring(0, 10) : null;
    if (eventDateStr && eventDateStr <= todayStr) correct = "race_day";
  }
  return correct !== status ? correct : null;
}

// ── Event input checks: same rules and messages as the cloud's
// api-server/src/lib/validateInput.ts (validateEventInput) and
// lib/rmTrackr.ts (normalizeEventPurchaseOptions). Keep them in step.
const isBlank = (v: unknown) => v === undefined || v === null || v === "";
const EVENT_STATUSES = ["draft", "registration_open", "registration_closed", "race_day", "completed", "results_published"];

function isCalendarDate(value: unknown): boolean {
  if (typeof value !== "string") return false;
  const day = value.substring(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return false;
  const d = new Date(`${day}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().startsWith(day);
}

function validateEventInput(body: Record<string, unknown>): string | null {
  for (const f of ["date", "endDate"]) {
    if (!isBlank(body[f]) && !isCalendarDate(body[f])) return `${f} must be a date like 2026-06-14`;
  }
  for (const f of ["registrationOpen", "registrationClose", "earlyBirdEndsAt"]) {
    if (!isBlank(body[f]) && (typeof body[f] !== "string" || Number.isNaN(new Date(body[f] as string).getTime()))) {
      return `${f} must be a valid date and time`;
    }
  }
  for (const f of ["entryFee", "earlyBirdFee", "transponderRentalFee", "rfidStickerFee"]) {
    if (isBlank(body[f])) continue;
    const n = Number(body[f]);
    if (!Number.isFinite(n) || n < 0) return `${f} must be a dollar amount of 0 or more`;
    if (n > 100_000) return `${f} is too large`;
  }
  if (body.status !== undefined && !EVENT_STATUSES.includes(String(body.status))) {
    return `status must be one of: ${EVENT_STATUSES.join(", ")}`;
  }
  if (!isBlank(body.maxRiders) && (!Number.isInteger(Number(body.maxRiders)) || Number(body.maxRiders) < 1)) {
    return "maxRiders must be a whole number of 1 or more";
  }
  // Date order (only the pairs present in the body).
  const day = (v: unknown) => (isBlank(v) ? null : String(v).substring(0, 10));
  const opens = isBlank(body.registrationOpen) ? null : new Date(String(body.registrationOpen)).getTime();
  const closes = isBlank(body.registrationClose) ? null : new Date(String(body.registrationClose)).getTime();
  if (opens != null && closes != null && closes <= opens) return "Registration must close after it opens";
  const lastDay = day(body.endDate) ?? day(body.date);
  if (closes != null && lastDay && closes > Date.parse(`${lastDay}T23:59:59.999Z`) + 14 * 60 * 60 * 1000) {
    return "Registration can't close after the last race day";
  }
  const earlyEnds = day(body.earlyBirdEndsAt);
  const raceDay = day(body.date);
  if (earlyEnds && raceDay && earlyEnds > raceDay) return "The early sign-up period can't end after the race date";
  if (!isBlank(body.earlyBirdFee) && !isBlank(body.entryFee) && Number(body.earlyBirdFee) >= Number(body.entryFee)) {
    return "The early sign-up fee must be less than the entry fee";
  }
  return checkPurchaseOptions(body.purchaseOptions);
}

function checkPurchaseOptions(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (!Array.isArray(value)) return "purchaseOptions must be a list";
  const ids = new Set<string>();
  for (const o of value) {
    if (!o || typeof o !== "object") return "Each purchase option needs a name and a price";
    const opt = o as Record<string, unknown>;
    const id = isBlank(opt.id) ? null : String(opt.id);
    if (id === RM_TRACKR_OPTION_ID) continue;
    if (typeof opt.name !== "string" || !opt.name.trim()) return "Each purchase option needs a name";
    const amount = typeof opt.amount === "string" && opt.amount.trim() !== "" ? Number(opt.amount) : opt.amount;
    if (typeof amount !== "number" || !Number.isFinite(amount) || amount < 0) {
      return `Purchase option "${opt.name.trim()}" needs a price of $0 or more`;
    }
    if (amount > 100_000) return `Purchase option "${opt.name.trim()}" price is too large`;
    if (id != null) {
      if (ids.has(id)) return "Purchase options must have unique ids";
      ids.add(id);
    }
  }
  return null;
}

/** Keep only { id, name, amount }; the RM TrackR gets its fixed name and price, once. */
function normalizeEventPurchaseOptions(options: unknown): Array<{ id: string; name: string; amount: number }> {
  if (!Array.isArray(options)) return [];
  let hasTrackr = false;
  const out: Array<{ id: string; name: string; amount: number }> = [];
  for (const o of options as Array<Record<string, unknown> | null>) {
    if (!o || typeof o !== "object") continue;
    if (String(o.id) === RM_TRACKR_OPTION_ID) {
      if (hasTrackr) continue;
      hasTrackr = true;
      out.push({ id: RM_TRACKR_OPTION_ID, name: RM_TRACKR_NAME, amount: RM_TRACKR_PRICE });
    } else {
      const id = isBlank(o.id) ? randomUUID() : String(o.id);
      out.push({ id, name: String(o.name ?? "").trim(), amount: Number(o.amount) });
    }
  }
  return out;
}

function serializeEvent(e: any) {
  return {
    id: e.id,
    clubId: e.club_id,
    name: e.name,
    date: e.date,
    location: e.location ?? null,
    state: e.state ?? "",
    trackName: e.track_name ?? null,
    status: e.status,
    raceClasses: (() => { try { return JSON.parse(e.race_classes || "[]"); } catch { return []; } })(),
    registrationOpen: e.registration_open ?? null,
    registrationClose: e.registration_close ?? null,
    paymentEnabled: e.payment_enabled === 1,
    requireAma: e.require_ama === 1,
    entryFee: e.entry_fee != null ? Number(e.entry_fee) : null,
    earlyBirdFee: e.early_bird_fee != null ? Number(e.early_bird_fee) : null,
    earlyBirdEndsAt: e.early_bird_ends_at ?? null,
    maxRiders: e.max_riders ?? null,
    raceClassLimits: (() => { try { return JSON.parse(e.race_class_limits || "{}"); } catch { return {}; } })(),
    purchaseOptions: (() => { try { return JSON.parse(e.purchase_options || "[]"); } catch { return []; } })(),
    imageUrl: e.image_url ?? null,
    timingTechnology: e.timing_technology ?? "rfid",
    transponderRentalEnabled: e.transponder_rental_enabled === 1,
    transponderRentalFee: e.transponder_rental_fee != null ? Number(e.transponder_rental_fee) : null,
    noDuplicateBibs: e.no_duplicate_bibs === 1,
    requireClubId: e.require_club_id === 1,
    rfidStickerFee: e.rfid_sticker_fee != null ? Number(e.rfid_sticker_fee) : null,
    requireWaiver: e.require_waiver === 1,
    // Enforced at check-in: waivers can be signed offline
    // (POST /public/events/:id/liability-waiver/sign, routes/waivers.ts).
    requireLiabilityWaiver: e.require_liability_waiver === 1,
    requireTransponder: e.require_transponder === 1,
    raceClassDetails: (() => { try { return JSON.parse(e.race_class_details || "{}"); } catch { return {}; } })(),
    enduroPenaltyConfig: (() => { try { return e.enduro_penalty_config ? JSON.parse(e.enduro_penalty_config) : null; } catch { return null; } })(),
    scoringTableId: e.scoring_table_id ?? null,
    minLapMs: e.min_lap_ms ?? null,
    amaEventId: e.ama_event_id ?? null,
    raceStyle: e.race_style ?? null,
    endDate: e.end_date ?? null,
    createdAt: e.created_at,
  };
}

// GET /events?clubId=...
router.get("/events", (req, res) => {
  const session = req.session as any;
  if (!session?.userId) return res.status(401).json({ error: "Unauthorized" });
  const db = getDb();

  const { clubId } = req.query;
  let events: any[];
  if (clubId) {
    events = db
      .prepare("SELECT * FROM events WHERE club_id = ? ORDER BY date DESC")
      .all(Number(clubId)) as any[];
  } else {
    // Return events for the user's club
    const user = db
      .prepare("SELECT club_id FROM users WHERE id = ?")
      .get(session.userId) as any;
    events = user?.club_id
      ? (db
          .prepare("SELECT * FROM events WHERE club_id = ? ORDER BY date DESC")
          .all(user.club_id) as any[])
      : [];
  }
  // Auto-advance statuses based on registration dates.
  // NOTE: Only update in-memory — do NOT write to the database here.
  // Writing via UPDATE triggers the _wq_events_update SQLite trigger (no guard
  // is active during a regular API request), which stuffs the event IDs into
  // _write_queue.  Those IDs then appear in pendingIds during the next cloud
  // pull and prevent cloud-created events from ever being upserted locally.
  for (const e of events) {
    const nextStatus = computeAutoStatus(e);
    if (nextStatus) {
      e.status = nextStatus;
    }
  }
  return res.json(events.map(serializeEvent));
});

// POST /events
router.post("/events", (req, res) => {
  const session = req.session as any;
  if (!session?.userId) return res.status(401).json({ error: "Unauthorized" });
  const db = getDb();

  const user = db
    .prepare("SELECT club_id FROM users WHERE id = ?")
    .get(session.userId) as any;
  if (!user?.club_id) {
    return res.status(403).json({ error: "No club associated with account" });
  }

  const invalid = validateEventInput(req.body ?? {});
  if (invalid) return res.status(400).json({ error: invalid });

  const {
    name, date, location, state, trackName, raceClasses,
    registrationOpen, registrationClose, paymentEnabled,
    requireAma, entryFee, earlyBirdFee, earlyBirdEndsAt, maxRiders, raceClassLimits, purchaseOptions,
    timingTechnology, transponderRentalEnabled, transponderRentalFee,
    noDuplicateBibs, requireClubId, scoringTableId, minLapMs, amaEventId, raceStyle, endDate,
    rfidStickerFee, requireWaiver, requireLiabilityWaiver, requireTransponder, raceClassDetails, trackId,
  } = req.body;

  // Drafts need only a name, like the cloud: date defaults to today and state to "TBD".
  const isDraftCreate = req.body.draft === true;
  if (!name) return res.status(400).json({ error: "name is required" });
  if (!isDraftCreate && (!date || !state)) {
    return res.status(400).json({ error: "date and state are required for a full save" });
  }

  // Always store dates as plain YYYY-MM-DD — strip any time component that may
  // arrive from a datetime-local input or ISO timestamp (e.g. "2026-06-23T18:00").
  const now0 = new Date();
  const todayStr = `${now0.getFullYear()}-${String(now0.getMonth() + 1).padStart(2, "0")}-${String(now0.getDate()).padStart(2, "0")}`;
  const cleanDate = date ? String(date).substring(0, 10) : todayStr;
  const cleanState = state ? String(state) : (isDraftCreate ? "TBD" : "");
  const cleanEndDate = endDate ? String(endDate).substring(0, 10) : null;
  if (cleanEndDate && cleanEndDate < cleanDate) return res.status(400).json({ error: "endDate must be on or after date" });

  // A picked library track must be one of this club's.
  const libraryTrack = trackId != null && Number.isInteger(Number(trackId))
    ? db.prepare("SELECT id FROM tracks WHERE id = ? AND club_id = ?").get(Number(trackId), user.club_id) as { id: number } | undefined
    : undefined;
  const timing = timingTechnology === "mylaps" || timingTechnology === "active_transponder" ? "active_transponder" : "rfid";
  const classDetails = raceClassDetails && typeof raceClassDetails === "object" && !Array.isArray(raceClassDetails)
    ? raceClassDetails : {};

  const result = db
    .prepare(
      `INSERT INTO events
         (club_id, name, date, location, state, track_name, race_classes,
          registration_open, registration_close, payment_enabled, require_ama,
          entry_fee, early_bird_fee, early_bird_ends_at, max_riders,
          race_class_limits, purchase_options,
          timing_technology, transponder_rental_enabled, transponder_rental_fee,
          no_duplicate_bibs, require_club_id, scoring_table_id, min_lap_ms,
          ama_event_id, race_style, end_date,
          rfid_sticker_fee, require_waiver, require_liability_waiver, require_transponder,
          race_class_details, track_id, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'draft', datetime('now'))`,
    )
    .run(
      user.club_id, String(name), cleanDate,
      location ?? null, cleanState, trackName ?? null,
      JSON.stringify(raceClasses ?? []),
      registrationOpen ?? null, registrationClose ?? null,
      paymentEnabled ? 1 : 0, requireAma ? 1 : 0,
      entryFee ?? null,
      earlyBirdFee ?? null,
      earlyBirdEndsAt ? String(earlyBirdEndsAt).substring(0, 10) : null,
      maxRiders ?? null,
      JSON.stringify(raceClassLimits ?? {}),
      JSON.stringify(normalizeEventPurchaseOptions(purchaseOptions)),
      timing,
      transponderRentalEnabled ? 1 : 0,
      transponderRentalFee ?? null,
      noDuplicateBibs ? 1 : 0, requireClubId ? 1 : 0,
      scoringTableId ?? null, minLapMs ?? null, amaEventId ?? null, raceStyle ?? "motocross", cleanEndDate ?? null,
      rfidStickerFee ?? null,
      requireWaiver ? 1 : 0, requireLiabilityWaiver ? 1 : 0, requireTransponder ? 1 : 0,
      JSON.stringify(classDetails),
      libraryTrack?.id ?? null,
    );

  const newEventId = Number(result.lastInsertRowid);

  const entryFeesCat = db
    .prepare(
      "SELECT id FROM discount_categories WHERE club_id = ? AND lower(name) = 'entry fees' LIMIT 1",
    )
    .get(user.club_id) as { id: number } | undefined;
  if (entryFeesCat) {
    db.prepare("UPDATE events SET entry_fee_category_id = ? WHERE id = ?").run(
      entryFeesCat.id,
      newEventId,
    );
  }

  const event = db.prepare("SELECT * FROM events WHERE id = ?").get(newEventId) as any;
  return res.status(201).json(serializeEvent(event));
});

// GET /events/:eventId
router.get("/events/:eventId", (req, res) => {
  const session = req.session as any;
  if (!session?.userId) return res.status(401).json({ error: "Unauthorized" });
  const db = getDb();
  const id = Number(req.params.eventId);
  const event = db.prepare("SELECT * FROM events WHERE id = ?").get(id) as any;
  if (!event) return res.status(404).json({ error: "Not found" });
  const nextStatus = computeAutoStatus(event);
  if (nextStatus) {
    db.prepare("UPDATE events SET status = ? WHERE id = ?").run(nextStatus, id);
    event.status = nextStatus;
  }
  return res.json(serializeEvent(event));
});

// PATCH /events/:eventId
router.patch("/events/:eventId", (req, res) => {
  const session = req.session as any;
  if (!session?.userId) return res.status(401).json({ error: "Unauthorized" });
  const db = getDb();
  const id = Number(req.params.eventId);
  const invalid = validateEventInput(req.body ?? {});
  if (invalid) return res.status(400).json({ error: invalid });

  const fieldMap: Record<string, string> = {
    name: "name",
    date: "date",
    location: "location",
    state: "state",
    trackName: "track_name",
    status: "status",
    registrationOpen: "registration_open",
    registrationClose: "registration_close",
    paymentEnabled: "payment_enabled",
    requireAma: "require_ama",
    entryFee: "entry_fee",
    maxRiders: "max_riders",
    timingTechnology: "timing_technology",
    transponderRentalEnabled: "transponder_rental_enabled",
    transponderRentalFee: "transponder_rental_fee",
    noDuplicateBibs: "no_duplicate_bibs",
    requireClubId: "require_club_id",
    scoringTableId: "scoring_table_id",
    entryFeeCategoryId: "entry_fee_category_id",
    minLapMs: "min_lap_ms",
    imageUrl: "image_url",
    amaEventId: "ama_event_id",
    raceStyle: "race_style",
    endDate: "end_date",
  };

  const jsonFields: Record<string, string> = {
    raceClasses: "race_classes",
    raceClassLimits: "race_class_limits",
    purchaseOptions: "purchase_options",
  };

  const boolFields: Record<string, string> = {
    paymentEnabled: "payment_enabled",
    requireAma: "require_ama",
    transponderRentalEnabled: "transponder_rental_enabled",
    noDuplicateBibs: "no_duplicate_bibs",
    requireClubId: "require_club_id",
  };

  const fields: string[] = [];
  const values: unknown[] = [];

  // Date-only fields must be stored as YYYY-MM-DD — strip any time component.
  const dateOnlyFields = new Set(["date", "endDate"]);

  for (const [jsKey, dbCol] of Object.entries(fieldMap)) {
    if (req.body[jsKey] !== undefined) {
      if (boolFields[jsKey]) {
        fields.push(`${dbCol} = ?`);
        values.push(req.body[jsKey] ? 1 : 0);
      } else {
        const raw = req.body[jsKey];
        fields.push(`${dbCol} = ?`);
        values.push(dateOnlyFields.has(jsKey) && typeof raw === "string" ? raw.substring(0, 10) : raw);
      }
    }
  }

  for (const [jsKey, dbCol] of Object.entries(jsonFields)) {
    if (req.body[jsKey] !== undefined) {
      fields.push(`${dbCol} = ?`);
      values.push(JSON.stringify(jsKey === "purchaseOptions" ? normalizeEventPurchaseOptions(req.body[jsKey]) : req.body[jsKey]));
    }
  }

  if (fields.length === 0) {
    return res.status(400).json({ error: "No fields to update" });
  }

  values.push(id);
  db.prepare(`UPDATE events SET ${fields.join(", ")} WHERE id = ?`).run(
    ...(values as any[]),
  );

  const event = db.prepare("SELECT * FROM events WHERE id = ?").get(id) as any;
  if (!event) return res.status(404).json({ error: "Not found" });
  const nextStatus = computeAutoStatus(event);
  if (nextStatus) {
    db.prepare("UPDATE events SET status = ? WHERE id = ?").run(nextStatus, id);
    event.status = nextStatus;
  }
  return res.json(serializeEvent(event));
});

// DELETE /events/:eventId
router.delete("/events/:eventId", (req, res) => {
  const session = req.session as any;
  if (!session?.userId) return res.status(401).json({ error: "Unauthorized" });
  const db = getDb();
  const id = Number(req.params.eventId);
  const event = db.prepare("SELECT id FROM events WHERE id = ?").get(id);
  if (!event) return res.status(404).json({ error: "Not found" });
  // Signed liability waivers are legal records and are never deleted, so an
  // event that has any is kept (the cloud refuses the same delete).
  const signedWaiver = db
    .prepare("SELECT 1 FROM liability_waiver_signatures WHERE event_id = ? LIMIT 1")
    .get(id);
  if (signedWaiver) {
    return res.status(409).json({ error: "This event has signed liability waivers, so it can't be deleted." });
  }
  db.prepare("DELETE FROM enduro_checkpoint_arrivals WHERE event_id = ?").run(id);
  db.prepare("DELETE FROM enduro_time_checks WHERE event_id = ?").run(id);
  db.prepare("DELETE FROM event_reader_assignments WHERE event_id = ?").run(id);
  db.prepare("DELETE FROM race_results WHERE event_id = ?").run(id);
  db.prepare("DELETE FROM lap_crossings WHERE event_id = ?").run(id);
  db.prepare("DELETE FROM motos WHERE event_id = ?").run(id);
  db.prepare("DELETE FROM checkins WHERE event_id = ?").run(id);
  db.prepare("DELETE FROM registrations WHERE event_id = ?").run(id);
  db.prepare("DELETE FROM rfid_assignments WHERE event_id = ?").run(id);
  db.prepare("DELETE FROM event_publication WHERE event_id = ?").run(id);
  db.prepare("DELETE FROM events WHERE id = ?").run(id);
  return res.status(204).send();
});

// POST /events/:eventId/registrations
router.post("/events/:eventId/registrations", (req, res) => {
  const session = req.session as any;
  if (!session?.userId) return res.status(401).json({ error: "Unauthorized" });
  const db = getDb();
  const eventId = Number(req.params.eventId);

  const {
    firstName, lastName, email, phone, dateOfBirth,
    emergencyContact, emergencyPhone, streetAddress, city, homeState, zip,
    raceClass, bibNumber, amaNumber, clubIdNumber, bikeBrand, bikeModel, bikeYear,
    sponsors,
    transponderNumber, rentTransponder, selectedPurchaseOptions,
    paymentMethod, amountPaid, status,
    riderId: explicitRiderId,
  } = req.body;

  if (!raceClass) return res.status(400).json({ error: "raceClass is required" });
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
      error: "Active transponder number must be 1–9 hexadecimal characters",
    });
  }

  const resolution = resolveRegistrationRider(db, {
    ...req.body,
    riderId: explicitRiderId,
  });
  if ("error" in resolution) {
    return res.status(resolution.status).json({ error: resolution.error });
  }
  const { riderId } = resolution;

  const resolvedStatus = status ?? "confirmed";
  // An explicit payment method means the organizer collected payment on-site (cash / waived / other)
  const resolvedPaymentStatus = paymentMethod ? "paid" : "unpaid";

  const result = db.prepare(
    `INSERT INTO registrations (event_id, rider_id, race_class, bib_number, ama_number, club_id_number,
       bike_brand, bike_model, bike_year, sponsors, mylaps_transponder_number, transponder_rental,
       selected_purchase_options, payment_method, amount_paid, payment_status, status, rm_trackr_purchased, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))`
  ).run(
    eventId, riderId, String(raceClass),
    bibNumber ?? null, amaNumber ?? null, clubIdNumber ?? null,
    bikeBrand ?? null, bikeModel ?? null, bikeYear ?? null, sponsors ?? null,
    normalizedTransponderNumber,
    rentTransponder ? 1 : 0,
    JSON.stringify(selectedPurchaseOptions || []),
    paymentMethod ?? null,
    amountPaid ?? null,
    resolvedPaymentStatus,
    resolvedStatus,
    includesRmTrackr(selectedPurchaseOptions) ? 1 : 0,
  );

  const reg = db.prepare("SELECT * FROM registrations WHERE id = ?").get(Number(result.lastInsertRowid)) as any;
  if (normalizedTransponderNumber) {
    db.prepare(
      "UPDATE riders SET mylaps_transponder_id = ? WHERE id = ?",
    ).run(normalizedTransponderNumber, riderId);
    markRiderFieldsDirty(db, riderId, ["mylapsTransponderId"]);
  }
  const rider = db.prepare("SELECT first_name, last_name FROM riders WHERE id = ?").get(riderId) as any;
  const riderName = rider ? `${rider.first_name ?? ""} ${rider.last_name ?? ""}`.trim() : "";

  // Create a checkin record for confirmed registrations so the rider appears in the check-in list
  // and the write-queue trigger fires to sync the checkin to cloud
  if (resolvedStatus === "confirmed") {
    const existingCheckin = db
      .prepare("SELECT id FROM checkins WHERE event_id = ? AND rider_id = ? LIMIT 1")
      .get(eventId, riderId);
    if (!existingCheckin) {
      db.prepare(
        `INSERT INTO checkins (event_id, rider_id, race_class, bib_number, checked_in, rfid_linked, created_at)
         VALUES (?, ?, ?, ?, 0, 0, datetime('now'))`
      ).run(eventId, riderId, String(raceClass), bibNumber ?? null);
    }
  }

  return res.status(201).json({
    id: reg.id,
    eventId: reg.event_id,
    riderId: reg.rider_id,
    riderName,
    raceClass: reg.race_class,
    status: reg.status,
    paymentStatus: reg.payment_status ?? "unpaid",
    paymentMethod: reg.payment_method ?? null,
    amountPaid: reg.amount_paid ?? null,
    bibNumber: reg.bib_number ?? null,
    amaNumber: reg.ama_number ?? null,
    bikeBrand: reg.bike_brand ?? null,
    bikeModel: reg.bike_model ?? null,
    bikeYear: reg.bike_year ?? null,
    createdAt: reg.created_at,
  });
});

// GET /events/:eventId/raceday-summary (canonical name per OpenAPI spec)
router.get("/events/:eventId/raceday-summary", (req, res) => {
  return raceday_summary_handler(req, res);
});

// Also keep legacy hyphenated name for any old cached calls
router.get("/events/:eventId/race-day-summary", (req, res) => {
  return raceday_summary_handler(req, res);
});

function raceday_summary_handler(req: any, res: any) {
  const db = getDb();
  const eventId = Number(req.params.eventId);

  const event = db.prepare("SELECT id, name FROM events WHERE id = ?").get(eventId) as any;
  if (!event) return res.status(404).json({ error: "Not found" });

  const totalRegistered = (db.prepare(
    "SELECT COUNT(*) as cnt FROM registrations WHERE event_id = ? AND status != 'void'"
  ).get(eventId) as any).cnt;

  const checkedIn = (db.prepare(
    "SELECT COUNT(*) as cnt FROM checkins WHERE event_id = ? AND checked_in = 1"
  ).get(eventId) as any).cnt;

  const rfidLinked = (db.prepare(
    "SELECT COUNT(*) as cnt FROM checkins WHERE event_id = ? AND rfid_linked = 1"
  ).get(eventId) as any).cnt;

  const motosScheduled = (db.prepare(
    "SELECT COUNT(*) as cnt FROM motos WHERE event_id = ?"
  ).get(eventId) as any).cnt;

  const motosCompleted = (db.prepare(
    "SELECT COUNT(*) as cnt FROM motos WHERE event_id = ? AND status = 'completed'"
  ).get(eventId) as any).cnt;

  const classCounts = db.prepare(
    `SELECT r.race_class,
            COUNT(*) as registered,
            SUM(CASE WHEN c.checked_in = 1 THEN 1 ELSE 0 END) as checked_in
     FROM registrations r
     LEFT JOIN checkins c ON c.event_id = r.event_id AND c.rider_id = r.rider_id
     WHERE r.event_id = ? AND r.status != 'void'
     GROUP BY r.race_class
     ORDER BY r.race_class`
  ).all(eventId) as { race_class: string; registered: number; checked_in: number }[];

  const paymentRows = db.prepare(
    `SELECT payment_method, payment_status, amount_paid
     FROM registrations WHERE event_id = ? AND status != 'void'`
  ).all(eventId) as any[];

  let cardTotal = 0, cardCount = 0, cashTotal = 0, cashCount = 0;
  for (const row of paymentRows) {
    if (row.payment_status === "paid") {
      const amt = Number(row.amount_paid ?? 0);
      if (row.payment_method === "cash") {
        cashTotal += amt; cashCount++;
      } else if (row.payment_method === "card") {
        cardTotal += amt; cardCount++;
      }
    }
  }

  return res.json({
    eventId,
    eventName: event.name,
    totalRegistered,
    checkedIn,
    notCheckedIn: totalRegistered - checkedIn,
    rfidLinked,
    motosScheduled,
    motosCompleted,
    classSummary: classCounts.map((c) => ({
      className: c.race_class,
      registered: c.registered,
      checkedIn: c.checked_in,
    })),
    paymentSummary: {
      cardTotal,
      cashTotal,
      totalCollected: cardTotal + cashTotal,
      cardCount,
      cashCount,
    },
  });
}

// GET /clubs/:clubId/unpublished-completed-events
router.get("/clubs/:clubId/unpublished-completed-events", (req, res) => {
  const session = req.session as any;
  if (!session?.userId) return res.status(401).json({ error: "Unauthorized" });

  const db = getDb();
  const clubId = Number(req.params.clubId);

  const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

  const completedEvents = db
    .prepare(
      `SELECT id, name, date, location, track_name, state
       FROM events
       WHERE club_id = ? AND status = 'completed' AND date < ?`,
    )
    .all(clubId, cutoff) as any[];

  if (completedEvents.length === 0) return res.json([]);

  const ids = completedEvents.map((e: any) => e.id);
  const ph = ids.map(() => "?").join(",");
  const published = db
    .prepare(
      `SELECT event_id FROM event_publication
       WHERE event_id IN (${ph}) AND published = 1`,
    )
    .all(...ids) as any[];

  const publishedSet = new Set(published.map((p: any) => p.event_id));
  const unpublished = completedEvents.filter(
    (e: any) => !publishedSet.has(e.id),
  );

  return res.json(
    unpublished.map((e: any) => ({
      id: e.id,
      name: e.name,
      date: e.date,
      location: e.location ?? null,
      trackName: e.track_name ?? null,
      state: e.state ?? null,
    })),
  );
});

export default router;
