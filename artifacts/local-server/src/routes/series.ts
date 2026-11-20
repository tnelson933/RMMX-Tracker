import { Router } from "express";
import { compareOverall, isLowerBetter, olympicPenalty, overallPositions } from "../lib/overallOrder";
import { getDb } from "../db";
import { computeSeriesStandings } from "../lib/series-standings";
import { newDesktopId } from "../lib/desktop-ids";
import { isoTime } from "../lib/cloud-shape";
import { SCORING_STYLE_MISMATCH, seriesMismatchesEvents } from "../lib/scoringStyle";

const router = Router();

/** The season as the website returns it: a whole number ("2026.0" pulled from the cloud is 2026). */
function seasonOf(s: any): number | string {
  const raw = s.season ?? s.year ?? "";
  const n = Number(raw);
  return raw !== "" && Number.isFinite(n) ? n : String(raw);
}

function serializeSeries(s: any) {
  return {
    id: s.id,
    name: s.name,
    clubId: s.club_id,
    season: seasonOf(s),
    classes: (() => { try { return JSON.parse(s.classes || "[]"); } catch { return []; } })(),
    eventIds: (() => { try { return JSON.parse(s.event_ids || "[]"); } catch { return []; } })(),
    scoringTableId: s.scoring_table_id ?? null,
    pointsSystem: s.points_system ?? "standard",
    createdAt: isoTime(s.created_at),
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
/** Olympic series (lowest total wins), from the series' points table. */
function seriesLowerIsBetter(series: any): boolean {
  if (!series?.scoring_table_id) return false;
  const table = getDb().prepare("SELECT scoring_method FROM points_tables WHERE id = ?").get(series.scoring_table_id) as any;
  return isLowerBetter(table?.scoring_method);
}

/** Event ids without duplicates (a duplicate would count an event twice). */
function uniqueIds(ids: unknown): number[] {
  return Array.isArray(ids) ? [...new Set(ids.map(Number).filter(Number.isFinite))] : [];
}

/** A system scoring table or one of this club's own (the website's rule for events and series). */
function scoringTableUsable(tableId: unknown, clubId: number): boolean {
  if (tableId == null || tableId === "") return true;
  const table = getDb().prepare("SELECT club_id FROM points_tables WHERE id = ?").get(Number(tableId)) as { club_id: number | null } | undefined;
  return !!table && (table.club_id == null || table.club_id === clubId);
}

/** Event ids from `eventIds` that aren't this club's events. */
function foreignEventIds(eventIds: unknown, clubId: number): number[] {
  if (!Array.isArray(eventIds) || eventIds.length === 0) return [];
  const ids = eventIds.map(Number);
  const own = new Set(
    (getDb().prepare(`SELECT id FROM events WHERE club_id = ? AND id IN (${ids.map(() => "?").join(",")})`).all(clubId, ...ids) as Array<{ id: number }>).map(r => r.id),
  );
  return ids.filter(id => !own.has(id));
}

/** A class's standings are official once all its finished races are finalized (as in the cloud). */
function classOfficial(motos: any[], raceClass: string): boolean {
  return motos.filter((m: any) => (m.race_class ?? "") === raceClass).every((m: any) => m.results_finalized_at != null);
}

router.get("/series", (req, res) => {
  const session = req.session as any;
  if (!session?.userId) return res.status(401).json({ error: "You're signed out. Sign in again, then try once more." });

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
  if (!session?.userId) return res.status(401).json({ error: "You're signed out. Sign in again, then try once more." });

  const db = getDb();
  const clubId = getUserClubId(session);
  if (!clubId) return res.status(403).json({ error: "Your account isn't linked to a club yet. Ask your club's owner to add you on the Team page." });

  const { name, season, classes, pointsSystem, scoringTableId, eventIds } = req.body;
  if (!name || !season) {
    return res.status(400).json({ error: "Enter a series name and season." });
  }
  if (seriesMismatchesEvents(null, clubId, scoringTableId, uniqueIds(eventIds))) {
    return res.status(400).json({ error: SCORING_STYLE_MISMATCH });
  }

  // The website's checks, in its order.
  if (!scoringTableUsable(scoringTableId, clubId)) return res.status(400).json({ error: "That scoring table isn't available to this club." });
  const foreignOnCreate = foreignEventIds(eventIds, clubId);
  if (foreignOnCreate.length > 0) return res.status(400).json({ error: `Events ${foreignOnCreate.join(", ")} don't belong to this club.` });

  const result = db
    .prepare(
      `INSERT INTO series (id, club_id, name, season, year, classes, event_ids, points_system, scoring_table_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))`,
    )
    .run(
      newDesktopId(db, "series"),
      clubId, String(name), String(season),
      Number(season) || 0,
      JSON.stringify(classes ?? []),
      JSON.stringify(uniqueIds(eventIds)),
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
  if (!session?.userId) return res.status(401).json({ error: "You're signed out. Sign in again, then try once more." });

  const db = getDb();
  const id = Number(req.params.seriesId);
  const existing = db.prepare("SELECT * FROM series WHERE id = ?").get(id) as any;
  if (!existing) return res.status(404).json({ error: "That item couldn't be found. It may have been deleted. Refresh the page and try again." });

  // The website's checks, in its order.
  const { eventIds, scoringTableId } = req.body;
  const foreignOnUpdate = foreignEventIds(eventIds, existing.club_id);
  if (foreignOnUpdate.length > 0) return res.status(400).json({ error: `Events ${foreignOnUpdate.join(", ")} don't belong to this club.` });
  if (scoringTableId !== undefined && !scoringTableUsable(scoringTableId, existing.club_id)) {
    return res.status(400).json({ error: "That scoring table isn't available to this club." });
  }
  // Every event that counts toward the series (listed or linked per class)
  // must be scored the same way, whether the events or the table change.
  const existingIds = uniqueIds((() => { try { return JSON.parse(existing.event_ids || "[]"); } catch { return []; } })());
  if (eventIds !== undefined || scoringTableId !== undefined) {
    const nextTable = scoringTableId !== undefined ? (scoringTableId ?? null) : existing.scoring_table_id;
    const nextEvents = eventIds !== undefined ? uniqueIds(eventIds) : existingIds;
    if (seriesMismatchesEvents(id, existing.club_id, nextTable, nextEvents)) {
      return res.status(400).json({ error: SCORING_STYLE_MISMATCH });
    }
  }

  const fields: string[] = [];
  const values: unknown[] = [];

  if (req.body.name !== undefined) { fields.push("name = ?"); values.push(String(req.body.name)); }
  if (req.body.season !== undefined) {
    fields.push("season = ?"); values.push(String(req.body.season));
    fields.push("year = ?"); values.push(Number(req.body.season) || 0);
  }
  if (req.body.classes !== undefined) { fields.push("classes = ?"); values.push(JSON.stringify(req.body.classes)); }
  if (req.body.eventIds !== undefined) { fields.push("event_ids = ?"); values.push(JSON.stringify(uniqueIds(req.body.eventIds))); }
  if (req.body.scoringTableId !== undefined) { fields.push("scoring_table_id = ?"); values.push(req.body.scoringTableId ?? null); }

  if (fields.length === 0) return res.status(400).json({ error: "No fields to update" });

  values.push(id);
  db.prepare(`UPDATE series SET ${fields.join(", ")} WHERE id = ?`).run(...(values as any[]));

  const row = db.prepare("SELECT * FROM series WHERE id = ?").get(id) as any;
  if (!row) return res.status(404).json({ error: "That item couldn't be found. It may have been deleted. Refresh the page and try again." });
  return res.json(serializeSeries(row));
});

// A series can't be deleted on the website, so there is no delete here either:
// one removed only on this computer would come back with the next sync.

// GET /series/:seriesId/leaderboard — computed standings (matches OpenAPI spec)
router.get("/series/:seriesId/leaderboard", (req, res) => {
  const db = getDb();
  const id = Number(req.params.seriesId);

  const series = db.prepare("SELECT * FROM series WHERE id = ?").get(id) as any;
  if (!series) return res.status(404).json({ error: "That item couldn't be found. It may have been deleted. Refresh the page and try again." });
  // Same standings as the website: finished races count, each class flagged
  // official once all its races are finalized.
  return res.json(computeSeriesStandings(series).standings);
});

// POST /series/:seriesId/recalculate — compute & upsert series_points from race_results
router.post("/series/:seriesId/recalculate", (req, res) => {
  const session = req.session as any;
  if (!session?.userId) return res.status(401).json({ error: "You're signed out. Sign in again, then try once more." });

  const db = getDb();
  const id = Number(req.params.seriesId);

  const series = db.prepare("SELECT * FROM series WHERE id = ?").get(id) as any;
  if (!series) return res.status(404).json({ error: "That item couldn't be found. It may have been deleted. Refresh the page and try again." });
  const lowerIsBetter = seriesLowerIsBetter(series);

  // The stored totals are the standings pages' totals (same events and classes,
  // penalties and missed motos), so anything reading them agrees with the pages.
  const { standings } = computeSeriesStandings(series);
  const insert = db.prepare(
    `INSERT INTO series_points (series_id, rider_id, race_class, total_points, event_results, updated_at)
     VALUES (?, ?, ?, ?, ?, datetime('now'))`
  );
  db.transaction(() => {
    db.prepare("DELETE FROM series_points WHERE series_id = ?").run(id);
    for (const row of standings as Array<{ riderId: number; raceClass: string; totalScore: number; events: Array<{ eventId: number; eventScore: number }> }>) {
      insert.run(id, row.riderId, row.raceClass, row.totalScore, JSON.stringify(row.events.map(e => ({ eventId: e.eventId, points: e.eventScore }))));
    }
  })();

  return res.json({ ok: true, rows: standings.length });
});

// GET /series/:seriesId/points — legacy alias kept for backward compat
router.get("/series/:seriesId/points", (req, res) => {
  const session = req.session as any;
  if (!session?.userId) return res.status(401).json({ error: "You're signed out. Sign in again, then try once more." });

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
  if (!series) return res.status(404).json({ error: "That item couldn't be found. It may have been deleted. Refresh the page and try again." });
  const lowerIsBetter = seriesLowerIsBetter(series);

  const eventIds: number[] = uniqueIds((() => { try { return JSON.parse(series.event_ids || "[]"); } catch { return []; } })());

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
    season: seasonOf(series),
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
  if (!series) return res.status(404).json({ error: "That item couldn't be found. It may have been deleted. Refresh the page and try again." });

  const { standings: rows, eventIds } = computeSeriesStandings(series);
  const standings = rows.map(row => ({ ...row, amaNumber: null as string | null, bikeBrand: null as string | null }));

  // AMA number and bike from the riders' entries in the series' events.
  const allRiderIds = [...new Set(standings.map((s: any) => s.riderId))];
  if (allRiderIds.length > 0 && eventIds.length > 0) {
    const regs = db.prepare(
      `SELECT rider_id, ama_number, bike_brand FROM registrations
       WHERE rider_id IN (${allRiderIds.map(() => "?").join(",")}) AND event_id IN (${eventIds.map(() => "?").join(",")}) ORDER BY id`
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
