import { Router } from "express";
import { getDb, parseBool } from "../db";
import { markRiderFieldsDirty } from "../rider-profile-dirty";
import { fulfillRmTrackr } from "../lib/rm-trackr";
import { signedWaiverEmails } from "./waivers";

const router = Router();

router.get("/events/:eventId/checkins", (req, res) => {
  const userId = (req.session as any).userId;
  if (!userId) return res.status(401).json({ error: "Not authenticated" });

  const eventId = Number(req.params.eventId);
  const db = getDb();

  const regs = db
    .prepare(
      `SELECT
        r.id          AS registrationId,
        r.rider_id    AS riderId,
        r.race_class  AS raceClass,
        r.bib_number  AS registrationBib,
        r.mylaps_transponder_number AS transponderNumber,
        r.transponder_rental AS transponderRental,
        r.rfid_sticker_purchased AS rfidStickerPurchased,
        r.rm_trackr_purchased AS rmTrackrPurchased,
        r.rm_trackr_fulfilled_at AS rmTrackrFulfilledAt,
        r.rm_trackr_transponder AS rmTrackrTransponder,
        r.payment_status AS paymentStatus,
        ri.first_name AS firstName,
        ri.last_name  AS lastName,
        ri.email,
        ri.phone
       FROM registrations r
       LEFT JOIN riders ri ON r.rider_id = ri.id
       WHERE r.event_id = ? AND COALESCE(r.status, 'confirmed') != 'void'
       ORDER BY ri.last_name`,
    )
    .all(eventId) as Record<string, unknown>[];

  if (regs.length === 0) return res.json([]);

  const checkinRows = db
    .prepare(
      "SELECT * FROM checkins WHERE event_id = ? ORDER BY id ASC",
    )
    .all(eventId) as Record<string, unknown>[];

  const checkinByRider = new Map<number, Record<string, unknown>>();
  for (const c of checkinRows) {
    const rid = c.rider_id as number;
    if (!checkinByRider.has(rid)) checkinByRider.set(rid, c);
  }

  // Signed waivers (pulled from the cloud or signed here at check-in), matched
  // by rider email the same way the cloud does.
  const signedEmails = signedWaiverEmails(db, eventId);

  return res.json(
    regs.map((r) => {
      const c = checkinByRider.get(r.riderId as number);
      const riderEmail = typeof r.email === "string" ? r.email.toLowerCase() : null;
      const timingNumber = (c?.rfid_number as string | null | undefined) ?? (r.transponderNumber as string | null) ?? null;
      return {
        id: c?.id ?? null,
        eventId,
        riderId: r.riderId,
        registrationId: r.registrationId,
        riderName: `${r.firstName ?? ""} ${r.lastName ?? ""}`.trim(),
        raceClass: r.raceClass,
        registrationBib: r.registrationBib ?? null,
        bibNumber: r.registrationBib ?? (c?.bib_number ?? null),
        email: r.email ?? null,
        phone: r.phone ?? null,
        transponderNumber: r.transponderNumber ?? null,
        myLapsTransponderNumber: r.transponderNumber ?? null,
        transponderRental: parseBool(r.transponderRental as number),
        rfidStickerPurchased: parseBool(r.rfidStickerPurchased as number),
        rmTrackrPurchased: parseBool(r.rmTrackrPurchased as number),
        rmTrackrFulfilledAt: r.rmTrackrFulfilledAt ?? null,
        rmTrackrTransponder: r.rmTrackrTransponder ?? null,
        paymentStatus: r.paymentStatus ?? null,
        checkedIn: parseBool(c?.checked_in as number),
        checkedInAt: c?.checked_in_at ?? null,
        rfidNumber: timingNumber,
        rfidLinked: parseBool(c?.rfid_linked as number) || !!timingNumber,
        waiverSigned: riderEmail ? signedEmails.has(riderEmail) : false,
      };
    }),
  );
});

