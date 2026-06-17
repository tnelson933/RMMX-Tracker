import { Router } from "express";
import { getDb } from "../db";

const router = Router();

function serializeSeries(s: any) {
  return {
    id: s.id,
    clubId: s.club_id,
    name: s.name,
    season: s.season ?? String(s.year ?? ""),
    classes: (() => { try { return JSON.parse(s.classes || "[]"); } catch { return []; } })(),
    eventIds: (() => { try { return JSON.parse(s.event_ids || "[]"); } catch { return []; } })(),
    scoringTableId: s.scoring_table_id ?? null,
    pointsSystem: s.points_system ?? "standard",
    createdAt: s.created_at,
  };
}

function getUserClubId(session: any): number | null {
  const db = getDb();
  const user = db
    .prepare("SELECT club_id FROM users WHERE id = ?")
    .get(session.userId) as any;
  return user?.club_id ?? null;
}

// GET /series
router.get("/series", (req, res) => {
  const session = req.session as any;
  if (!session?.userId) return res.status(401).json({ error: "Unauthorized" });

  const db = getDb();
  const clubId = getUserClubId(session);
  if (!clubId) return res.json([]);

  const series = db
    .prepare("SELECT * FROM series WHERE club_id = ? ORDER BY name ASC")
    .all(clubId) as any[];
  return res.json(series.map(serializeSeries));
});

// POST /series
router.post("/series", (req, res) => {
  const session = req.session as any;
  if (!session?.userId) return res.status(401).json({ error: "Unauthorized" });

  const db = getDb();
  const clubId = getUserClubId(session);
  if (!clubId) return res.status(403).json({ error: "No club associated with account" });

  const { name, season, classes, pointsSystem, scoringTableId, eventIds } = req.body;
  if (!name || !season) {
    return res.status(400).json({ error: "name and season are required" });
  }

  const result = db
    .prepare(
      `INSERT INTO series (club_id, name, season, year, classes, event_ids, points_system, scoring_table_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))`,
    )
    .run(
      clubId, String(name), String(season),
      Number(season) || 0,
      JSON.stringify(classes ?? []),
      JSON.stringify(eventIds ?? []),
      pointsSystem ?? "standard",
      scoringTableId ?? null,
    );

  const row = db
    .prepare("SELECT * FROM series WHERE id = ?")
    .get(Number(result.lastInsertRowid)) as any;
  return res.status(201).json(serializeSeries(row));
});

// PATCH /series/:seriesId
router.patch("/series/:seriesId", (req, res) => {
  const session = req.session as any;
  if (!session?.userId) return res.status(401).json({ error: "Unauthorized" });

  const db = getDb();
  const id = Number(req.params.seriesId);

  const fields: string[] = [];
  const values: unknown[] = [];

  if (req.body.name !== undefined) { fields.push("name = ?"); values.push(String(req.body.name)); }
  if (req.body.season !== undefined) {
    fields.push("season = ?"); values.push(String(req.body.season));
    fields.push("year = ?"); values.push(Number(req.body.season) || 0);
  }
  if (req.body.classes !== undefined) { fields.push("classes = ?"); values.push(JSON.stringify(req.body.classes)); }
  if (req.body.eventIds !== undefined) { fields.push("event_ids = ?"); values.push(JSON.stringify(req.body.eventIds)); }
  if (req.body.pointsSystem !== undefined) { fields.push("points_system = ?"); values.push(String(req.body.pointsSystem)); }
  if (req.body.scoringTableId !== undefined) { fields.push("scoring_table_id = ?"); values.push(req.body.scoringTableId ?? null); }

  if (fields.length === 0) return res.status(400).json({ error: "No fields to update" });

  values.push(id);
  db.prepare(`UPDATE series SET ${fields.join(", ")} WHERE id = ?`).run(...(values as any[]));

  const row = db.prepare("SELECT * FROM series WHERE id = ?").get(id) as any;
  if (!row) return res.status(404).json({ error: "Not found" });
  return res.json(serializeSeries(row));
});

