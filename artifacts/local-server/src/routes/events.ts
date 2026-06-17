import { Router } from "express";
import { getDb } from "../db";

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
  return correct !== status ? correct : null;
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
    entryFee: e.entry_fee ?? null,
    maxRiders: e.max_riders ?? null,
    raceClassLimits: (() => { try { return JSON.parse(e.race_class_limits || "{}"); } catch { return {}; } })(),
    purchaseOptions: (() => { try { return JSON.parse(e.purchase_options || "[]"); } catch { return []; } })(),
    imageUrl: e.image_url ?? null,
    timingTechnology: e.timing_technology ?? "rfid",
    transponderRentalEnabled: e.transponder_rental_enabled === 1,
    transponderRentalFee: e.transponder_rental_fee ?? null,
    noDuplicateBibs: e.no_duplicate_bibs === 1,
    requireClubId: e.require_club_id === 1,
    scoringTableId: e.scoring_table_id ?? null,
    minLapMs: e.min_lap_ms ?? null,
    amaEventId: e.ama_event_id ?? null,
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
  // Auto-advance statuses based on registration dates
  for (const e of events) {
    const nextStatus = computeAutoStatus(e);
    if (nextStatus) {
      db.prepare("UPDATE events SET status = ? WHERE id = ?").run(nextStatus, e.id);
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

  const {
    name, date, location, state, trackName, raceClasses,
    registrationOpen, registrationClose, paymentEnabled,
    requireAma, entryFee, maxRiders, raceClassLimits, purchaseOptions,
    timingTechnology, transponderRentalEnabled, transponderRentalFee,
    noDuplicateBibs, requireClubId, scoringTableId, minLapMs, amaEventId,
  } = req.body;

  if (!name || !date) {
    return res.status(400).json({ error: "name and date are required" });
  }

  const result = db
    .prepare(
      `INSERT INTO events
         (club_id, name, date, location, state, track_name, race_classes,
          registration_open, registration_close, payment_enabled, require_ama,
          entry_fee, max_riders, race_class_limits, purchase_options,
          timing_technology, transponder_rental_enabled, transponder_rental_fee,
          no_duplicate_bibs, require_club_id, scoring_table_id, min_lap_ms,
          ama_event_id, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'draft', datetime('now'))`,
    )
    .run(
      user.club_id, String(name), String(date),
      location ?? null, state ?? "", trackName ?? null,
      JSON.stringify(raceClasses ?? []),
      registrationOpen ?? null, registrationClose ?? null,
      paymentEnabled ? 1 : 0, requireAma ? 1 : 0,
      entryFee ?? null, maxRiders ?? null,
      JSON.stringify(raceClassLimits ?? {}),
      JSON.stringify(purchaseOptions ?? []),
      timingTechnology ?? "rfid",
      transponderRentalEnabled ? 1 : 0,
      transponderRentalFee ?? null,
      noDuplicateBibs ? 1 : 0, requireClubId ? 1 : 0,
      scoringTableId ?? null, minLapMs ?? null, amaEventId ?? null,
    );

  const event = db
    .prepare("SELECT * FROM events WHERE id = ?")
    .get(Number(result.lastInsertRowid)) as any;
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

  for (const [jsKey, dbCol] of Object.entries(fieldMap)) {
    if (req.body[jsKey] !== undefined) {
      if (boolFields[jsKey]) {
        fields.push(`${dbCol} = ?`);
        values.push(req.body[jsKey] ? 1 : 0);
      } else {
        fields.push(`${dbCol} = ?`);
        values.push(req.body[jsKey]);
      }
    }
  }

  for (const [jsKey, dbCol] of Object.entries(jsonFields)) {
    if (req.body[jsKey] !== undefined) {
      fields.push(`${dbCol} = ?`);
      values.push(JSON.stringify(req.body[jsKey]));
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
    myLapsTransponderNumber, rentTransponder, selectedPurchaseOptions,
    paymentMethod, amountPaid, status,
    riderId: explicitRiderId,
  } = req.body;

  if (!raceClass) return res.status(400).json({ error: "raceClass is required" });

  let riderId: number;

  if (explicitRiderId) {
    riderId = Number(explicitRiderId);
  } else {
    if (!firstName || !lastName) return res.status(400).json({ error: "firstName and lastName are required" });

    const existing = email
      ? (db.prepare("SELECT id FROM riders WHERE LOWER(email) = LOWER(?)").get(String(email)) as any)
      : null;

    if (existing) {
      riderId = existing.id;
      if (firstName || lastName || phone) {
        db.prepare(
          "UPDATE riders SET first_name = ?, last_name = ?, email = ?, phone = ? WHERE id = ?"
        ).run(
          String(firstName).trim(), String(lastName).trim(),
          email ? String(email).trim() : null,
          phone ? String(phone).trim() : null,
          riderId,
        );
      }
    } else {
      const rr = db.prepare(
        `INSERT INTO riders (first_name, last_name, email, phone, date_of_birth,
           emergency_contact, emergency_phone, street_address, city, home_state, zip, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))`
      ).run(
        String(firstName).trim(), String(lastName).trim(),
        email ? String(email).trim() : null,
        phone ? String(phone).trim() : null,
        dateOfBirth ?? null,
        emergencyContact ?? null, emergencyPhone ?? null,
        streetAddress ?? null, city ?? null, homeState ?? null, zip ?? null,
      );
      riderId = Number(rr.lastInsertRowid);
    }
  }

  const resolvedStatus = status ?? "confirmed";
  // An explicit payment method means the organizer collected payment on-site (cash / waived / other)
  const resolvedPaymentStatus = paymentMethod ? "paid" : "unpaid";

  const result = db.prepare(
    `INSERT INTO registrations (event_id, rider_id, race_class, bib_number, ama_number, club_id_number,
       bike_brand, bike_model, bike_year, mylaps_transponder_number, transponder_rental,
       payment_method, amount_paid, payment_status, status, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))`
  ).run(
    eventId, riderId, String(raceClass),
    bibNumber ?? null, amaNumber ?? null, clubIdNumber ?? null,
    bikeBrand ?? null, bikeModel ?? null, bikeYear ?? null,
    myLapsTransponderNumber ?? null,
    rentTransponder ? 1 : 0,
    paymentMethod ?? null,
    amountPaid ?? null,
    resolvedPaymentStatus,
    resolvedStatus,
  );

  const reg = db.prepare("SELECT * FROM registrations WHERE id = ?").get(Number(result.lastInsertRowid)) as any;
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
