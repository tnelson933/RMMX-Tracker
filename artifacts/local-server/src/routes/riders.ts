import { Router } from "express";
import { normalizeActiveTransponderIdentifier } from "@workspace/api-zod";
import { getDb } from "../db";
import { isoTime, parseJson } from "../lib/cloud-shape";
import { markNewRiderDirty, markRiderFieldsDirty } from "../rider-profile-dirty";
import {
  addRiderTransponder,
  listRiderTransponders,
  listTranspondersForRiders,
  parseTransponderInput,
  removeRiderTransponder,
  riderIdForTransponder,
  TRANSPONDER_KIND_NAMES,
  type TransponderKind,
} from "../lib/rider-transponders";

const router = Router();

/** A profile number another rider already owns, as the message to show; null when free. */
function profileNumberTaken(db: ReturnType<typeof getDb>, riderId: number | null, number: unknown, kind: TransponderKind): string | null {
  const n = typeof number === "string" ? number.trim().toLowerCase() : "";
  if (!n) return null;
  const owner = riderIdForTransponder(db, n);
  if (owner == null || owner === riderId) return null;
  const o = db.prepare("SELECT first_name, last_name FROM riders WHERE id = ?").get(owner) as { first_name: string | null; last_name: string | null } | undefined;
  const name = o ? [o.first_name, o.last_name].filter(Boolean).join(" ") : "another rider";
  return `${TRANSPONDER_KIND_NAMES[kind]} ${n.toUpperCase()} is already assigned to ${name} (rider #${owner}). Remove it from their profile first if it changed hands.`;
}

function serializeRider(r: any, transponders?: unknown[]) {
  return {
    // Every RM TrackR / sticker the rider owns (several per rider), as the cloud returns it.
    transponders: transponders ?? listRiderTransponders(getDb(), r.id),
    // Profile fields the website returns, as last pulled from the cloud.
    clubId: r.club_id ?? null,
    skillLevel: r.skill_level ?? null,
    raceTypes: parseJson<string[] | null>(r.race_types, null),
    aiMaintenanceSuggestions: r.ai_maintenance_suggestions === 1,
    bio: r.bio ?? null,
    plateColor: r.plate_color ?? null,
    profileVisibility: r.profile_visibility ?? null,
    avatarUrl: r.avatar_url ?? null,
    coverUrl: r.cover_url ?? null,
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
    transponderId: r.mylaps_transponder_id ?? null,
    mylapsTransponderId: r.mylaps_transponder_id ?? null,
    createdAt: isoTime(r.created_at),
  };
}