// DELETE /series/:seriesId
router.delete("/series/:seriesId", (req, res) => {
  const session = req.session as any;
  if (!session?.userId) return res.status(401).json({ error: "Unauthorized" });

  const db = getDb();
  const id = Number(req.params.seriesId);
  const result = db.prepare("DELETE FROM series WHERE id = ?").run(id);
  if (result.changes === 0) return res.status(404).json({ error: "Not found" });
  return res.status(204).send();
});

// GET /series/:seriesId/leaderboard — computed standings (matches OpenAPI spec)
router.get("/series/:seriesId/leaderboard", (req, res) => {
  const session = req.session as any;
  if (!session?.userId) return res.status(401).json({ error: "Unauthorized" });

  const db = getDb();
  const id = Number(req.params.seriesId);

  const series = db.prepare("SELECT * FROM series WHERE id = ?").get(id) as any;
  if (!series) return res.status(404).json({ error: "Not found" });

  const eventIds: number[] = (() => { try { return JSON.parse(series.event_ids || "[]"); } catch { return []; } })();
  if (eventIds.length === 0) return res.json([]);

  const ph = eventIds.map(() => "?").join(",");

  const events = db.prepare(`SELECT id, name FROM events WHERE id IN (${ph})`).all(...eventIds) as any[];
  const eventNameMap: Record<number, string> = {};
  events.forEach((e: any) => { eventNameMap[e.id] = e.name; });

  const motos = db.prepare(`SELECT * FROM motos WHERE event_id IN (${ph}) AND status = 'completed'`).all(...eventIds) as any[];
  if (motos.length === 0) return res.json([]);

  const motoIds = motos.map((m: any) => m.id);
  const motoPh = motoIds.map(() => "?").join(",");

  const results = db.prepare(`
    SELECT rr.moto_id, rr.rider_id, r.first_name, r.last_name,
           rr.race_class, rr.position, rr.points, rr.dnf, rr.dns
    FROM race_results rr
    LEFT JOIN riders r ON rr.rider_id = r.id
    WHERE rr.moto_id IN (${motoPh})
  `).all(...motoIds) as any[];

  const classByEvent: Record<string, Record<number, { moto: any; results: any[] }[]>> = {};

  for (const moto of motos) {
    const cls = moto.race_class ?? "";
    if (!classByEvent[cls]) classByEvent[cls] = {};
    if (!classByEvent[cls][moto.event_id]) classByEvent[cls][moto.event_id] = [];
    const motoResults = results.filter((r: any) => r.moto_id === moto.id);
    classByEvent[cls][moto.event_id].push({ moto, results: motoResults });
  }

  const standings: any[] = [];

  for (const [raceClass, eventMap] of Object.entries(classByEvent)) {
    const riderNames: Record<number, string> = {};
    for (const motoEntries of Object.values(eventMap)) {
      for (const { results: rs } of motoEntries) {
        for (const r of rs) {
          riderNames[r.rider_id] = `${r.first_name ?? ""} ${r.last_name ?? ""}`.trim();
        }
      }
    }

    const classRows: any[] = [];
    for (const riderId of Object.keys(riderNames).map(Number)) {
      let totalScore = 0;
      let eventsEntered = 0;
      const eventBreakdowns: any[] = [];

      for (const eventId of eventIds) {
        const motoEntries = eventMap[eventId];
        if (!motoEntries?.length) continue;

        const sortedMotos = [...motoEntries].sort((a, b) => (a.moto.moto_number ?? 0) - (b.moto.moto_number ?? 0));
        let eventScore = 0;
        const motoPositions: number[] = [];
        let attended = false;

        for (const { results: motoResults } of sortedMotos) {
          const result = motoResults.find((r: any) => r.rider_id === riderId);
          if (result) {
            attended = true;
            const pts = (result.dnf || result.dns) ? 0 : (result.points ?? 0);
            eventScore += pts;
            motoPositions.push(pts);
          } else {
            motoPositions.push(0);
          }
        }

        if (attended) eventsEntered++;
        totalScore += eventScore;
        eventBreakdowns.push({
          eventId,
          eventName: eventNameMap[eventId] ?? `Event ${eventId}`,
          eventScore,
          attended,
          motos: motoPositions,
        });
      }

      classRows.push({ position: 0, riderId, riderName: riderNames[riderId], raceClass, totalScore, eventsEntered, events: eventBreakdowns });
    }

    classRows.sort((a, b) => b.totalScore - a.totalScore);
    classRows.forEach((row, idx) => {
      row.position = (idx > 0 && row.totalScore === classRows[idx - 1].totalScore)
        ? classRows[idx - 1].position
        : idx + 1;
    });

    standings.push(...classRows);
  }

  return res.json(standings);
});

