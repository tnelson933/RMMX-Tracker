import { Router } from "express";
import { createContext, Script } from "vm";
import { db } from "@workspace/db";
import { raceResultsTable, motosTable, ridersTable, eventPublicationTable, registrationsTable, eventsTable, pointsTablesTable, clubsTable, seriesTable, seriesPointsTable } from "@workspace/db";
import { eq, and, inArray } from "drizzle-orm";
import { logger } from "../lib/logger";

const FALLBACK_POINTS = [25, 22, 20, 18, 16, 15, 14, 13, 12, 11, 10, 9, 8, 7, 6, 5, 4, 3, 2, 1];

/**
 * Safely evaluate a user-defined formula string.
 * Sandbox only exposes: position (1-based), riders (total starters), Math.
 * Returns 0 on any error or non-finite result.
 */
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

/**
 * Compute points for a single finisher given the event's scoring configuration.
 *
 * scoringMethod values:
 *   "formula"         — evaluate scoringFormula with {position, riders} in scope.
 *   "per_rider"       — 1st gets N pts (total starters), 2nd gets N-1, …, last gets 1.
 *   "highest_points"  — look up position in pointsScale (first entry = 1st place).
 *   "lowest_positions"— look up position in pointsScale; lower total is better (Olympic).
 *   (fallback)        — use hardcoded FALLBACK_POINTS array.
 *
 * mainEventOnly — if true, heats score 0; only moto type "main" scores points.
 * autoDnfEnabled/autoDnfThreshold — riders completing < threshold% of leader laps score 0.
 */
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

  // Auto DNF: rider completed too few laps vs the leader → treat as DNF for scoring
  if (
    opts.autoDnfEnabled &&
    opts.leaderLapsCompleted != null &&
    opts.leaderLapsCompleted > 0 &&
    opts.lapsCompleted != null &&
    opts.autoDnfThreshold != null
  ) {
    const minLaps = Math.floor(opts.leaderLapsCompleted * opts.autoDnfThreshold / 100);
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

/**
 * Recalculate and upsert series_points rows for the given series IDs.
 *
 * For each series:
 *  - Only counts motos whose raceClass is mapped to this series in that
 *    event's raceClassSeriesMap (the class-level series assignment).
 *  - Uses the series' own scoring table (falls back to FALLBACK_POINTS).
 *  - Passes the correct totalStarters (non-DNS count) for per_rider and
 *    formula-based scoring methods.
 *  - Logs errors instead of swallowing them silently.
 *
 * Safe to call repeatedly — replaces existing rows for the series.
 */
async function recalculateSeriesPoints(seriesIds: number[]): Promise<void> {
  if (seriesIds.length === 0) return;

  const allSeries = await db.select().from(seriesTable).where(inArray(seriesTable.id, seriesIds));

  for (const series of allSeries) {
    try {
      const eventIds = (series.eventIds as number[]) ?? [];
      if (eventIds.length === 0) continue;

      // Load scoring config for this series
      let seriesScoringMethod = "fallback";
      let seriesPointsScale: number[] = [];
      let seriesScoringFormula: string | null = null;
      let seriesMainEventOnly = false;
      if (series.scoringTableId) {
        const [tbl] = await db.select().from(pointsTablesTable)
          .where(eq(pointsTablesTable.id, series.scoringTableId));
        if (tbl) {
          seriesScoringMethod = tbl.scoringMethod;
          seriesPointsScale = (tbl.pointsScale as number[]) ?? [];
          seriesScoringFormula = tbl.scoringFormula ?? null;
          seriesMainEventOnly = tbl.mainEventOnly;
        }
      }

      // Load raceClassSeriesMap for every event in the series so we can
      // gate each moto result on whether that class is mapped to this series.
      const eventsData = await db.select({
        id: eventsTable.id,
        raceClassSeriesMap: eventsTable.raceClassSeriesMap,
      }).from(eventsTable).where(inArray(eventsTable.id, eventIds));

      // Map eventId → Set of raceClass strings that award points for this series,
      // OR null to mean "legacy mode — all classes eligible" (no per-class mapping set).
      const eligibleClassesByEvent = new Map<number, Set<string> | null>();
      for (const evt of eventsData) {
        const map = (evt.raceClassSeriesMap ?? {}) as Record<string, number[]>;
        const anyMappedToThisSeries = Object.values(map).some(ids =>
          (ids as number[]).includes(series.id)
        );
        if (anyMappedToThisSeries) {
          // Per-class mode: only classes explicitly mapped to this series earn points
          const classes = new Set<string>();
          for (const [cls, ids] of Object.entries(map)) {
            if ((ids as number[]).includes(series.id)) classes.add(cls);
          }
          eligibleClassesByEvent.set(evt.id, classes);
        } else {
          // Legacy mode: event is in series.eventIds but no per-class mapping configured —
          // treat all classes as eligible (preserves existing behavior)
          eligibleClassesByEvent.set(evt.id, null);
        }
      }

      // Collect all completed motos for all events in the series
      const motos = await db.select({
        id: motosTable.id,
        type: motosTable.type,
        raceClass: motosTable.raceClass,
        eventId: motosTable.eventId,
      }).from(motosTable)
        .where(and(inArray(motosTable.eventId, eventIds), eq(motosTable.status, "completed")));

      if (motos.length === 0) continue;

      // Filter to motos eligible for this series in their event:
      // - null (legacy mode) → all classes eligible
      // - Set<string> (per-class mode) → only motos whose raceClass is in the set
      const eligibleMotos = motos.filter(m => {
        const classes = eligibleClassesByEvent.get(m.eventId);
        if (classes === undefined) return false; // event not in series
        if (classes === null) return true; // legacy mode — all classes
        return m.raceClass != null && classes.has(m.raceClass);
      });
      if (eligibleMotos.length === 0) continue;

      const eligibleMotoIds = eligibleMotos.map(m => m.id);
      const motoTypeMap = new Map(eligibleMotos.map(m => [m.id, m.type ?? "heat"]));
      const motoEventMap = new Map(eligibleMotos.map(m => [m.id, m.eventId]));

      // Load all race results for eligible motos
      const results = await db.select({
        motoId: raceResultsTable.motoId,
        riderId: raceResultsTable.riderId,
        raceClass: raceResultsTable.raceClass,
        position: raceResultsTable.position,
        dnf: raceResultsTable.dnf,
        dns: raceResultsTable.dns,
      }).from(raceResultsTable).where(inArray(raceResultsTable.motoId, eligibleMotoIds));

      // Pre-compute totalStarters (non-DNS count) per moto for per_rider/formula scoring
      const startersByMoto = new Map<number, number>();
      for (const r of results) {
        if (!r.dns) {
          startersByMoto.set(r.motoId, (startersByMoto.get(r.motoId) ?? 0) + 1);
        }
      }

      // Aggregate points per (riderId, raceClass)
      const aggregate = new Map<string, { riderId: number; raceClass: string; totalPoints: number; eventsEntered: Set<number> }>();

      for (const r of results) {
        if (r.dns) continue; // DNS earns 0 points; skip entirely
        const motoType = motoTypeMap.get(r.motoId) ?? "heat";
        const motoEventId = motoEventMap.get(r.motoId) ?? 0;
        if (seriesMainEventOnly && motoType !== "main") continue;

        const totalStarters = startersByMoto.get(r.motoId) ?? 1;
        const pts = r.dnf ? 0 : calcPoints({
          position: r.position,
          dnf: !!r.dnf,
          dns: false,
          totalStarters,
          scoringMethod: seriesScoringMethod,
          pointsScale: seriesPointsScale,
          scoringFormula: seriesScoringFormula,
          mainEventOnly: seriesMainEventOnly,
          motoType,
        });

        const key = `${r.riderId}::${r.raceClass}`;
        if (!aggregate.has(key)) {
          aggregate.set(key, { riderId: r.riderId, raceClass: r.raceClass ?? "", totalPoints: 0, eventsEntered: new Set() });
        }
        const entry = aggregate.get(key)!;
        entry.totalPoints += pts;
        if (motoEventId) entry.eventsEntered.add(motoEventId);
      }

      if (aggregate.size === 0) continue;

      // Delete existing rows for this series then re-insert
      await db.delete(seriesPointsTable).where(eq(seriesPointsTable.seriesId, series.id));

      for (const entry of aggregate.values()) {
        await db.insert(seriesPointsTable).values({
          seriesId: series.id,
          riderId: entry.riderId,
          raceClass: entry.raceClass,
          totalPoints: entry.totalPoints,
          eventsEntered: entry.eventsEntered.size,
          eventResults: [],
        });
      }
    } catch (err) {
      logger.error({ err, seriesId: series.id }, "recalculateSeriesPoints failed for series");
    }
  }
}

const router = Router();

function getStaffClubId(res: any): number | null {
  const v = res.locals?.staffClubId;
  return typeof v === "number" ? v : null;
}

async function checkEventOwnership(eventId: number, staffCId: number | null, res: any): Promise<boolean> {
  if (staffCId === null) return true;
  const [evt] = await db.select({ clubId: eventsTable.clubId }).from(eventsTable).where(eq(eventsTable.id, eventId));
  if (!evt || evt.clubId !== staffCId) { res.status(403).json({ error: "Forbidden" }); return false; }
  return true;
}

router.get("/events/:eventId/results", async (req, res) => {
  const eventId = Number(req.params.eventId);

  // Unauthenticated requests (widgets, public pages) only see published events
  if (!(req.session as any).userId) {
    const [pub] = await db.select({ published: eventPublicationTable.published })
      .from(eventPublicationTable).where(eq(eventPublicationTable.eventId, eventId));
    if (!pub?.published) return res.json([]);
  }

  if (!await checkEventOwnership(eventId, getStaffClubId(res), res)) return;

  const results = await db.select({
    id: raceResultsTable.id,
    eventId: raceResultsTable.eventId,
    motoId: raceResultsTable.motoId,
    riderId: raceResultsTable.riderId,
    raceClass: raceResultsTable.raceClass,
    position: raceResultsTable.position,
    totalTime: raceResultsTable.totalTime,
    lapTimes: raceResultsTable.lapTimes,
    points: raceResultsTable.points,
    dnf: raceResultsTable.dnf,
    dns: raceResultsTable.dns,
    bibNumber: raceResultsTable.bibNumber,
    motoName: motosTable.name,
    firstName: ridersTable.firstName,
    lastName: ridersTable.lastName,
    amaNumber: registrationsTable.amaNumber,
    bikeBrand: registrationsTable.bikeBrand,
  }).from(raceResultsTable)
    .leftJoin(motosTable, eq(raceResultsTable.motoId, motosTable.id))
    .leftJoin(ridersTable, eq(raceResultsTable.riderId, ridersTable.id))
    .leftJoin(registrationsTable, and(
      eq(registrationsTable.riderId, raceResultsTable.riderId),
      eq(registrationsTable.eventId, raceResultsTable.eventId),
    ))
    .where(eq(raceResultsTable.eventId, eventId))
    .orderBy(raceResultsTable.position);

  return res.json(results.map(r => ({
    id: r.id,
    eventId: r.eventId,
    motoId: r.motoId,
    motoName: r.motoName || "",
    riderId: r.riderId,
    riderName: `${r.firstName} ${r.lastName}`,
    raceClass: r.raceClass,
    position: r.position,
    totalTime: r.totalTime,
    lapTimes: Array.isArray(r.lapTimes) ? r.lapTimes : [],
    points: r.points,
    dnf: r.dnf,
    dns: r.dns,
    bibNumber: r.bibNumber,
    amaNumber: r.amaNumber ?? null,
    bikeBrand: r.bikeBrand ?? null,
  })));
});

router.post("/events/:eventId/results", async (req, res) => {
  const eventId = Number(req.params.eventId);
  if (!await checkEventOwnership(eventId, getStaffClubId(res), res)) return;
  const { motoId, results: riderResults } = req.body;
  if (!motoId || !Array.isArray(riderResults)) return res.status(400).json({ error: "motoId and results[] required" });

  const [moto] = await db.select().from(motosTable).where(eq(motosTable.id, motoId));
  if (!moto) return res.status(404).json({ error: "Moto not found" });
  const raceClass = moto.raceClass;
  const motoType: string = (moto as any).type ?? "heat";

  // ── Resolve scoring table for this event ─────────────────────────────────
  const [event] = await db.select({ scoringTableId: eventsTable.scoringTableId, clubId: eventsTable.clubId })
    .from(eventsTable)
    .where(eq(eventsTable.id, eventId));

  let scoringMethod = "fallback";
  let pointsScale: number[] = [];
  let scoringFormula: string | null = null;
  let mainEventOnly = false;
  let autoDnfEnabled = false;
  let autoDnfThreshold = 75;

  if (event?.scoringTableId) {
    const [table] = await db.select().from(pointsTablesTable)
      .where(eq(pointsTablesTable.id, event.scoringTableId));
    if (table) {
      scoringMethod  = table.scoringMethod;
      pointsScale    = (table.pointsScale as number[]) ?? [];
      scoringFormula = table.scoringFormula ?? null;
      mainEventOnly  = table.mainEventOnly;
    }
  }

  // Auto DNF is a club-level setting — applies to all races regardless of scoring table
  if (event?.clubId) {
    const [club] = await db.select({ autoDnfEnabled: clubsTable.autoDnfEnabled, autoDnfThreshold: clubsTable.autoDnfThreshold })
      .from(clubsTable).where(eq(clubsTable.id, event.clubId));
    if (club) {
      autoDnfEnabled = club.autoDnfEnabled ?? false;
      autoDnfThreshold = club.autoDnfThreshold ?? 75;
    }
  }

  // Total starters = riders who are NOT dns (did not start)
  const totalStarters = riderResults.filter((r: any) => !r.dns).length;

  // Find the leader's lap count for Auto DNF calculation
  // Leader = position 1, not dnf, not dns — lapTimes array length = laps completed
  let leaderLapsCompleted: number | undefined;
  if (autoDnfEnabled) {
    const leader = riderResults.find((r: any) => r.position === 1 && !r.dnf && !r.dns);
    if (leader) {
      leaderLapsCompleted = Array.isArray(leader.lapTimes) ? leader.lapTimes.length : 0;
    }
  }

  // ── Delete existing results for this moto then re-insert (atomic) ────────
  const inserted: Record<string, unknown>[] = [];
  await db.transaction(async (tx) => {
    await tx.delete(raceResultsTable).where(eq(raceResultsTable.motoId, motoId));

    for (const r of riderResults) {
      const lapsCompleted = Array.isArray(r.lapTimes) ? r.lapTimes.length : 0;
      const points = calcPoints({
        position:      r.position,
        dnf:           !!r.dnf,
        dns:           !!r.dns,
        totalStarters,
        scoringMethod,
        pointsScale,
        scoringFormula,
        mainEventOnly,
        motoType,
        autoDnfEnabled,
        autoDnfThreshold,
        lapsCompleted,
        leaderLapsCompleted,
      });

      const [result] = await tx.insert(raceResultsTable).values({
        eventId, motoId, riderId: r.riderId, raceClass,
        position:  r.position,
        totalTime: r.totalTime || null,
        lapTimes:  r.lapTimes || [],
        points,
        dnf: r.dnf || false,
        dns: r.dns || false,
      }).returning();
      inserted.push(result as Record<string, unknown>);
    }

    // Mark moto as completed
    await tx.update(motosTable).set({ status: "completed" }).where(eq(motosTable.id, motoId));
  });

  // Award series points — union of:
  //  (a) per-class series from this event's raceClassSeriesMap[raceClass] (new)
  //  (b) legacy event-level series: all series that include this event in series.eventIds
  const fullEvent = await db.select({ raceClassSeriesMap: eventsTable.raceClassSeriesMap })
    .from(eventsTable).where(eq(eventsTable.id, eventId));
  const classSeriesMap = (fullEvent[0]?.raceClassSeriesMap ?? {}) as Record<string, number[]>;
  const perClassIds = new Set<number>(
    (classSeriesMap[raceClass] ?? []).filter((id: unknown) => typeof id === "number")
  );

  // Legacy: find all series that contain this event in their eventIds
  const allSeriesForClub = await db.select({ id: seriesTable.id, eventIds: seriesTable.eventIds })
    .from(seriesTable);
  for (const s of allSeriesForClub) {
    const ids = (s.eventIds as number[]) ?? [];
    if (ids.includes(eventId)) perClassIds.add(s.id);
  }

  if (perClassIds.size > 0) {
    recalculateSeriesPoints([...perClassIds]).catch((err: unknown) => {
      logger.error({ err, eventId, motoId }, "recalculateSeriesPoints failed after results save");
    });
  }

  return res.status(201).json(inserted.map(r => ({
    id: r.id,
    eventId: r.eventId,
    motoId: r.motoId,
    motoName: moto.name,
    riderId: r.riderId,
    riderName: "",
    raceClass: r.raceClass,
    position: r.position,
    totalTime: r.totalTime,
    lapTimes: Array.isArray(r.lapTimes) ? r.lapTimes : [],
    points: r.points,
    dnf: r.dnf,
    dns: r.dns,
    bibNumber: r.bibNumber,
  })));
});

function formatMs(ms: number): string {
  if (ms <= 0) return "0:00.00";
  const minutes = Math.floor(ms / 60000);
  const seconds = Math.floor((ms % 60000) / 1000);
  const centis = Math.floor((ms % 1000) / 10);
  return `${minutes}:${String(seconds).padStart(2, "0")}.${String(centis).padStart(2, "0")}`;
}

router.patch("/events/:eventId/results/:resultId/laps", async (req, res) => {
  const userId = (req.session as any).userId;
  if (!userId) { res.status(401).json({ error: "Unauthorized" }); return; }

  const eventId = Number(req.params.eventId);
  if (!await checkEventOwnership(eventId, getStaffClubId(res), res)) return;

  const resultId = Number(req.params.resultId);
  const { lapTimes } = req.body as { lapTimes?: unknown };

  if (!Array.isArray(lapTimes) || lapTimes.some((t) => typeof t !== "number")) {
    res.status(400).json({ error: "lapTimes must be an array of numbers (milliseconds)" });
    return;
  }

  const totalMs = (lapTimes as number[]).reduce((s, t) => s + t, 0);
  const totalTime = lapTimes.length > 0 ? formatMs(totalMs) : null;

  const [updated] = await db
    .update(raceResultsTable)
    .set({ lapTimes: lapTimes as number[], totalTime })
    .where(eq(raceResultsTable.id, resultId))
    .returning();

  if (!updated) { res.status(404).json({ error: "Result not found" }); return; }

  res.json({ id: updated.id, lapTimes: updated.lapTimes, totalTime: updated.totalTime });
});

router.post("/events/:eventId/results/publish", async (req, res) => {
  const eventId = Number(req.params.eventId);
  if (!await checkEventOwnership(eventId, getStaffClubId(res), res)) return;
  const { published } = req.body;

  const existing = await db.select().from(eventPublicationTable).where(eq(eventPublicationTable.eventId, eventId));
  if (existing[0]) {
    await db.update(eventPublicationTable).set({
      published,
      publishedAt: published ? new Date() : null,
      updatedAt: new Date(),
    }).where(eq(eventPublicationTable.eventId, eventId));
  } else {
    await db.insert(eventPublicationTable).values({ eventId, published, publishedAt: published ? new Date() : null });
  }

  return res.json({ ok: true, published });
});

// ── AMA Export CSV ─────────────────────────────────────────────────────────────
router.get("/events/:eventId/ama-export", async (req, res) => {
  const session = req.session as any;
  if (!session?.userId) return res.status(401).json({ error: "Unauthorized" });

  const eventId = Number(req.params.eventId);

  const [event] = await db.select().from(eventsTable).where(eq(eventsTable.id, eventId));
  if (!event) return res.status(404).json({ error: "Event not found" });
  const staffCId = getStaffClubId(res);
  if (staffCId !== null) {
    if (event.clubId !== staffCId) return res.status(403).json({ error: "Forbidden" });
  } else if ((event as any).clubId !== session.clubId && session.role !== "super_admin") {
    return res.status(403).json({ error: "Forbidden" });
  }

  const motos = await db.select().from(motosTable)
    .where(eq(motosTable.eventId, eventId))
    .orderBy(motosTable.id);

  const results = await db.select({
    riderId: raceResultsTable.riderId,
    motoId: raceResultsTable.motoId,
    position: raceResultsTable.position,
    raceClass: motosTable.raceClass,
    motoNumber: motosTable.motoNumber,
    firstName: ridersTable.firstName,
    lastName: ridersTable.lastName,
    city: ridersTable.city,
    homeState: ridersTable.homeState,
    amaNumber: registrationsTable.amaNumber,
    bibNumber: raceResultsTable.bibNumber,
  }).from(raceResultsTable)
    .innerJoin(motosTable, eq(raceResultsTable.motoId, motosTable.id))
    .innerJoin(ridersTable, eq(raceResultsTable.riderId, ridersTable.id))
    .leftJoin(registrationsTable, and(
      eq(registrationsTable.riderId, raceResultsTable.riderId),
      eq(registrationsTable.eventId, eventId),
    ))
    .where(eq(motosTable.eventId, eventId));

  // Also get homeState from riders (stored as separate column)
  const riderIds = [...new Set(results.map(r => r.riderId))];
  const riderRows = riderIds.length > 0
    ? await db.select({ id: ridersTable.id }).from(ridersTable).where(eq(ridersTable.id, riderIds[0]))
    : [];

  // Collect homeState via raw column access
  const riderHomeStateMap = new Map<number, string>();
  if (riderIds.length > 0) {
    const { sql: sqlTag } = await import("drizzle-orm");
    const homeStateRows = await db.execute(
      sqlTag`SELECT id, home_state FROM riders WHERE id = ANY(${riderIds})`
    );
    for (const row of homeStateRows.rows as Array<{ id: number; home_state: string | null }>) {
      riderHomeStateMap.set(Number(row.id), row.home_state ?? "");
    }
  }

  const amaEventId = (event as any).amaEventId ?? "";
  const eventDate = event.date ? String(event.date).substring(0, 10) : "";
  const trackName = event.trackName ?? event.name;

  const escCsv = (v: unknown): string => {
    const s = String(v ?? "");
    if (s.includes(",") || s.includes('"') || s.includes("\n")) return `"${s.replace(/"/g, '""')}"`;
    return s;
  };

  const header = ["AMA Event ID", "Event Name", "Event Date", "Track Name", "Class", "Moto", "AMA #", "Bib #", "First Name", "Last Name", "Hometown", "State", "Overall Position"].join(",");

  const rows: string[] = [header];
  for (const r of results) {
    rows.push([
      escCsv(amaEventId),
      escCsv(event.name),
      escCsv(eventDate),
      escCsv(trackName),
      escCsv(r.raceClass),
      escCsv(r.motoNumber),
      escCsv(r.amaNumber ?? ""),
      escCsv(r.bibNumber ?? ""),
      escCsv(r.firstName ?? ""),
      escCsv(r.lastName ?? ""),
      escCsv(r.city ?? ""),
      escCsv(r.homeState ?? riderHomeStateMap.get(r.riderId) ?? ""),
      escCsv(r.position ?? ""),
    ].join(","));
  }

  const filename = `ama-export-event-${eventId}.csv`;
  res.setHeader("Content-Type", "text/csv");
  res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
  return res.send(rows.join("\n"));
});

export default router;
