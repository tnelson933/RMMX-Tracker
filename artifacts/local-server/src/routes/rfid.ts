import { Router } from "express";
import { getDb, parseJsonArr } from "../db";
import { formatLapTime } from "./timing";

const router = Router();

router.get("/rfid", (req, res) => {
  const userId = (req.session as any).userId;
  if (!userId) return res.status(401).json({ error: "Not authenticated" });

  const db = getDb();
  const user = db
    .prepare("SELECT club_id FROM users WHERE id = ?")
    .get(userId) as { club_id: number } | undefined;
  if (!user) return res.status(401).json({ error: "Not authenticated" });

  const { eventId, riderId } = req.query;

  let sql =
    "SELECT ra.id, ra.rider_id, ra.event_id, ra.rfid_number, ra.assigned_at, " +
    "r.first_name, r.last_name " +
    "FROM rfid_assignments ra " +
    "LEFT JOIN riders r ON r.id = ra.rider_id " +
    "INNER JOIN events e ON e.id = ra.event_id " +
    "WHERE e.club_id = ?";
  const params: (number | string)[] = [user.club_id];

  if (eventId) {
    sql += " AND ra.event_id = ?";
    params.push(Number(eventId));
  }
  if (riderId) {
    sql += " AND ra.rider_id = ?";
    params.push(Number(riderId));
  }

  const rows = db.prepare(sql).all(...params) as Record<string, unknown>[];

  return res.json(
    rows.map((r) => ({
      id: r.id,
      riderId: r.rider_id,
      riderName: `${r.first_name ?? ""} ${r.last_name ?? ""}`.trim(),
      rfidNumber: r.rfid_number,
      eventId: r.event_id,
      assignedAt: r.assigned_at ?? null,
    })),
  );
});