// POST /series/:seriesId/recalculate — compute & upsert series_points from race_results
router.post("/series/:seriesId/recalculate", (req, res) => {
  const session = req.session as any;
  if (!session?.userId) return res.status(401).json({ error: "Unauthorized" });

  const db = getDb();
  const id = Number(req.params.seriesId);

  const series = db.prepare("SELECT * FROM series WHERE id = ?").get(id) as any;
  if (!series) return res.status(404).json({ error: "Not found" });

  const eventIds: number[] = (() => { try { return JSON.parse(series.event_ids || "[]"); } catch { return []; } })();

  db.prepare("DELETE FROM series_points WHERE series_id = ?").run(id);

  if (eventIds.length === 0) return res.json({ ok: true, rows: 0 });

  const ph = eventIds.map(() => "?").join(",");
  const motos = db.prepare(`SELECT * FROM motos WHERE event_id IN (${ph}) AND status = 'completed'`).all(...eventIds) as any[];

  if (motos.length === 0) return res.json({ ok: true, rows: 0 });

  const motoIds = motos.map((m: any) => m.id);
  const motoPh = motoIds.map(() => "?").join(",");

  const results = db.prepare(`
    SELECT rr.rider_id, rr.race_class, rr.points, rr.dnf, rr.dns, rr.moto_id,
           r.first_name, r.last_name
    FROM race_results rr
    LEFT JOIN riders r ON rr.rider_id = r.id
    WHERE rr.moto_id IN (${motoPh})
  `).all(...motoIds) as any[];

  const motoEventMap: Record<number, number> = {};
  for (const m of motos) motoEventMap[m.id] = m.event_id;

  const pointsMap: Record<string, { riderId: number; raceClass: string; totalPoints: number; byEvent: Record<number, number> }> = {};

  for (const r of results) {
    const key = `${r.rider_id}:${r.race_class}`;
    if (!pointsMap[key]) {
      pointsMap[key] = { riderId: r.rider_id, raceClass: r.race_class, totalPoints: 0, byEvent: {} };
    }
    const pts = (r.dnf || r.dns) ? 0 : (Number(r.points) || 0);
    const eventId = motoEventMap[r.moto_id];
    pointsMap[key].totalPoints += pts;
    pointsMap[key].byEvent[eventId] = (pointsMap[key].byEvent[eventId] ?? 0) + pts;
  }

  const insert = db.prepare(
    `INSERT INTO series_points (series_id, rider_id, race_class, total_points, event_results, updated_at)
     VALUES (?, ?, ?, ?, ?, datetime('now'))`
  );

  db.transaction(() => {
    for (const entry of Object.values(pointsMap)) {
      const eventResults = JSON.stringify(
        eventIds.map(eid => ({ eventId: eid, points: entry.byEvent[eid] ?? 0 }))
      );
      insert.run(id, entry.riderId, entry.raceClass, entry.totalPoints, eventResults);
    }
  })();

  return res.json({ ok: true, rows: Object.keys(pointsMap).length });
});