router.post("/events/:eventId/checkins", (req, res) => {
  const userId = (req.session as any).userId;
  if (!userId) return res.status(401).json({ error: "Not authenticated" });

  const eventId = Number(req.params.eventId);
  const { riderId, rfidNumber, bibNumber, checkedIn } = req.body;
  if (!riderId) return res.status(400).json({ error: "riderId required" });
  // `checkedIn: false` un-checks the rider (e.g. dragging a pool rider to the
  // trash). Any other value, including omitted, checks the rider in.
  const uncheck = checkedIn === false;

  const db = getDb();

  const reg = db
    .prepare(
      "SELECT race_class, bib_number FROM registrations WHERE event_id = ? AND rider_id = ? LIMIT 1",
    )
    .get(eventId, Number(riderId)) as
    | { race_class: string; bib_number: string | null }
    | undefined;

  const raceClass = reg?.race_class ?? "Unknown";
  const regBib = reg?.bib_number ?? null;

  const existing = db
    .prepare(
      "SELECT * FROM checkins WHERE event_id = ? AND rider_id = ? ORDER BY id ASC LIMIT 1",
    )
    .get(eventId, Number(riderId)) as Record<string, unknown> | undefined;

  const now = new Date().toISOString();
  const finalBib =
    bibNumber !== undefined ? bibNumber || null : regBib;

  let checkin: Record<string, unknown>;

  if (uncheck && !existing) {
    // Nothing to un-check: never insert a row just to mark it not checked in.
    return res.json({
      id: null,
      eventId,
      riderId: Number(riderId),
      riderName: "",
      raceClass,
      bibNumber: regBib,
      checkedIn: false,
      checkedInAt: null,
      rfidNumber: null,
      rfidLinked: false,
    });
  }

  if (existing) {
    const updates: string[] = uncheck
      ? ["checked_in = 0", "checked_in_at = NULL"]
      : ["checked_in = 1", "checked_in_at = ?"];
    const params: unknown[] = uncheck ? [] : [now];

    if (rfidNumber !== undefined) {
      updates.push("rfid_number = ?", "rfid_linked = ?");
      params.push(rfidNumber || null, rfidNumber ? 1 : 0);
    }
    if (bibNumber !== undefined) {
      updates.push("bib_number = ?");
      params.push(bibNumber || null);
    }

    params.push(existing.id);
    db.prepare(
      `UPDATE checkins SET ${updates.join(", ")} WHERE id = ?`,
    ).run(...(params as any[]));

    checkin = db
      .prepare("SELECT * FROM checkins WHERE id = ?")
      .get(existing.id) as Record<string, unknown>;
  } else {
    const result = db
      .prepare(
        `INSERT INTO checkins
           (event_id, rider_id, race_class, bib_number, checked_in, checked_in_at, rfid_number, rfid_linked)
         VALUES (?, ?, ?, ?, 1, ?, ?, ?)`,
      )
      .run(
        eventId,
        Number(riderId),
        raceClass,
        finalBib,
        now,
        rfidNumber || null,
        rfidNumber ? 1 : 0,
      );
    checkin = db
      .prepare("SELECT * FROM checkins WHERE id = ?")
      .get(result.lastInsertRowid) as Record<string, unknown>;
  }

  if (rfidNumber) {
    db.prepare("UPDATE riders SET rfid_number = ? WHERE id = ?").run(
      rfidNumber,
      Number(riderId),
    );
    markRiderFieldsDirty(db, Number(riderId), ["rfidNumber"]);
    fulfillRmTrackr(db, eventId, Number(riderId), rfidNumber);
  }

  const bibToSync = checkin.bib_number as string | null;
  if (bibToSync) {
    db.prepare(
      "UPDATE registrations SET bib_number = ? WHERE event_id = ? AND rider_id = ?",
    ).run(bibToSync, eventId, Number(riderId));
  }

  const rider = db
    .prepare("SELECT first_name, last_name FROM riders WHERE id = ?")
    .get(Number(riderId)) as { first_name: string; last_name: string } | undefined;

  return res.json({
    id: checkin.id,
    eventId: checkin.event_id,
    riderId: checkin.rider_id,
    riderName: rider
      ? `${rider.first_name} ${rider.last_name}`
      : "",
    raceClass: checkin.race_class,
    bibNumber: checkin.bib_number,
    checkedIn: parseBool(checkin.checked_in as number),
    checkedInAt: checkin.checked_in_at ?? null,
    rfidNumber: checkin.rfid_number ?? null,
    rfidLinked: parseBool(checkin.rfid_linked as number),
  });
});

export default router;
