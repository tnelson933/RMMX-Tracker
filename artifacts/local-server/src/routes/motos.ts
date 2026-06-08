import { Router } from "express";
import { getDb, parseJsonArr } from "../db";
import { sseBroadcast, buildLeaderboard } from "./timing";

const router = Router();

function serializeMoto(m: any) {
  return {
    id: m.id,
    eventId: m.event_id,
    name: m.name ?? "",
    type: m.type ?? "moto",
    raceClass: m.race_class,
    motoNumber: m.moto_number,
    scheduledTime: m.scheduled_time ?? null,
    lineup: parseJsonArr(m.lineup),
    lapCount: m.lap_count ?? null,
    status: m.status,
    startedAt: m.started_at ?? null,
    completedAt: m.completed_at ?? null,
    createdAt: m.created_at,
  };
}

// GET /events/:eventId/motos
router.get("/events/:eventId/motos", (req, res) => {
  const db = getDb();
  const eventId = Number(req.params.eventId);
  const motos = db
    .prepare("SELECT * FROM motos WHERE event_id = ? ORDER BY moto_number ASC")
    .all(eventId) as any[];
  return res.json(motos.map(serializeMoto));
});

// POST /events/:eventId/motos
router.post("/events/:eventId/motos", (req, res) => {
  const session = req.session as any;
  if (!session?.userId) return res.status(401).json({ error: "Unauthorized" });
  const db = getDb();
  const eventId = Number(req.params.eventId);
  const { name, type, raceClass, motoNumber, scheduledTime, lineup, lapCount } = req.body;
  if (!name || !type || !raceClass || motoNumber === undefined) {
    return res.status(400).json({ error: "name, type, raceClass, motoNumber required" });
  }
  const result = db.prepare(`
    INSERT INTO motos (event_id, name, type, race_class, moto_number, scheduled_time, lineup, lap_count, status, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'scheduled', datetime('now'))
  `).run(
    eventId, name, type, raceClass, Number(motoNumber),
    scheduledTime ?? null,
    JSON.stringify(lineup ?? []),
    lapCount ? Number(lapCount) : null
  );
  const moto = db.prepare("SELECT * FROM motos WHERE id = ?").get(Number(result.lastInsertRowid)) as any;
  return res.status(201).json(serializeMoto(moto));
});

// PATCH /motos/:motoId — update status, lineup, lapCount, scheduledTime, motoNumber, name
router.patch("/motos/:motoId", (req, res) => {
  const session = req.session as any;
  if (!session?.userId) return res.status(401).json({ error: "Unauthorized" });
  const db = getDb();
  const id = Number(req.params.motoId);

  const fields: string[] = [];
  const values: unknown[] = [];

  if (req.body.status !== undefined) {
    fields.push("status = ?"); values.push(req.body.status);
    if (req.body.status === "in_progress") {
      fields.push("started_at = ?"); values.push(new Date().toISOString());
    }
    if (req.body.status === "completed") {
      fields.push("completed_at = ?"); values.push(new Date().toISOString());
    }
  }
  if (req.body.lineup !== undefined) {
    fields.push("lineup = ?"); values.push(JSON.stringify(req.body.lineup));
  }
  if (req.body.scheduledTime !== undefined) {
    fields.push("scheduled_time = ?"); values.push(req.body.scheduledTime);
  }
  if (req.body.lapCount !== undefined) {
    fields.push("lap_count = ?"); values.push(req.body.lapCount !== null ? Number(req.body.lapCount) : null);
  }
  if (req.body.motoNumber !== undefined) {
    fields.push("moto_number = ?"); values.push(Number(req.body.motoNumber));
  }
  if (req.body.name !== undefined) {
    fields.push("name = ?"); values.push(String(req.body.name));
  }

  if (fields.length === 0) return res.status(400).json({ error: "No fields to update" });

  values.push(id);
  db.prepare(`UPDATE motos SET ${fields.join(", ")} WHERE id = ?`).run(...(values as any[]));

  const moto = db.prepare("SELECT * FROM motos WHERE id = ?").get(id) as any;
  if (!moto) return res.status(404).json({ error: "Not found" });

  if (req.body.status !== undefined) {
    const snapshot = buildLeaderboard(id);
    if (snapshot) sseBroadcast(id, snapshot);
  }

  return res.json(serializeMoto(moto));
});

// DELETE /motos/:motoId
router.delete("/motos/:motoId", (req, res) => {
  const session = req.session as any;
  if (!session?.userId) return res.status(401).json({ error: "Unauthorized" });
  const db = getDb();
  const id = Number(req.params.motoId);
  const result = db.prepare("DELETE FROM motos WHERE id = ?").run(id);
  if (result.changes === 0) return res.status(404).json({ error: "Not found" });
  return res.status(204).send();
});

// GET /motos/:motoId/results — race results for a moto (used by results tab + results entry)
router.get("/motos/:motoId/results", (req, res) => {
  const db = getDb();
  const motoId = Number(req.params.motoId);
  const results = db.prepare(`
    SELECT rr.*, r.first_name, r.last_name
    FROM race_results rr
    LEFT JOIN riders r ON rr.rider_id = r.id
    WHERE rr.moto_id = ?
    ORDER BY rr.position ASC NULLS LAST
  `).all(motoId) as any[];
  return res.json(results.map((r: any) => ({
    id: r.id,
    motoId: r.moto_id,
    eventId: r.event_id,
    riderId: r.rider_id,
    riderName: r.first_name ? `${r.first_name} ${r.last_name ?? ""}`.trim() : null,
    raceClass: r.race_class,
    position: r.position,
    bibNumber: r.bib_number,
    lapTimes: parseJsonArr<number>(r.lap_times),
    totalTime: r.total_time,
    dnf: r.dnf === 1,
    dns: r.dns === 1,
  })));
});

// GET /events/:eventId/race-results — all results for an event (results browser)
router.get("/events/:eventId/race-results", (req, res) => {
  const db = getDb();
  const eventId = Number(req.params.eventId);
  const results = db.prepare(`
    SELECT rr.*, r.first_name, r.last_name, m.name AS moto_name, m.type AS moto_type
    FROM race_results rr
    LEFT JOIN riders r ON rr.rider_id = r.id
    LEFT JOIN motos m ON rr.moto_id = m.id
    WHERE rr.event_id = ?
    ORDER BY rr.moto_id ASC, rr.position ASC NULLS LAST
  `).all(eventId) as any[];
  return res.json(results.map((r: any) => ({
    id: r.id,
    motoId: r.moto_id,
    motoName: r.moto_name,
    motoType: r.moto_type,
    riderId: r.rider_id,
    riderName: r.first_name ? `${r.first_name} ${r.last_name ?? ""}`.trim() : null,
    raceClass: r.race_class,
    position: r.position,
    bibNumber: r.bib_number,
    lapTimes: parseJsonArr<number>(r.lap_times),
    totalTime: r.total_time,
    dnf: r.dnf === 1,
    dns: r.dns === 1,
  })));
});

export default router;