// GET /series/:seriesId/points — legacy alias kept for backward compat
router.get("/series/:seriesId/points", (req, res) => {
  const session = req.session as any;
  if (!session?.userId) return res.status(401).json({ error: "Unauthorized" });

  const db = getDb();
  const id = Number(req.params.seriesId);
  const points = db
    .prepare(
      `SELECT sp.*, r.first_name, r.last_name, r.bib_number
       FROM series_points sp
       LEFT JOIN riders r ON sp.rider_id = r.id
       WHERE sp.series_id = ?
       ORDER BY sp.race_class ASC, sp.total_points DESC`,
    )
    .all(id) as any[];

  return res.json(
    points.map((p: any) => ({
      id: p.id,
      seriesId: p.series_id,
      riderId: p.rider_id,
      riderName: p.first_name
        ? `${p.first_name} ${p.last_name ?? ""}`.trim()
        : null,
      bibNumber: p.bib_number ?? null,
      raceClass: p.race_class,
      totalPoints: p.total_points,
      eventResults: (() => { try { return JSON.parse(p.event_results || "[]"); } catch { return []; } })(),
      updatedAt: p.updated_at,
    })),
  );
});

// ── Public: series info for embeddable widget (no auth required) ─────────────
// Mirrors the cloud API's GET /public/series/:seriesId.
// On the local server we show ALL series events (no publication gate) so the
// organizer can preview the widget even before publishing to cloud.
router.get("/public/series/:seriesId", (req, res) => {
  const db = getDb();
  const id = Number(req.params.seriesId);

  const series = db.prepare("SELECT * FROM series WHERE id = ?").get(id) as any;
  if (!series) return res.status(404).json({ error: "Not found" });

  const eventIds: number[] = (() => { try { return JSON.parse(series.event_ids || "[]"); } catch { return []; } })();

  const events = eventIds.length > 0
    ? (db.prepare(
        `SELECT id, name, date, status, location, state FROM events WHERE id IN (${eventIds.map(() => "?").join(",")}) ORDER BY date ASC`
      ).all(...eventIds) as any[])
    : [];

  const eventMap = new Map(events.map((e: any) => [e.id, e]));
  const sortedEvents = eventIds.map(id => eventMap.get(id)).filter(Boolean);

  return res.json({
    id: series.id,
    name: series.name,
    season: series.season ?? String(series.year ?? ""),
    classes: (() => { try { return JSON.parse(series.classes || "[]"); } catch { return []; } })(),
    eventIds,
    events: sortedEvents,
  });
});

