import { Router } from "express";
import { createContext, Script } from "vm";
import { getDb } from "../db";

const router = Router();

const FALLBACK_POINTS = [25, 22, 20, 18, 16, 15, 14, 13, 12, 11, 10, 9, 8, 7, 6, 5, 4, 3, 2, 1];

function evalFormula(formula: string, position: number, riders: number): number {
  try {
    const sandbox = createContext({ position, riders, Math });
    const result = new Script(formula).runInContext(sandbox, { timeout: 50 });
    if (typeof result !== "number" || !isFinite(result)) return 0;
    return Math.max(0, Math.round(result));
  } catch {
    return 0;
  }
}

function calcPoints(opts: {
  position: number;
  dnf: boolean;
  dns: boolean;
  totalStarters: number;
  scoringMethod: string;
  pointsScale: number[];
  scoringFormula: string | null;
  mainEventOnly: boolean;
  motoType: string;
  autoDnfEnabled?: boolean;
  autoDnfThreshold?: number;
  lapsCompleted?: number;
  leaderLapsCompleted?: number;
}): number {
  if (opts.dnf || opts.dns) return 0;
  if (opts.mainEventOnly && opts.motoType !== "main") return 0;

  if (
    opts.autoDnfEnabled &&
    opts.leaderLapsCompleted != null &&
    opts.leaderLapsCompleted > 0 &&
    opts.lapsCompleted != null &&
    opts.autoDnfThreshold != null
  ) {
    const minLaps = Math.floor(
      (opts.leaderLapsCompleted * opts.autoDnfThreshold) / 100,
    );
    if (opts.lapsCompleted < minLaps) return 0;
  }

  switch (opts.scoringMethod) {
    case "formula":
      if (!opts.scoringFormula) return 0;
      return evalFormula(opts.scoringFormula, opts.position, opts.totalStarters);
    case "per_rider":
      return Math.max(0, opts.totalStarters - opts.position + 1);
    case "highest_points":
      return opts.pointsScale[opts.position - 1] ?? 0;
    case "lowest_positions":
      return opts.pointsScale[opts.position - 1] ?? opts.position;
    default:
      return FALLBACK_POINTS[opts.position - 1] ?? 0;
  }
}

// GET /events/:eventId/results  (organizer view — no auth check needed; returns all)
router.get("/events/:eventId/results", (req, res) => {
  const db = getDb();
  const eventId = Number(req.params.eventId);

  const results = db
    .prepare(
      `SELECT rr.*, r.first_name, r.last_name, r.bib_number AS rider_bib,
              m.name AS moto_name, m.type AS moto_type
       FROM race_results rr
       LEFT JOIN riders r ON rr.rider_id = r.id
       LEFT JOIN motos m ON rr.moto_id = m.id
       WHERE rr.event_id = ?
       ORDER BY rr.moto_id ASC, rr.position ASC`,
    )
    .all(eventId) as any[];

  return res.json(
    results.map((r: any) => ({
      id: r.id,
      eventId: r.event_id,
      motoId: r.moto_id,
      motoName: r.moto_name ?? null,
      motoType: r.moto_type ?? null,
      riderId: r.rider_id,
      riderName: r.first_name
        ? `${r.first_name} ${r.last_name ?? ""}`.trim()
        : null,
      raceClass: r.race_class,
      position: r.position,
      bibNumber: r.bib_number ?? r.rider_bib ?? null,
      totalTime: r.total_time ?? null,
      lapTimes: (() => { try { return JSON.parse(r.lap_times || "[]"); } catch { return []; } })(),
      points: r.points ?? null,
      dnf: r.dnf === 1,
      dns: r.dns === 1,
    })),
  );
});