// GET /riders?search=...&clubId=...
router.get("/riders", (req, res) => {
  const session = req.session as any;
  if (!session?.userId) return res.status(401).json({ error: "You're signed out. Sign in again, then try once more." });

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
            OR lower(phone) LIKE ?
         ORDER BY last_name ASC, first_name ASC`,
      )
      .all(s, s, s, s) as any[];
  } else {
    riders = db
      .prepare("SELECT * FROM riders ORDER BY last_name ASC, first_name ASC")
      .all() as any[];
  }
  const owned = listTranspondersForRiders(db, riders.map((r) => r.id));
  return res.json(riders.map((r) => serializeRider(r, owned.get(r.id) ?? [])));
});

// GET /riders/:riderId
router.get("/riders/:riderId", (req, res) => {
  const session = req.session as any;
  if (!session?.userId) return res.status(401).json({ error: "You're signed out. Sign in again, then try once more." });

  const db = getDb();
  const id = Number(req.params.riderId);
  const rider = db.prepare("SELECT * FROM riders WHERE id = ?").get(id) as any;
  if (!rider) return res.status(404).json({ error: "That item couldn't be found. It may have been deleted. Refresh the page and try again." });

  const recentResults = db
    .prepare(
      `SELECT rr.*, m.name AS moto_name, m.type AS moto_type,
              m.results_finalized_at AS results_finalized_at,
              m.lap_count AS lap_count, m.time_limit_ms AS time_limit_ms,
              e.name AS event_name, e.date AS event_date
       FROM race_results rr
       JOIN motos m ON rr.moto_id = m.id
       JOIN events e ON rr.event_id = e.id
       WHERE rr.rider_id = ? AND m.status = 'completed'
       ORDER BY e.date DESC, rr.id DESC
       LIMIT 10`,
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
    recentResults: recentResults.map((r: any) => {
      const lapTimes = (() => { try { return JSON.parse(r.lap_times || "[]"); } catch { return []; } })();
      const lapCap = r.time_limit_ms ? null : r.lap_count;
      return {
        id: r.id,
        eventId: r.event_id,
        motoId: r.moto_id,
        riderId: r.rider_id,
        raceClass: r.race_class,
        position: r.position,
        totalTime: r.total_time ?? null,
        lapTimes: Array.isArray(lapTimes) && lapCap != null && lapCap > 0 ? lapTimes.slice(0, lapCap) : lapTimes,
        points: r.points ?? null,
        dnf: r.dnf === 1,
        dns: r.dns === 1,
        bibNumber: r.bib_number ?? null,
        motoName: r.moto_name ?? "",
        eventName: r.event_name ?? "",
        eventDate: r.event_date ?? null,
        official: r.results_finalized_at != null || r.moto_type === "practice",
      };
    }),
  });
});

// POST /riders
router.post("/riders", (req, res) => {
  const session = req.session as any;
  if (!session?.userId) return res.status(401).json({ error: "You're signed out. Sign in again, then try once more." });

  const db = getDb();
  const {
    firstName, lastName, email, phone, bibNumber, dateOfBirth,
    emergencyContact, emergencyPhone, rfidNumber, bikeManufacturer,
    bikeModel, bikeYear, sponsors, amaNumber, transponderId,
    streetAddress, city, homeState, zip,
  } = req.body;

  if (!firstName || !lastName) {
    return res.status(400).json({ error: "Enter the rider's first and last name." });
  }
  const rawTransponderId = transponderId ?? req.body.mylapsTransponderId;
  const normalizedTransponderId =
    normalizeActiveTransponderIdentifier(rawTransponderId);
  const hasNonblankTransponder =
    rawTransponderId != null &&
    (typeof rawTransponderId !== "string" || rawTransponderId.trim() !== "");
  if (hasNonblankTransponder && !normalizedTransponderId) {
    return res.status(400).json({
      error: "Enter the ID printed on the transponder (up to 9 numbers or letters A–F).",
    });
  }

  const takenTrackr = profileNumberTaken(db, null, normalizedTransponderId, "trackr");
  if (takenTrackr) return res.status(409).json({ error: takenTrackr });
  const takenRfid = profileNumberTaken(db, null, rfidNumber, "rfid");
  if (takenRfid) return res.status(409).json({ error: takenRfid });

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
      normalizedTransponderId, streetAddress ?? null, city ?? null,
      homeState ?? null, zip ?? null,
    );

  const rider = db
    .prepare("SELECT * FROM riders WHERE id = ?")
    .get(Number(result.lastInsertRowid)) as any;
  markNewRiderDirty(db, Number(result.lastInsertRowid));
  return res.status(201).json(serializeRider(rider));
});

// PATCH /riders/:riderId
router.patch("/riders/:riderId", (req, res) => {
  const session = req.session as any;
  if (!session?.userId) return res.status(401).json({ error: "You're signed out. Sign in again, then try once more." });

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
    transponderId: "mylaps_transponder_id",
    streetAddress: "street_address",
    city: "city",
    homeState: "home_state",
    zip: "zip",
  };

  const fields: string[] = [];
  const values: unknown[] = [];
  const hasTransponderUpdate =
    req.body.transponderId !== undefined ||
    req.body.mylapsTransponderId !== undefined;
  const rawTransponderId =
    req.body.transponderId !== undefined
      ? req.body.transponderId
      : req.body.mylapsTransponderId;
  const normalizedTransponderId =
    normalizeActiveTransponderIdentifier(rawTransponderId);
  const hasNonblankTransponder =
    rawTransponderId != null &&
    (typeof rawTransponderId !== "string" || rawTransponderId.trim() !== "");
  if (hasTransponderUpdate && hasNonblankTransponder && !normalizedTransponderId) {
    return res.status(400).json({
      error: "Enter the ID printed on the transponder (up to 9 numbers or letters A–F).",
    });
  }

  for (const [jsKey, dbCol] of Object.entries(fieldMap)) {
    if (req.body[jsKey] !== undefined) {
      fields.push(`${dbCol} = ?`);
      values.push(
        jsKey === "transponderId"
          ? normalizedTransponderId
          : req.body[jsKey],
      );
    }
  }
  // Accept the former API alias while storing it in the unchanged legacy column.
  if (req.body.mylapsTransponderId !== undefined && req.body.transponderId === undefined) {
    fields.push("mylaps_transponder_id = ?");
    values.push(normalizedTransponderId);
  }

  if (fields.length === 0) {
    return res.status(400).json({ error: "No fields to update" });
  }
  const takenTrackr = hasTransponderUpdate ? profileNumberTaken(db, id, normalizedTransponderId, "trackr") : null;
  if (takenTrackr) return res.status(409).json({ error: takenTrackr });
  const takenRfid = profileNumberTaken(db, id, req.body.rfidNumber, "rfid");
  if (takenRfid) return res.status(409).json({ error: takenRfid });

  values.push(id);
  db.prepare(`UPDATE riders SET ${fields.join(", ")} WHERE id = ?`).run(
    ...(values as any[]),
  );

  const rider = db.prepare("SELECT * FROM riders WHERE id = ?").get(id) as any;
  if (!rider) return res.status(404).json({ error: "That item couldn't be found. It may have been deleted. Refresh the page and try again." });
  markRiderFieldsDirty(db, id, fields.map((field) => field.split(" ")[0]));
  return res.json(serializeRider(rider));
});

// ── A rider's transponders (several RM TrackRs / RFID stickers, e.g. one per bike) ──
// Same paths and replies as the cloud. Edits go to the cloud with the next sync.
function riderForTransponders(req: any, res: any): number | null {
  if (!req.session?.userId) { res.status(401).json({ error: "You're signed out. Sign in again, then try once more." }); return null; }
  const id = Number(req.params.riderId);
  if (!Number.isInteger(id) || id <= 0) { res.status(400).json({ error: "This link looks broken. Go back and open it again from the list." }); return null; }
  if (!getDb().prepare("SELECT 1 FROM riders WHERE id = ?").get(id)) {
    res.status(404).json({ error: "That rider couldn't be found. They may have been deleted. Refresh the page and try again." });
    return null;
  }
  return id;
}

router.get("/riders/:riderId/transponders", (req, res) => {
  const id = riderForTransponders(req, res);
  if (id == null) return;
  return res.json(listRiderTransponders(getDb(), id));
});

router.post("/riders/:riderId/transponders", (req, res) => {
  const id = riderForTransponders(req, res);
  if (id == null) return;
  const input = parseTransponderInput(req.body ?? {});
  if (!input.ok) return res.status(400).json({ error: input.error });
  const db = getDb();
  const result = addRiderTransponder(db, id, input);
  if (!result.ok) return res.status(409).json({ error: result.error, ownerRiderId: result.ownerRiderId });
  markRiderFieldsDirty(db, id, ["transponders"]);
  return res.status(result.created ? 201 : 200).json(result.transponders);
});

router.delete("/riders/:riderId/transponders/:transponderId", (req, res) => {
  const id = riderForTransponders(req, res);
  if (id == null) return;
  const db = getDb();
  const remaining = removeRiderTransponder(db, id, Number(req.params.transponderId));
  if (!remaining) return res.status(404).json({ error: "That transponder isn't on this rider's profile any more. Refresh the page." });
  markRiderFieldsDirty(db, id, ["transponders"]);
  return res.json(remaining);
});

export default router;