// ── Public: series standings (no auth required) ───────────────────────────────
// Mirrors the cloud API's GET /public/series/:seriesId/standings.
// Computes live from race_results + adds amaNumber/bikeBrand from registrations.
router.get("/public/series/:seriesId/standings", (req, res) => {
  const db = getDb();
  const id = Number(req.params.seriesId);

  const series = db.prepare("SELECT * FROM series WHERE id = ?").get(id) as any;
  if (!series) return res.status(404).json({ error: "Not found" });

  const eventIds: number[] = (() => { try { return JSON.parse(series.event_ids || "[]"); } catch { return []; } })();
  if (eventIds.length === 0) return res.json([]);

  const ph = eventIds.map(() => "?").join(",");

  const events = db.prepare(`SELECT id, name FROM events WHERE id IN (${ph})`).all(...eventIds) as any[];
  const eventNameMap: Record<number, string> = {};
  events.forEach((e: any) => { eventNameMap[e.id] = e.name; });

  const motos = db.prepare(`SELECT * FROM motos WHERE event_id IN (${ph}) AND status = 'completed'`).all(...eventIds) as any[];
  if (motos.length === 0) return res.json([]);

  const motoIds = motos.map((m: any) => m.id);
  const motoPh = motoIds.map(() => "?").join(",");

  const results = db.prepare(`
    SELECT rr.moto_id, rr.rider_id, r.first_name, r.last_name,
           rr.race_class, rr.position, rr.points, rr.dnf, rr.dns
    FROM race_results rr
    LEFT JOIN riders r ON rr.rider_id = r.id
    WHERE rr.moto_id IN (${motoPh})
  `).all(...motoIds) as any[];

  const classByEvent: Record<string, Record<number, { moto: any; results: any[] }[]>> = {};
  for (const moto of motos) {
    const cls = moto.race_class ?? "";
    if (!classByEvent[cls]) classByEvent[cls] = {};
    if (!classByEvent[cls][moto.event_id]) classByEvent[cls][moto.event_id] = [];
    classByEvent[cls][moto.event_id].push({ moto, results: results.filter((r: any) => r.moto_id === moto.id) });
  }

  const standings: any[] = [];

  for (const [raceClass, eventMap] of Object.entries(classByEvent)) {
    const riderNames: Record<number, string> = {};
    for (const motoEntries of Object.values(eventMap)) {
      for (const { results: rs } of motoEntries) {
        for (const r of rs) {
          riderNames[r.rider_id] = `${r.first_name ?? ""} ${r.last_name ?? ""}`.trim();
        }
      }
    }

    const classRows: any[] = [];
    for (const riderId of Object.keys(riderNames).map(Number)) {
      let totalScore = 0;
      let eventsEntered = 0;
      const eventBreakdowns: any[] = [];

      for (const eventId of eventIds) {
        const motoEntries = eventMap[eventId];
        if (!motoEntries?.length) continue;
        const sortedMotos = [...motoEntries].sort((a, b) => (a.moto.moto_number ?? 0) - (b.moto.moto_number ?? 0));
        let eventScore = 0;
        const motoPositions: number[] = [];
        let attended = false;

        for (const { results: motoResults } of sortedMotos) {
          const result = motoResults.find((r: any) => r.rider_id === riderId);
          if (result) {
            attended = true;
            const pts = (result.dnf || result.dns) ? 0 : (result.points ?? 0);
            eventScore += pts;
            motoPositions.push(pts);
          } else {
            motoPositions.push(0);
          }
        }

        if (attended) eventsEntered++;
        totalScore += eventScore;
        eventBreakdowns.push({ eventId, eventName: eventNameMap[eventId] ?? `Event ${eventId}`, eventScore, attended, motos: motoPositions });
      }

      classRows.push({ position: 0, riderId, riderName: riderNames[riderId], raceClass, totalScore, eventsEntered, amaNumber: null, bikeBrand: null, events: eventBreakdowns });
    }

    classRows.sort((a, b) => b.totalScore - a.totalScore);
    classRows.forEach((row, idx) => {
      row.position = (idx > 0 && row.totalScore === classRows[idx - 1].totalScore)
        ? classRows[idx - 1].position
        : idx + 1;
    });
    standings.push(...classRows);
  }

  // Enrich with amaNumber and bikeBrand from registrations
  const allRiderIds = [...new Set(standings.map((s: any) => s.riderId))];
  if (allRiderIds.length > 0) {
    const ridPh = allRiderIds.map(() => "?").join(",");
    const regs = db.prepare(
      `SELECT rider_id, ama_number, bike_brand FROM registrations WHERE rider_id IN (${ridPh}) AND event_id IN (${ph})`
    ).all(...allRiderIds, ...eventIds) as any[];

    const riderInfo: Record<number, { amaNumber: string | null; bikeBrand: string | null }> = {};
    for (const reg of regs) {
      if (!riderInfo[reg.rider_id]) riderInfo[reg.rider_id] = { amaNumber: null, bikeBrand: null };
      if (!riderInfo[reg.rider_id].amaNumber && reg.ama_number) riderInfo[reg.rider_id].amaNumber = reg.ama_number;
      if (!riderInfo[reg.rider_id].bikeBrand && reg.bike_brand) riderInfo[reg.rider_id].bikeBrand = reg.bike_brand;
    }
    for (const row of standings) {
      row.amaNumber = riderInfo[row.riderId]?.amaNumber ?? null;
      row.bikeBrand = riderInfo[row.riderId]?.bikeBrand ?? null;
    }
  }

  return res.json(standings);
});

export default router;
