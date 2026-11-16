import { Router } from "express";
import { getDb } from "../db";
import { formulaPoints } from "../lib/safeFormula";
import { AMA_POINTS, isLowerBetter, olympicPenalty } from "../lib/overallOrder";
import { buildContingencyReport } from "@workspace/api-zod";
import { computeEventOverall } from "../lib/eventOverall";

const router = Router();

/** No scoring table: the current AMA scale, as in the cloud. */
const FALLBACK_POINTS = AMA_POINTS;

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
  /** Riders in the class for this moto (Olympic DNF/DNS scores); defaults to the starters. */
  classSize?: number;
}): number {
  if (opts.mainEventOnly && opts.motoType !== "main") return 0;
  // Olympic (lowest wins): a DNF or DNS scores a penalty, not 0 (lib/overallOrder.ts).
  const olympic = isLowerBetter(opts.scoringMethod);
  const classSize = opts.classSize ?? opts.totalStarters;
  if (opts.dns) return olympic ? olympicPenalty("dns", classSize) : 0;
  if (opts.dnf) return olympic ? olympicPenalty("dnf", classSize) : 0;

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
    if (opts.lapsCompleted < minLaps) return olympic ? olympicPenalty("dnf", classSize) : 0;
  }

  switch (opts.scoringMethod) {
    case "formula":
      if (!opts.scoringFormula) return 0;
      return formulaPoints(opts.scoringFormula, opts.position, opts.totalStarters);
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

/**
 * Points for a finished moto from its finishing order, with the event's points
 * table and the club's auto-DNF rule (the cloud's scoreMotoPoints). Run when a
 * race finishes on live timing or is finalized, so results and standings have
 * points without opening Enter Results. Enduro tests are scored by the enduro
 * overall, not here.
 */
export function scoreMotoPoints(motoId: number): void {
  try {
    const db = getDb();
    const moto = db.prepare("SELECT id, event_id, type FROM motos WHERE id = ?").get(motoId) as any;
    if (!moto || moto.type === "practice" || moto.type === "enduro_test") return;
    const rows = db.prepare("SELECT id, position, points, dnf, dns, lap_times FROM race_results WHERE moto_id = ?").all(motoId) as any[];
    if (rows.length === 0) return;
    const event = db.prepare("SELECT scoring_table_id, club_id FROM events WHERE id = ?").get(moto.event_id) as any;
    const table = event?.scoring_table_id ? db.prepare("SELECT * FROM points_tables WHERE id = ?").get(event.scoring_table_id) as any : null;
    const club = event?.club_id ? db.prepare("SELECT auto_dnf_enabled, auto_dnf_threshold FROM clubs WHERE id = ?").get(event.club_id) as any : null;
    const settings = {
      scoringMethod: table ? String(table.scoring_method) : "fallback",
      pointsScale: table ? (() => { try { return JSON.parse(table.points_scale || "[]") as number[]; } catch { return [] as number[]; } })() : [] as number[],
      scoringFormula: table?.scoring_formula ?? null,
      mainEventOnly: table?.main_event_only === 1,
      autoDnfEnabled: club?.auto_dnf_enabled === 1,
      autoDnfThreshold: club?.auto_dnf_threshold ?? 75,
    };
    const lapsOf = (r: any) => { try { const laps = JSON.parse(r.lap_times || "[]"); return Array.isArray(laps) ? laps.length : 0; } catch { return 0; } };
    const totalStarters = rows.filter(r => r.dns !== 1).length;
    const leader = rows.find(r => r.position === 1 && r.dnf !== 1 && r.dns !== 1);
    const leaderLapsCompleted = settings.autoDnfEnabled && leader ? lapsOf(leader) : undefined;
    const save = db.prepare("UPDATE race_results SET points = ? WHERE id = ?");
    for (const r of rows) {
      const points = calcPoints({
        position: r.position,
        dnf: r.dnf === 1,
        dns: r.dns === 1,
        totalStarters,
        classSize: rows.length,
        ...settings,
        motoType: moto.type ?? "heat",
        lapsCompleted: lapsOf(r),
        leaderLapsCompleted,
      });
      if (points !== r.points) save.run(points, r.id);
    }
  } catch (err) {
    console.warn(`[results] could not score moto ${motoId}:`, err instanceof Error ? err.message : err);
  }
}

// GET /events/:eventId/results  (organizer view — no auth check needed; returns all)
router.get("/events/:eventId/results", (req, res) => {
  const db = getDb();
  const eventId = Number(req.params.eventId);

  const results = db
    .prepare(
      `SELECT rr.*, r.first_name, r.last_name, r.bib_number AS rider_bib,
              m.name AS moto_name, m.type AS moto_type, m.results_finalized_at,
              m.lap_count AS moto_lap_count, m.time_limit_ms AS moto_time_limit_ms
       FROM race_results rr
       LEFT JOIN riders r ON rr.rider_id = r.id
       LEFT JOIN motos m ON rr.moto_id = m.id
       WHERE rr.event_id = ?
       ORDER BY rr.position ASC, rr.id ASC`,
    )
    .all(eventId) as any[];
  // AMA number and bike from the rider's entry (the one in the result's class
  // first), and the team name for a group race: same as the website.
  const byClass = new Map<string, { amaNumber: string | null; bikeBrand: string | null }>();
  const byRider = new Map<number, { amaNumber: string | null; bikeBrand: string | null }>();
  const teamNames = new Map<number, string>();
  for (const reg of db.prepare(
    "SELECT rider_id, race_class, ama_number, bike_brand, team_name FROM registrations WHERE event_id = ? AND status != 'void' ORDER BY id",
  ).all(eventId) as any[]) {
    const details = { amaNumber: reg.ama_number ?? null, bikeBrand: reg.bike_brand ?? null };
    const key = `${reg.rider_id}|${reg.race_class}`;
    if (!byClass.has(key)) byClass.set(key, details);
    if (!byRider.has(reg.rider_id)) byRider.set(reg.rider_id, details);
    if (reg.team_name && !teamNames.has(reg.rider_id)) teamNames.set(reg.rider_id, reg.team_name);
  }
  const regDetails = (riderId: number, raceClass: string | null) =>
    byClass.get(`${riderId}|${raceClass}`) ?? byRider.get(riderId) ?? { amaNumber: null, bikeBrand: null };
  // Olympic tables rank the overall lowest first; the pages need to know.
  const table = db.prepare(
    "SELECT pt.scoring_method FROM events e LEFT JOIN points_tables pt ON pt.id = e.scoring_table_id WHERE e.id = ?",
  ).get(eventId) as any;
  const lowerIsBetter = isLowerBetter(table?.scoring_method);

  return res.json(
    results.map((r: any) => ({
      id: r.id,
      eventId: r.event_id,
      motoId: r.moto_id,
      motoName: r.moto_name || "",
      motoType: r.moto_type ?? "heat",
      riderId: r.rider_id,
      riderName: teamNames.get(r.rider_id) ?? `${r.first_name ?? null} ${r.last_name ?? null}`,
      raceClass: r.race_class,
      position: r.position,
      bibNumber: r.bib_number ?? null,
      totalTime: r.total_time ?? null,
      // A lap-count race shows at most that many laps.
      lapTimes: (() => {
        let laps: unknown[] = [];
        try { const parsed = JSON.parse(r.lap_times || "[]"); if (Array.isArray(parsed)) laps = parsed; } catch { /* none */ }
        const cap = r.moto_time_limit_ms ? null : r.moto_lap_count;
        return cap != null && cap > 0 ? laps.slice(0, cap) : laps;
      })(),
      amaNumber: regDetails(r.rider_id, r.race_class).amaNumber,
      bikeBrand: regDetails(r.rider_id, r.race_class).bikeBrand,
      points: r.points ?? null,
      dnf: r.dnf === 1,
      dns: r.dns === 1,
      official: r.results_finalized_at != null || r.moto_type === "practice",
      lowerIsBetter,
    })),
  );
});

// POST /events/:eventId/results — save/upsert results for a moto
router.post("/events/:eventId/results", (req, res) => {
  const session = req.session as any;
  if (!session?.userId) return res.status(401).json({ error: "You're signed out. Sign in again, then try once more." });

  const db = getDb();
  const eventId = Number(req.params.eventId);
  const { motoId, results: raw } = req.body;

  if (!motoId || !Array.isArray(raw)) {
    return res.status(400).json({ error: "Something was missing from that request. Refresh the page and try again." });
  }

  const moto = db
    .prepare("SELECT id, type FROM motos WHERE id = ?")
    .get(Number(motoId)) as any;
  if (!moto) return res.status(404).json({ error: "This moto couldn't be found. Motos may have been regenerated. Refresh the Motos page." });

  // Look up scoring table + club auto-DNF for this event
  const event = db
    .prepare("SELECT scoring_table_id, club_id FROM events WHERE id = ?")
    .get(eventId) as any;

  // No table: the same default as the cloud (the AMA scale, 25, 22, 20, ... 1).
  let scoringMethod = "fallback";
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

  // Club-level auto-DNF overrides the scoring table setting (mirrors cloud behaviour)
  if (event?.club_id) {
    const club = db
      .prepare("SELECT auto_dnf_enabled, auto_dnf_threshold FROM clubs WHERE id = ?")
      .get(event.club_id) as any;
    if (club) {
      autoDnfEnabled = club.auto_dnf_enabled === 1;
      autoDnfThreshold = club.auto_dnf_threshold ?? 75;
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
        classSize: (raw as any[]).length,
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
  if (!session?.userId) return res.status(401).json({ error: "You're signed out. Sign in again, then try once more." });

  const db = getDb();
  const resultId = Number(req.params.resultId);
  const { lapTimes, totalTime } = req.body;

  if (!Array.isArray(lapTimes)) {
    return res.status(400).json({ error: "Some lap times aren't valid. Check the times and try again." });
  }

  db.prepare(
    "UPDATE race_results SET lap_times = ?, total_time = ? WHERE id = ?",
  ).run(JSON.stringify(lapTimes), totalTime ?? null, resultId);

  const row = db
    .prepare("SELECT * FROM race_results WHERE id = ?")
    .get(resultId) as any;
  if (!row) return res.status(404).json({ error: "This result couldn't be found. It may have been deleted. Refresh the page and try again." });

  return res.json({
    id: row.id,
    lapTimes,
    totalTime: row.total_time ?? null,
  });
});

// GET /events/:eventId/ama-export — CSV download for AMA reporting
router.get("/events/:eventId/ama-export", (req, res) => {
  const session = req.session as any;
  if (!session?.userId) return res.status(401).json({ error: "You're signed out. Sign in again, then try once more." });

  const db = getDb();
  const eventId = Number(req.params.eventId);

  const event = db.prepare("SELECT * FROM events WHERE id = ?").get(eventId) as any;
  if (!event) return res.status(404).json({ error: "This event couldn't be found. It may have been deleted. Go back to Events and open it again." });

  const results = db
    .prepare(
      `SELECT
         rr.rider_id, rr.moto_id, rr.position, rr.bib_number, rr.race_class AS result_class,
         m.race_class, m.moto_number,
         ri.first_name, ri.last_name, ri.city, ri.home_state
       FROM race_results rr
       INNER JOIN motos m ON rr.moto_id = m.id
       INNER JOIN riders ri ON rr.rider_id = ri.id
       WHERE m.event_id = ?
       ORDER BY rr.id ASC`,
    )
    .all(eventId) as any[];
  // One line per result, with the AMA number from the rider's entry (the one in
  // the result's class first), as the website's export does. Joining entries
  // here repeated a rider who entered two classes.
  const amaByClass = new Map<string, string | null>();
  const amaByRider = new Map<number, string | null>();
  for (const reg of db.prepare(
    "SELECT rider_id, race_class, ama_number FROM registrations WHERE event_id = ? AND status != 'void' ORDER BY id",
  ).all(eventId) as any[]) {
    const key = `${reg.rider_id}|${reg.race_class}`;
    if (!amaByClass.has(key)) amaByClass.set(key, reg.ama_number ?? null);
    if (!amaByRider.has(reg.rider_id)) amaByRider.set(reg.rider_id, reg.ama_number ?? null);
  }
  const amaNumber = (riderId: number, raceClass: string | null) => {
    const key = `${riderId}|${raceClass}`;
    return (amaByClass.has(key) ? amaByClass.get(key) : amaByRider.get(riderId)) ?? "";
  };

  const amaEventId = event.ama_event_id ?? "";
  const eventDate = event.date ? String(event.date).substring(0, 10) : "";
  const trackName = event.track_name ?? event.name;

  const escCsv = (v: unknown): string => {
    const s = String(v ?? "");
    if (s.includes(",") || s.includes('"') || s.includes("\n")) return `"${s.replace(/"/g, '""')}"`;
    return s;
  };

  const header = [
    "AMA Event ID", "Event Name", "Event Date", "Track Name",
    "Class", "Moto", "AMA #", "Bib #", "First Name", "Last Name",
    "Hometown", "State", "Overall Position",
  ].join(",");

  const lines: string[] = [header];
  for (const r of results) {
    lines.push([
      escCsv(amaEventId),
      escCsv(event.name),
      escCsv(eventDate),
      escCsv(trackName),
      escCsv(r.race_class),
      escCsv(r.moto_number),
      escCsv(amaNumber(r.rider_id, r.result_class ?? r.race_class)),
      escCsv(r.bib_number ?? ""),
      escCsv(r.first_name ?? ""),
      escCsv(r.last_name ?? ""),
      escCsv(r.city ?? ""),
      escCsv(r.home_state ?? ""),
      escCsv(r.position ?? ""),
    ].join(","));
  }

  const filename = `ama-export-event-${eventId}.csv`;
  res.setHeader("Content-Type", "text/csv");
  res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
  return res.send(lines.join("\n"));
});

// GET /public/events/:eventId/overall-standings: per-class overall standings.
// Mirrors the cloud route (api-server routes/dashboard.ts): no sign-in needed,
// finished races only, Olympic tables rank lowest first.
router.get("/public/events/:eventId/overall-standings", (req, res) => {
  const eventId = Number(req.params.eventId);
  if (isNaN(eventId)) return res.status(400).json({ error: "This link looks broken. Go back and open it again from the list." });
  return res.json(computeEventOverall(eventId));
});

// GET /events/:eventId/contingency-report: each brand the event offers
// contingency with, and the finishers who ran it (bike brand or a listed
// sponsor), from the class overall. Mirrors the cloud route (api-server
// routes/results.ts), including its messages.
router.get("/events/:eventId/contingency-report", (req, res) => {
  const session = req.session as any;
  if (!session?.userId) return res.status(401).json({ error: "You're signed out. Sign in again, then try once more." });
  const db = getDb();
  const eventId = Number(req.params.eventId);
  const event = db.prepare("SELECT id, club_id, name, date, contingency_brands FROM events WHERE id = ?").get(eventId) as
    | { id: number; club_id: number; name: string; date: string; contingency_brands: string | null }
    | undefined;
  if (!event) return res.status(404).json({ error: "This event couldn't be found. It may have been deleted. Go back to Events and open it again." });
  const user = db.prepare("SELECT club_id, role FROM users WHERE id = ?").get(session.userId) as { club_id: number | null; role: string | null } | undefined;
  if (event.club_id !== user?.club_id && user?.role !== "super_admin") {
    return res.status(403).json({ error: "Your account doesn't have access to this. If it should, ask your club's owner to check your role on the Team page." });
  }

  const overall = computeEventOverall(eventId);
  // Official once every finished race counted here has been finalized.
  const counted = db.prepare(
    "SELECT results_finalized_at FROM motos WHERE event_id = ? AND status = 'completed' AND type != 'practice'",
  ).all(eventId) as Array<{ results_finalized_at: string | null }>;
  const official = overall.format === "enduro"
    ? !!overall.official
    : counted.length > 0 && counted.every(m => m.results_finalized_at != null);

  const regs = db.prepare(
    `SELECT reg.rider_id, reg.race_class, reg.ama_number, reg.bike_brand, reg.bike_model, reg.bike_year,
            reg.sponsors, reg.team_name, ri.first_name, ri.last_name
       FROM registrations reg
       INNER JOIN riders ri ON ri.id = reg.rider_id
      WHERE reg.event_id = ? AND reg.status != 'void'
      ORDER BY reg.id`,
  ).all(eventId) as any[];
  // Group races show the team (the captain's entry carries its name).
  const teamNames = new Map<number, string>();
  for (const r of regs) if (r.team_name && !teamNames.has(r.rider_id)) teamNames.set(r.rider_id, r.team_name);
  // The entry in the result's class, else the rider's first entry.
  const details = (riderId: number, raceClass: string) => {
    const r = regs.find(x => x.rider_id === riderId && x.race_class === raceClass) ?? regs.find(x => x.rider_id === riderId);
    const team = teamNames.get(riderId);
    return r ? {
      firstName: team ?? r.first_name ?? "", lastName: team ? "" : r.last_name ?? "", amaNumber: r.ama_number ?? null,
      bikeBrand: r.bike_brand, bikeModel: r.bike_model ?? null, bikeYear: r.bike_year ?? null, sponsors: r.sponsors,
    } : null;
  };

  let brands: string[] = [];
  try {
    const parsed = event.contingency_brands ? JSON.parse(event.contingency_brands) : null;
    if (Array.isArray(parsed)) brands = parsed;
  } catch { /* not a list: no brands */ }

  return res.json({
    eventId,
    eventName: event.name,
    eventDate: String(event.date).slice(0, 10),
    official,
    brands: buildContingencyReport(brands, overall.classes, details),
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
  if (!session?.userId) return res.status(401).json({ error: "You're signed out. Sign in again, then try once more." });

  const db = getDb();
  const eventId = Number(req.params.eventId);
  const { published } = req.body;
  const publishedBool = !!published;
  const now = new Date().toISOString();

  // Publishing finalizes every finished race; unpublishing reopens them.
  db.prepare(
    publishedBool
      ? "UPDATE motos SET results_finalized_at = ? WHERE event_id = ? AND status = 'completed' AND type != 'practice' AND results_finalized_at IS NULL"
      : "UPDATE motos SET results_finalized_at = NULL WHERE event_id = ? AND results_finalized_at IS NOT NULL",
  ).run(...(publishedBool ? [now, eventId] : [eventId]));

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