router.post("/rfid", (req, res) => {
  const userId = (req.session as any).userId;
  if (!userId) return res.status(401).json({ error: "Not authenticated" });

  const { riderId, rfidNumber, eventId } = req.body;
  if (!riderId || !rfidNumber) {
    return res.status(400).json({ error: "riderId and rfidNumber required" });
  }

  const db = getDb();
  const numRiderId = Number(riderId);
  const numEventId = eventId ? Number(eventId) : null;

  if (numEventId) {
    const conflict = db
      .prepare(
        "SELECT id FROM rfid_assignments WHERE rfid_number = ? AND event_id = ? AND rider_id != ?",
      )
      .get(rfidNumber, numEventId, numRiderId) as Record<string, unknown> | undefined;

    if (conflict) {
      return res
        .status(409)
        .json({ error: `Tag ${rfidNumber} is already assigned to another rider for this event` });
    }

    const existing = db
      .prepare("SELECT id FROM rfid_assignments WHERE rider_id = ? AND event_id = ?")
      .get(numRiderId, numEventId) as { id: number } | undefined;

    if (existing) {
      db.prepare("UPDATE rfid_assignments SET rfid_number = ? WHERE id = ?").run(
        rfidNumber,
        existing.id,
      );
    } else {
      db.prepare(
        "INSERT INTO rfid_assignments (rider_id, event_id, rfid_number) VALUES (?, ?, ?)",
      ).run(numRiderId, numEventId, rfidNumber);
    }
  }

  db.prepare("UPDATE riders SET rfid_number = ? WHERE id = ?").run(rfidNumber, numRiderId);

  if (numEventId) {
    db.prepare(
      "UPDATE checkins SET rfid_number = ?, rfid_linked = 1 WHERE event_id = ? AND rider_id = ?",
    ).run(rfidNumber, numEventId, numRiderId);
  }

  const assignmentRow = numEventId
    ? (db
        .prepare("SELECT * FROM rfid_assignments WHERE rider_id = ? AND event_id = ? LIMIT 1")
        .get(numRiderId, numEventId) as any)
    : null;

  const rider = db.prepare("SELECT * FROM riders WHERE id = ?").get(numRiderId) as any;
  const riderName = rider
    ? `${rider.first_name ?? ""} ${rider.last_name ?? ""}`.trim()
    : "";

  if (rider) {
    db.prepare(
      "UPDATE practice_crossings SET rider_id = ?, rider_name = ?, bib_number = ? WHERE rfid_number = ? AND rider_id IS NULL",
    ).run(numRiderId, riderName, rider.bib_number ?? null, rfidNumber);

    const unidentifiedMotos = db
      .prepare(
        "SELECT DISTINCT moto_id FROM lap_crossings WHERE rfid_number = ? AND rider_id IS NULL",
      )
      .all(rfidNumber) as { moto_id: number }[];

    if (unidentifiedMotos.length > 0) {
      db.prepare(
        "UPDATE lap_crossings SET rider_id = ? WHERE rfid_number = ? AND rider_id IS NULL",
      ).run(numRiderId, rfidNumber);

      for (const { moto_id } of unidentifiedMotos) {
        const moto = db.prepare("SELECT * FROM motos WHERE id = ?").get(moto_id) as any;
        if (!moto) continue;

        const riderCrossings = db
          .prepare(
            "SELECT * FROM lap_crossings WHERE moto_id = ? AND rider_id = ? ORDER BY crossing_time ASC",
          )
          .all(moto_id, numRiderId) as any[];

        const checkin =
          (db
            .prepare(
              "SELECT bib_number FROM checkins WHERE event_id = ? AND rider_id = ? AND race_class = ? LIMIT 1",
            )
            .get(moto.event_id, numRiderId, moto.race_class) as any) ??
          (db
            .prepare(
              "SELECT bib_number FROM checkins WHERE event_id = ? AND rider_id = ? LIMIT 1",
            )
            .get(moto.event_id, numRiderId) as any);

        const lapTimes = riderCrossings
          .map((c: any) => c.lap_time_ms)
          .filter((t: any): t is number => t !== null && t !== undefined);
        const totalMs = lapTimes.reduce((s: number, t: number) => s + t, 0);

        const existing = db
          .prepare("SELECT * FROM race_results WHERE moto_id = ? AND rider_id = ? LIMIT 1")
          .get(moto_id, numRiderId) as any;

        if (existing) {
          const prevLaps = parseJsonArr<number>(existing.lap_times);
          const merged = prevLaps.length > 0 ? prevLaps : lapTimes;
          const mergedTotal = merged.reduce((s: number, t: number) => s + t, 0);
          db.prepare(
            "UPDATE race_results SET lap_times = ?, total_time = ? WHERE id = ?",
          ).run(
            JSON.stringify(merged),
            merged.length ? formatLapTime(mergedTotal) : null,
            existing.id,
          );
        } else {
          db.prepare(
            `INSERT INTO race_results
               (event_id, moto_id, rider_id, race_class, position, bib_number, lap_times, total_time, dnf, dns)
             VALUES (?, ?, ?, ?, 999, ?, ?, ?, 0, 0)`,
          ).run(
            moto.event_id,
            moto_id,
            numRiderId,
            moto.race_class,
            checkin?.bib_number ?? null,
            JSON.stringify(lapTimes),
            lapTimes.length ? formatLapTime(totalMs) : null,
          );
        }

        const allResults = db
          .prepare("SELECT id, lap_times FROM race_results WHERE moto_id = ?")
          .all(moto_id) as any[];

        const sorted = allResults
          .map((r: any) => {
            const laps = parseJsonArr<number>(r.lap_times);
            return {
              id: r.id,
              laps: laps.length,
              totalMs: laps.reduce((s: number, t: number) => s + t, 0),
            };
          })
          .sort((a, b) => b.laps - a.laps || a.totalMs - b.totalMs);

        const updatePos = db.prepare("UPDATE race_results SET position = ? WHERE id = ?");
        for (let i = 0; i < sorted.length; i++) {
          updatePos.run(i + 1, sorted[i].id);
        }
      }
    }
  }

  return res.status(201).json({
    id: assignmentRow?.id ?? null,
    riderId: numRiderId,
    riderName,
    rfidNumber,
    eventId: numEventId,
    assignedAt: assignmentRow?.assigned_at ?? null,
  });
});

router.post("/rfid/assign", (req, res) => {
  const userId = (req.session as any).userId;
  if (!userId) return res.status(401).json({ error: "Not authenticated" });

  const { riderId, rfidNumber, eventId } = req.body;
  if (!riderId || !rfidNumber) {
    return res.status(400).json({ error: "riderId and rfidNumber required" });
  }

  const db = getDb();
  const numRiderId = Number(riderId);
  const numEventId = eventId ? Number(eventId) : null;

  if (numEventId) {
    const conflict = db
      .prepare(
        "SELECT id FROM rfid_assignments WHERE rfid_number = ? AND event_id = ? AND rider_id != ?",
      )
      .get(rfidNumber, numEventId, numRiderId) as Record<string, unknown> | undefined;

    if (conflict) {
      return res
        .status(409)
        .json({ error: `Tag ${rfidNumber} is already assigned to another rider for this event` });
    }

    const existing = db
      .prepare("SELECT id FROM rfid_assignments WHERE rider_id = ? AND event_id = ?")
      .get(numRiderId, numEventId) as { id: number } | undefined;

    if (existing) {
      db.prepare("UPDATE rfid_assignments SET rfid_number = ? WHERE id = ?").run(
        rfidNumber,
        existing.id,
      );
    } else {
      db.prepare(
        "INSERT INTO rfid_assignments (rider_id, event_id, rfid_number) VALUES (?, ?, ?)",
      ).run(numRiderId, numEventId, rfidNumber);
    }
  }

  db.prepare("UPDATE riders SET rfid_number = ? WHERE id = ?").run(rfidNumber, numRiderId);
  return res.json({ ok: true, riderId: numRiderId, rfidNumber, eventId: numEventId });
});

export default router;