// POST /events/:eventId/results — save/upsert results for a moto
router.post("/events/:eventId/results", (req, res) => {
  const session = req.session as any;
  if (!session?.userId) return res.status(401).json({ error: "Unauthorized" });

  const db = getDb();
  const eventId = Number(req.params.eventId);
  const { motoId, results: raw } = req.body;

  if (!motoId || !Array.isArray(raw)) {
    return res.status(400).json({ error: "motoId and results array are required" });
  }

  const moto = db
    .prepare("SELECT id, type FROM motos WHERE id = ?")
    .get(Number(motoId)) as any;
  if (!moto) return res.status(404).json({ error: "Moto not found" });

  // Look up scoring table for this event
  const event = db
    .prepare("SELECT scoring_table_id FROM events WHERE id = ?")
    .get(eventId) as any;

  let scoringMethod = "highest_points";
  let pointsScale: number[] = [];
  let scoringFormula: string | null = null;
  let mainEventOnly = false;
  let autoDnfEnabled = false;
  let autoDnfThreshold = 75;

  if (event?.scoring_table_id) {
    const table = db
      .prepare("SELECT * FROM points_tables WHERE id = ?")
      .get(event.scoring_table_id) as any;
    if (table) {
      scoringMethod = table.scoring_method ?? "highest_points";
      pointsScale = (() => { try { return JSON.parse(table.points_scale || "[]"); } catch { return []; } })();
      scoringFormula = table.scoring_formula ?? null;
      mainEventOnly = table.main_event_only === 1;
      autoDnfEnabled = table.auto_dnf_enabled === 1;
      autoDnfThreshold = table.auto_dnf_threshold ?? 75;
    }
  }

  const totalStarters = (raw as any[]).filter((r: any) => !r.dns).length;

  // Compute leader laps (for autoDnf check) — use the max lap count among finishers
  const leaderLaps = Math.max(
    0,
    ...(raw as any[])
      .filter((r: any) => !r.dns && !r.dnf)
      .map((r: any) => Array.isArray(r.lapTimes) ? r.lapTimes.length : 0),
  );

  const upsert = db.prepare(
    `INSERT INTO race_results
       (event_id, moto_id, rider_id, race_class, position, total_time, lap_times, points, dnf, dns, bib_number, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
     ON CONFLICT(id) DO UPDATE SET
       position = excluded.position,
       total_time = excluded.total_time,
       lap_times = excluded.lap_times,
       points = excluded.points,
       dnf = excluded.dnf,
       dns = excluded.dns,
       bib_number = excluded.bib_number`,
  );

  const upsertById = db.prepare(
    `UPDATE race_results SET
       position = ?, total_time = ?, lap_times = ?,
       points = ?, dnf = ?, dns = ?, bib_number = ?
     WHERE id = ?`,
  );

  const upsertTx = db.transaction(() => {
    for (const r of raw as any[]) {
      const pts = calcPoints({
        position: r.position ?? 999,
        dnf: !!r.dnf,
        dns: !!r.dns,
        totalStarters,
        scoringMethod,
        pointsScale,
        scoringFormula,
        mainEventOnly,
        motoType: moto.type ?? "moto",
        autoDnfEnabled,
        autoDnfThreshold,
        lapsCompleted: Array.isArray(r.lapTimes) ? r.lapTimes.length : 0,
        leaderLapsCompleted: leaderLaps,
      });

      const lapTimesJson = JSON.stringify(Array.isArray(r.lapTimes) ? r.lapTimes : []);
      const totalTime = r.totalTime ?? null;
      const bibNumber = r.bibNumber ?? null;
      const dnfVal = r.dnf ? 1 : 0;
      const dnsVal = r.dns ? 1 : 0;

      if (r.id) {
        upsertById.run(
          r.position ?? 999, totalTime, lapTimesJson,
          pts, dnfVal, dnsVal, bibNumber, r.id,
        );
      } else {
        upsert.run(
          eventId, Number(motoId), r.riderId, r.raceClass ?? "",
          r.position ?? 999, totalTime, lapTimesJson,
          pts, dnfVal, dnsVal, bibNumber,
        );
      }
    }
  });

  upsertTx();

  // Return updated results for this moto
  const updated = db
    .prepare(
      `SELECT rr.*, r.first_name, r.last_name
       FROM race_results rr
       LEFT JOIN riders r ON rr.rider_id = r.id
       WHERE rr.moto_id = ?
       ORDER BY rr.position ASC`,
    )
    .all(Number(motoId)) as any[];

  return res.json(
    updated.map((r: any) => ({
      id: r.id,
      eventId: r.event_id,
      motoId: r.moto_id,
      riderId: r.rider_id,
      riderName: r.first_name
        ? `${r.first_name} ${r.last_name ?? ""}`.trim()
        : null,
      raceClass: r.race_class,
      position: r.position,
      bibNumber: r.bib_number ?? null,
      totalTime: r.total_time ?? null,
      lapTimes: (() => { try { return JSON.parse(r.lap_times || "[]"); } catch { return []; } })(),
      points: r.points ?? null,
      dnf: r.dnf === 1,
      dns: r.dns === 1,
    })),
  );
});

// PATCH /events/:eventId/results/:resultId/laps — update lap times for a single result
router.patch("/events/:eventId/results/:resultId/laps", (req, res) => {
  const session = req.session as any;
  if (!session?.userId) return res.status(401).json({ error: "Unauthorized" });

  const db = getDb();
  const resultId = Number(req.params.resultId);
  const { lapTimes, totalTime } = req.body;

  if (!Array.isArray(lapTimes)) {
    return res.status(400).json({ error: "lapTimes array is required" });
  }

  db.prepare(
    "UPDATE race_results SET lap_times = ?, total_time = ? WHERE id = ?",
  ).run(JSON.stringify(lapTimes), totalTime ?? null, resultId);

  const row = db
    .prepare("SELECT * FROM race_results WHERE id = ?")
    .get(resultId) as any;
  if (!row) return res.status(404).json({ error: "Not found" });

  return res.json({
    id: row.id,
    lapTimes,
    totalTime: row.total_time ?? null,
  });
});

// GET /events/:eventId/publication
router.get("/events/:eventId/publication", (req, res) => {
  const db = getDb();
  const eventId = Number(req.params.eventId);

  const pub = db
    .prepare("SELECT * FROM event_publication WHERE event_id = ?")
    .get(eventId) as any;

  return res.json({
    eventId,
    published: pub?.published === 1,
    publishedAt: pub?.published_at ?? null,
  });
});

// POST /events/:eventId/results/publish — toggle results publication
router.post("/events/:eventId/results/publish", (req, res) => {
  const session = req.session as any;
  if (!session?.userId) return res.status(401).json({ error: "Unauthorized" });

  const db = getDb();
  const eventId = Number(req.params.eventId);
  const { published } = req.body;
  const publishedBool = !!published;
  const now = new Date().toISOString();

  db.prepare(
    `INSERT INTO event_publication (event_id, published, published_at, updated_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(event_id) DO UPDATE SET
       published = excluded.published,
       published_at = excluded.published_at,
       updated_at = excluded.updated_at`,
  ).run(eventId, publishedBool ? 1 : 0, publishedBool ? now : null, now);

  return res.json({ ok: true, published: publishedBool });
});

export default router;
