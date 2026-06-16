import { Router } from "express";
import { getDb } from "../db";

const router = Router();

function serializeRider(r: any) {
  return {
    id: r.id,
    firstName: r.first_name ?? "",
    lastName: r.last_name ?? "",
    email: r.email ?? null,
    phone: r.phone ?? null,
    bibNumber: r.bib_number ?? null,
    dateOfBirth: r.date_of_birth ?? null,
    emergencyContact: r.emergency_contact ?? null,
    emergencyPhone: r.emergency_phone ?? null,
    rfidNumber: r.rfid_number ?? null,
    streetAddress: r.street_address ?? null,
    city: r.city ?? null,
    homeState: r.home_state ?? null,
    zip: r.zip ?? null,
    bikeManufacturer: r.bike_manufacturer ?? null,
    bikeModel: r.bike_model ?? null,
    bikeYear: r.bike_year ?? null,
    sponsors: r.sponsors ?? null,
    amaNumber: r.ama_number ?? null,
    mylapsTransponderId: r.mylaps_transponder_id ?? null,
    createdAt: r.created_at,
  };
}

// GET /riders?search=...&clubId=...
router.get("/riders", (req, res) => {
  const session = req.session as any;
  if (!session?.userId) return res.status(401).json({ error: "Unauthorized" });

  const db = getDb();
  const { search } = req.query;

  let riders: any[];
  if (search && String(search).trim()) {
    const s = `%${String(search).toLowerCase()}%`;
    riders = db
      .prepare(
        `SELECT * FROM riders
         WHERE lower(first_name || ' ' || last_name) LIKE ?
            OR lower(bib_number) LIKE ?
            OR lower(email) LIKE ?
         ORDER BY last_name ASC, first_name ASC`,
      )
      .all(s, s, s) as any[];
  } else {
    riders = db
      .prepare("SELECT * FROM riders ORDER BY last_name ASC, first_name ASC")
      .all() as any[];
  }
  return res.json(riders.map(serializeRider));
});

// GET /riders/:riderId
router.get("/riders/:riderId", (req, res) => {
  const session = req.session as any;
  if (!session?.userId) return res.status(401).json({ error: "Unauthorized" });

  const db = getDb();
  const id = Number(req.params.riderId);
  const rider = db.prepare("SELECT * FROM riders WHERE id = ?").get(id) as any;
  if (!rider) return res.status(404).json({ error: "Not found" });

  const recentResults = db
    .prepare(
      `SELECT rr.*, m.name AS moto_name, e.name AS event_name
       FROM race_results rr
       LEFT JOIN motos m ON rr.moto_id = m.id
       LEFT JOIN events e ON rr.event_id = e.id
       WHERE rr.rider_id = ?
       ORDER BY rr.id DESC
       LIMIT 20`,
    )
    .all(id) as any[];

  const latestReg = db
    .prepare(
      "SELECT club_id_number FROM registrations WHERE rider_id = ? ORDER BY created_at DESC LIMIT 1",
    )
    .get(id) as any;

  const totalEventsRow = db
    .prepare(
      "SELECT COUNT(DISTINCT event_id) as cnt FROM registrations WHERE rider_id = ?",
    )
    .get(id) as any;

  return res.json({
    ...serializeRider(rider),
    clubIdNumber: latestReg?.club_id_number ?? null,
    totalEvents: totalEventsRow?.cnt ?? 0,
    recentResults: recentResults.map((r: any) => ({
      id: r.id,
      eventId: r.event_id,
      motoId: r.moto_id,
      riderId: r.rider_id,
      raceClass: r.race_class,
      position: r.position,
      totalTime: r.total_time ?? null,
      lapTimes: (() => { try { return JSON.parse(r.lap_times || "[]"); } catch { return []; } })(),
      points: r.points ?? null,
      dnf: r.dnf === 1,
      dns: r.dns === 1,
      motoName: r.moto_name ?? "",
      eventName: r.event_name ?? "",
    })),
  });
});

// POST /riders
router.post("/riders", (req, res) => {
  const session = req.session as any;
  if (!session?.userId) return res.status(401).json({ error: "Unauthorized" });

  const db = getDb();
  const {
    firstName, lastName, email, phone, bibNumber, dateOfBirth,
    emergencyContact, emergencyPhone, rfidNumber, bikeManufacturer,
    bikeModel, bikeYear, sponsors, amaNumber, mylapsTransponderId,
    streetAddress, city, homeState, zip,
  } = req.body;

  if (!firstName || !lastName) {
    return res.status(400).json({ error: "firstName and lastName are required" });
  }

  const result = db
    .prepare(
      `INSERT INTO riders
         (first_name, last_name, email, phone, bib_number, date_of_birth,
          emergency_contact, emergency_phone, rfid_number, bike_manufacturer,
          bike_model, bike_year, sponsors, ama_number, mylaps_transponder_id,
          street_address, city, home_state, zip, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))`,
    )
    .run(
      String(firstName), String(lastName),
      email ?? null, phone ?? null, bibNumber ?? null,
      dateOfBirth ?? null, emergencyContact ?? null, emergencyPhone ?? null,
      rfidNumber ?? null, bikeManufacturer ?? null, bikeModel ?? null,
      bikeYear ?? null, sponsors ?? null, amaNumber ?? null,
      mylapsTransponderId ?? null, streetAddress ?? null, city ?? null,
      homeState ?? null, zip ?? null,
    );

  const rider = db
    .prepare("SELECT * FROM riders WHERE id = ?")
    .get(Number(result.lastInsertRowid)) as any;
  return res.status(201).json(serializeRider(rider));
});

// PATCH /riders/:riderId
router.patch("/riders/:riderId", (req, res) => {
  const session = req.session as any;
  if (!session?.userId) return res.status(401).json({ error: "Unauthorized" });

  const db = getDb();
  const id = Number(req.params.riderId);

  const fieldMap: Record<string, string> = {
    firstName: "first_name",
    lastName: "last_name",
    email: "email",
    phone: "phone",
    bibNumber: "bib_number",
    dateOfBirth: "date_of_birth",
    emergencyContact: "emergency_contact",
    emergencyPhone: "emergency_phone",
    rfidNumber: "rfid_number",
    bikeManufacturer: "bike_manufacturer",
    bikeModel: "bike_model",
    bikeYear: "bike_year",
    sponsors: "sponsors",
    amaNumber: "ama_number",
    mylapsTransponderId: "mylaps_transponder_id",
    streetAddress: "street_address",
    city: "city",
    homeState: "home_state",
    zip: "zip",
  };

  const fields: string[] = [];
  const values: unknown[] = [];

  for (const [jsKey, dbCol] of Object.entries(fieldMap)) {
    if (req.body[jsKey] !== undefined) {
      fields.push(`${dbCol} = ?`);
      values.push(req.body[jsKey]);
    }
  }

  if (fields.length === 0) {
    return res.status(400).json({ error: "No fields to update" });
  }

  values.push(id);
  db.prepare(`UPDATE riders SET ${fields.join(", ")} WHERE id = ?`).run(
    ...(values as any[]),
  );

  const rider = db.prepare("SELECT * FROM riders WHERE id = ?").get(id) as any;
  if (!rider) return res.status(404).json({ error: "Not found" });
  return res.json(serializeRider(rider));
});

export default router;
