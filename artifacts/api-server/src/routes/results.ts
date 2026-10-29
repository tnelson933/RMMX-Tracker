import { Router } from "express";
import { computeEnduroEventOverall, computeEventOverall, eventLowerIsBetter } from "../lib/eventOverall";
import { buildContingencyReport } from "../lib/contingencyReport";
import { ENDURO_ALL_CLASSES, loadEnduroRiderClasses, rerankEnduroTest } from "./enduro-scoring";
import { syncEventPublication } from "../lib/resultsVisibility";
import { lapTimeToMs } from "../lib/lapScoring";
import { db } from "@workspace/db";
import { raceResultsTable, motosTable, ridersTable, eventPublicationTable, registrationsTable, eventsTable, pointsTablesTable, clubsTable, seriesTable, seriesPointsTable } from "@workspace/db";
import { eq, and, inArray, ne, isNull, isNotNull, sql, desc } from "drizzle-orm";
import { motoCounts, seriesScope } from "../lib/seriesStandings";
import { calcPoints, loadSeriesScoring } from "../lib/scoringTables";
import { isLowerBetter, olympicPenalty } from "../lib/overallOrder";
import { logger } from "../lib/logger";
import { formulaPoints } from "../lib/safeFormula";
import { notifyFollowersOfResults } from "../lib/riderCareer";
import { callerOwnsClub } from "../middleware/accessControl";
import { withMotoLock } from "./timing";


/** Slice a lapTimes array to at most lapCount entries. Handles null/undefined gracefully. */
function capLapTimes(lapTimes: unknown, lapCount: number | null | undefined): unknown[] {
  const arr = Array.isArray(lapTimes) ? lapTimes : [];
  if (lapCount != null && lapCount > 0) return arr.slice(0, lapCount);
  return arr;
}

/**
 * Parse a totalTime string ("M:SS.cc") to milliseconds for position sorting.
 * Returns Infinity when the string is missing or unparseable so those riders
 * sort to the back of their group (DNF/DNS groups are already separated).
 */
function parseResultTimeToMs(t: string | null | undefined): number {
  if (!t) return Infinity;
  try {
    const [minPart, rest] = t.split(":");
    const [secPart, fracPart] = rest.split(".");
    const mins = parseInt(minPart, 10);
    const secs = parseInt(secPart, 10);
    const frac = fracPart ? parseInt(fracPart.padEnd(3, "0").slice(0, 3), 10) : 0;
    return (mins * 60 + secs) * 1000 + frac;
  } catch {
    return Infinity;
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
export async function recalculateSeriesPoints(seriesIds: number[]): Promise<void> {
  if (seriesIds.length === 0) return;

  const allSeries = await db.select().from(seriesTable).where(inArray(seriesTable.id, seriesIds));

  for (const series of allSeries) {
    try {
      // Same events and classes as the standings pages (lib/seriesStandings.ts).
      const { eventIds, eligibleClasses } = await seriesScope(series);

      const {
        scoringMethod: seriesScoringMethod,
        pointsScale: seriesPointsScale,
        scoringFormula: seriesScoringFormula,
        mainEventOnly: seriesMainEventOnly,
      } = await loadSeriesScoring(series.scoringTableId);

      // Finished, non-practice motos whose class counts for this series.
      const eligibleMotos = eventIds.length === 0 ? [] : (await db.select({
        id: motosTable.id,
        type: motosTable.type,
        raceClass: motosTable.raceClass,
        eventId: motosTable.eventId,
      }).from(motosTable)
        .where(and(
          inArray(motosTable.eventId, eventIds),
          eq(motosTable.status, "completed"),
          ne(motosTable.type, "practice"),
        )))
        // Enduro tests are created for "All Classes"; their results carry the
        // rider's class and are filtered per result below.
        .filter(m => m.type === "enduro_test" ? eligibleClasses.has(m.eventId) : motoCounts(eligibleClasses, m));

      const eligibleMotoIds = eligibleMotos.map(m => m.id);
      const motoTypeMap = new Map(eligibleMotos.map(m => [m.id, m.type ?? "heat"]));
      const motoEventMap = new Map(eligibleMotos.map(m => [m.id, m.eventId]));

      const results = (eligibleMotoIds.length === 0 ? [] : await db.select({
        motoId: raceResultsTable.motoId,
        riderId: raceResultsTable.riderId,
        raceClass: raceResultsTable.raceClass,
        position: raceResultsTable.position,
        dnf: raceResultsTable.dnf,
        dns: raceResultsTable.dns,
        points: raceResultsTable.points,
      }).from(raceResultsTable).where(inArray(raceResultsTable.motoId, eligibleMotoIds)))
        .filter(r => motoTypeMap.get(r.motoId) !== "enduro_test"
          || motoCounts(eligibleClasses, { eventId: motoEventMap.get(r.motoId) ?? 0, raceClass: r.raceClass }));

      // Pre-compute totalStarters (non-DNS count) per moto for per_rider/formula scoring
      const startersByMoto = new Map<number, number>();
      for (const r of results) {
        if (!r.dns) {
          startersByMoto.set(r.motoId, (startersByMoto.get(r.motoId) ?? 0) + 1);
        }
      }

      // Aggregate points per (riderId, raceClass)
      const aggregate = new Map<string, { riderId: number; raceClass: string; totalPoints: number; eventsEntered: Set<number> }>();
      // Olympic (lowest wins): DNF/DNS and missed motos score penalties (lib/overallOrder.ts).
      const lowerIsBetter = isLowerBetter(seriesScoringMethod);
      const classSizeByMoto = new Map<number, number>();
      for (const r of results) classSizeByMoto.set(r.motoId, (classSizeByMoto.get(r.motoId) ?? 0) + 1);

      for (const r of results) {
        const motoType = motoTypeMap.get(r.motoId) ?? "heat";
        const motoEventId = motoEventMap.get(r.motoId) ?? 0;
        // Enduro: one award per event (stored on one test result; see
        // scoreEnduroEventPoints), so main-event-only doesn't apply.
        if (seriesMainEventOnly && motoType !== "main" && motoType !== "enduro_test") continue;
        if (r.dns && !lowerIsBetter) continue; // DNS earns 0 points; skip entirely

        const totalStarters = startersByMoto.get(r.motoId) ?? 1;
        // The points stored on the result (they include club auto-DNF); scored
        // with the series' table only when none were stored. Same rule as the
        // standings pages (lib/seriesStandings.ts).
        const pts = lowerIsBetter && (r.dnf || r.dns)
          ? olympicPenalty(r.dns ? "dns" : "dnf", classSizeByMoto.get(r.motoId) ?? 0)
          : r.dnf ? 0 : r.points ?? calcPoints({
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

        const raceClass = (r.raceClass ?? "").trim();
        const key = `${r.riderId}::${raceClass}`;
        if (!aggregate.has(key)) {
          aggregate.set(key, { riderId: r.riderId, raceClass, totalPoints: 0, eventsEntered: new Set() });
        }
        const entry = aggregate.get(key)!;
        entry.totalPoints += pts;
        if (motoEventId && !r.dns) entry.eventsEntered.add(motoEventId);
      }

      // Olympic: a moto of the rider's class they have no result in counts as a DNS.
      if (lowerIsBetter) {
        for (const entry of aggregate.values()) {
          for (const m of eligibleMotos) {
            if (m.type === "enduro_test") continue; // scored once per event, not per test
            if ((m.raceClass ?? "").trim() !== entry.raceClass) continue;
            if (seriesMainEventOnly && (m.type ?? "heat") !== "main") continue;
            if (results.some(r => r.motoId === m.id && r.riderId === entry.riderId)) continue;
            entry.totalPoints += olympicPenalty("dns", classSizeByMoto.get(m.id) ?? 0);
          }
        }
      }

      // Replace this series' rows in one transaction. The advisory lock keeps two
      // recalculations (fired by back-to-back saves) from interleaving and
      // doubling rows. Runs even when nothing counts, so removed events drop out.
      await db.transaction(async (tx) => {
        await tx.execute(sql`select pg_advisory_xact_lock(${SERIES_POINTS_LOCK}, ${series.id})`);
        await tx.delete(seriesPointsTable).where(eq(seriesPointsTable.seriesId, series.id));
        const rows = [...aggregate.values()].map(entry => ({
          seriesId: series.id,
          riderId: entry.riderId,
          raceClass: entry.raceClass,
          totalPoints: entry.totalPoints,
          eventsEntered: entry.eventsEntered.size,
          eventResults: [],
        }));
        if (rows.length > 0) await tx.insert(seriesPointsTable).values(rows);
      });
    } catch (err) {
      logger.error({ err, seriesId: series.id }, "recalculateSeriesPoints failed for series");
    }
  }
}

/** Advisory-lock namespace for series_points rebuilds. */
const SERIES_POINTS_LOCK = 7_320_001;

const router = Router();

function getStaffClubId(res: any): number | null {
  const v = res.locals?.staffClubId;
  return typeof v === "number" ? v : null;
}

/**
 * AMA number and bike per rider for an event, taken from non-void registrations.
 * Looked up separately instead of joined so a rider with several class entries
 * never duplicates result rows. Prefers the entry in the result's class.
 */
async function registrationDetailsLookup(eventId: number) {
  const regs = await db.select({
    riderId: registrationsTable.riderId,
    raceClass: registrationsTable.raceClass,
    amaNumber: registrationsTable.amaNumber,
    bikeBrand: registrationsTable.bikeBrand,
  }).from(registrationsTable)
    .where(and(eq(registrationsTable.eventId, eventId), ne(registrationsTable.status, "void")))
    .orderBy(registrationsTable.id);
  const byClass = new Map<string, { amaNumber: string | null; bikeBrand: string | null }>();
  const byRider = new Map<number, { amaNumber: string | null; bikeBrand: string | null }>();
  for (const r of regs) {
    const details = { amaNumber: r.amaNumber ?? null, bikeBrand: r.bikeBrand ?? null };
    const key = `${r.riderId}|${r.raceClass}`;
    if (!byClass.has(key)) byClass.set(key, details);
    if (!byRider.has(r.riderId)) byRider.set(r.riderId, details);
  }
  return (riderId: number, raceClass: string | null) =>
    byClass.get(`${riderId}|${raceClass}`) ?? byRider.get(riderId) ?? { amaNumber: null, bikeBrand: null };
}

/** The signed-in caller's club owns this event (or the caller is a super admin). */
async function callerOwnsEvent(eventId: number, res: any): Promise<boolean> {
  if (res.locals?.callerIsSuperAdmin === true) return true;
  if (typeof res.locals?.callerClubId !== "number") return false;
  const [evt] = await db.select({ clubId: eventsTable.clubId }).from(eventsTable).where(eq(eventsTable.id, eventId));
  return !!evt && callerOwnsClub(res, evt.clubId);
}

async function checkEventOwnership(eventId: number, staffCId: number | null, res: any): Promise<boolean> {
  if (staffCId === null) return true;
  const [evt] = await db.select({ clubId: eventsTable.clubId }).from(eventsTable).where(eq(eventsTable.id, eventId));
  if (!evt || evt.clubId !== staffCId) { res.status(403).json({ error: "Forbidden" }); return false; }
  return true;
}

router.get("/events/:eventId/results", async (req, res) => {
  const eventId = Number(req.params.eventId);

  // Everyone sees finished motos' results, each marked official (finalized by
  // the organizer) or unofficial. The owning club also sees motos in progress.
  const ownerView = await callerOwnsEvent(eventId, res);

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
    lapCount: motosTable.lapCount,
    timeLimitMs: motosTable.timeLimitMs,
    motoStatus: motosTable.status,
    motoType: motosTable.type,
    resultsFinalizedAt: motosTable.resultsFinalizedAt,
    firstName: ridersTable.firstName,
    lastName: ridersTable.lastName,
  }).from(raceResultsTable)
    .leftJoin(motosTable, eq(raceResultsTable.motoId, motosTable.id))
    .leftJoin(ridersTable, eq(raceResultsTable.riderId, ridersTable.id))
    .where(eq(raceResultsTable.eventId, eventId))
    .orderBy(raceResultsTable.position);
  const regDetails = await registrationDetailsLookup(eventId);
  // Olympic tables rank the overall lowest first; the pages need to know.
  const lowerIsBetter = await eventLowerIsBetter(eventId);

  return res.json(results.filter(r => ownerView || r.motoStatus === "completed").map(r => ({
    id: r.id,
    eventId: r.eventId,
    motoId: r.motoId,
    // Practice isn't finalized; everything else is unofficial until it is.
    official: r.resultsFinalizedAt != null || r.motoType === "practice",
    lowerIsBetter,
    motoName: r.motoName || "",
    riderId: r.riderId,
    riderName: `${r.firstName} ${r.lastName}`,
    raceClass: r.raceClass,
    position: r.position,
    totalTime: r.totalTime,
    lapTimes: capLapTimes(r.lapTimes, r.timeLimitMs ? null : r.lapCount),
    points: r.points,
    dnf: r.dnf,
    dns: r.dns,
    bibNumber: r.bibNumber,
    amaNumber: regDetails(r.riderId, r.raceClass).amaNumber,
    bikeBrand: regDetails(r.riderId, r.raceClass).bikeBrand,
  })));
});

/** The event's points table and the club's auto-DNF settings. */
async function loadScoringSettings(eventId: number) {
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
  return { scoringMethod, pointsScale, scoringFormula, mainEventOnly, autoDnfEnabled, autoDnfThreshold };
}

/**
 * Recalculates series points for a class's series — union of:
 *  (a) per-class series from this event's raceClassSeriesMap[raceClass] (new)
 *  (b) legacy event-level series: all series that include this event in series.eventIds
 */
function awardSeriesPoints(eventId: number, raceClass: string, motoId: number): void {
  void (async () => {
    const fullEvent = await db.select({ raceClassSeriesMap: eventsTable.raceClassSeriesMap })
      .from(eventsTable).where(eq(eventsTable.id, eventId));
    const classSeriesMap = (fullEvent[0]?.raceClassSeriesMap ?? {}) as Record<string, number[]>;
    const perClassIds = new Set<number>(
      (classSeriesMap[raceClass] ?? []).filter((id: unknown) => typeof id === "number")
    );
    const allSeriesForClub = await db.select({ id: seriesTable.id, eventIds: seriesTable.eventIds })
      .from(seriesTable);
    for (const s of allSeriesForClub) {
      const ids = (s.eventIds as number[]) ?? [];
      if (ids.includes(eventId)) perClassIds.add(s.id);
    }
    if (perClassIds.size > 0) await recalculateSeriesPoints([...perClassIds]);
  })().catch((err: unknown) => {
    logger.error({ err, eventId, motoId }, "recalculateSeriesPoints failed after results save");
  });
}

/**
 * Points for a moto from its stored finishing order, the same way a manual
 * results save scores them. Used when a moto finishes on live timing, so the
 * results, the public page and series standings get points without the
 * organizer having to open Enter Results and press Save.
 */
export async function scoreMotoPoints(motoId: number): Promise<void> {
  const [moto] = await db.select().from(motosTable).where(eq(motosTable.id, motoId));
  if (!moto || moto.type === "practice") return;
  if (moto.type === "enduro_test") return scoreEnduroEventPoints(moto.eventId);
  const rows = await db.select().from(raceResultsTable).where(eq(raceResultsTable.motoId, motoId));
  if (rows.length === 0) return;
  const settings = await loadScoringSettings(moto.eventId);
  const totalStarters = rows.filter(r => !r.dns).length;
  const lapsOf = (r: typeof rows[number]) => (Array.isArray(r.lapTimes) ? r.lapTimes.length : 0);
  const leader = rows.find(r => r.position === 1 && !r.dnf && !r.dns);
  const leaderLapsCompleted = settings.autoDnfEnabled && leader ? lapsOf(leader) : undefined;
  for (const r of rows) {
    const points = calcPoints({
      position: r.position,
      dnf: !!r.dnf,
      dns: !!r.dns,
      totalStarters,
      classSize: rows.length,
      ...settings,
      motoType: moto.type ?? "heat",
      lapsCompleted: lapsOf(r),
      leaderLapsCompleted,
    });
    if (points !== r.points) await db.update(raceResultsTable).set({ points }).where(eq(raceResultsTable.id, r.id));
  }
  awardSeriesPoints(moto.eventId, moto.raceClass, motoId);
}

/**
 * Enduro points: one award per rider per event, from their class's event
 * overall position (sum of finished tests + time-check penalties), scored
 * with the event's points table the same way a moto finish is. The award is
 * stored on the rider's result in their latest finished test that they
 * finished (not DNF/DNS); their other finished-test results store 0, so
 * series totals and the overall count it once. Riders with no completed run
 * or a time-check DQ score 0. Re-run whenever a test finishes or is edited.
 */
export async function scoreEnduroEventPoints(eventId: number): Promise<void> {
  const overall = await computeEnduroEventOverall(eventId);
  if (overall.enduroTests.length === 0) return;
  const settings = await loadScoringSettings(eventId);
  const testIds = overall.enduroTests.map(t => t.motoId);
  const rows = await db.select({
    id: raceResultsTable.id,
    motoId: raceResultsTable.motoId,
    riderId: raceResultsTable.riderId,
    points: raceResultsTable.points,
    dnf: raceResultsTable.dnf,
    dns: raceResultsTable.dns,
    motoNumber: motosTable.motoNumber,
  }).from(raceResultsTable)
    .innerJoin(motosTable, eq(motosTable.id, raceResultsTable.motoId))
    .where(inArray(raceResultsTable.motoId, testIds))
    .orderBy(desc(motosTable.motoNumber), desc(motosTable.id));

  for (const cls of overall.classes) {
    const scored = cls.riders.filter(r => r.enduro && r.enduro.status !== "dq" && r.enduro.status !== "no_time");
    for (const rider of cls.riders) {
      const ranked = rider.enduro != null && rider.enduro.status !== "dq" && rider.enduro.status !== "no_time";
      const award = ranked ? calcPoints({
        position: rider.position,
        dnf: false,
        dns: false,
        totalStarters: scored.length,
        classSize: cls.riders.length,
        scoringMethod: settings.scoringMethod,
        pointsScale: settings.pointsScale,
        scoringFormula: settings.scoringFormula,
        mainEventOnly: false,
        motoType: "main",
      }) : 0;
      const mine = rows.filter(r => r.riderId === rider.riderId); // latest test first
      const carrier = mine.find(r => !r.dnf && !r.dns) ?? mine[0];
      for (const r of mine) {
        const points = r === carrier ? award : 0;
        if (r.points !== points) await db.update(raceResultsTable).set({ points }).where(eq(raceResultsTable.id, r.id));
      }
    }
  }
  for (const cls of overall.classes) awardSeriesPoints(eventId, cls.raceClass, testIds[0]);
}

router.post("/events/:eventId/results", async (req, res) => {
  const eventId = Number(req.params.eventId);
  if (!await checkEventOwnership(eventId, getStaffClubId(res), res)) return;
  const { motoId, results: riderResults } = req.body;
  if (!motoId || !Array.isArray(riderResults)) return res.status(400).json({ error: "motoId and results[] required" });

  const [moto] = await db.select().from(motosTable).where(eq(motosTable.id, Number(motoId)));
  // The moto must belong to this (ownership-checked) event, or results could be written into another club's race.
  if (!moto || moto.eventId !== eventId) return res.status(404).json({ error: "Moto not found" });
  const raceClass = moto.raceClass;
  const motoType: string = (moto as any).type ?? "heat";
  const isEnduroTest = motoType === "enduro_test";
  // Enduro tests are "All Classes"; each result is scored in the rider's class.
  const enduroClasses = isEnduroTest ? await loadEnduroRiderClasses(eventId) : null;
  const classFor = (r: any): string => {
    if (!enduroClasses) return raceClass;
    const sent = typeof r.raceClass === "string" ? r.raceClass.trim() : "";
    return enduroClasses.get(Number(r.riderId)) ?? (sent && sent !== ENDURO_ALL_CLASSES ? sent : raceClass);
  };

  const { scoringMethod, pointsScale, scoringFormula, mainEventOnly, autoDnfEnabled, autoDnfThreshold } = await loadScoringSettings(eventId);

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
  // Under the moto's lock so a late crossing can't rewrite a rider's laps mid-save.
  await withMotoLock(motoId, () => db.transaction(async (tx) => {
    await tx.delete(raceResultsTable).where(eq(raceResultsTable.motoId, motoId));

    for (const r of riderResults) {
      const lapsCompleted = Array.isArray(r.lapTimes) ? r.lapTimes.length : 0;
      const points = calcPoints({
        position:      r.position,
        dnf:           !!r.dnf,
        dns:           !!r.dns,
        totalStarters,
        classSize:     riderResults.length,
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

      // Don't cap laps by lapCount for time-limit motos — extra laps after the flag are valid
      // Stored as milliseconds, like live timing (the page sends "1:05.32" text).
      const cappedLaps = capLapTimes(r.lapTimes || [], (moto as any).timeLimitMs ? null : (moto as any).lapCount)
        .map(lapTimeToMs)
        .filter((ms): ms is number => ms != null);
      const [result] = await tx.insert(raceResultsTable).values({
        eventId, motoId, riderId: r.riderId, raceClass: classFor(r),
        position:  r.position,
        totalTime: r.totalTime || null,
        lapTimes:  cappedLaps,
        points,
        dnf:       r.dnf || false,
        dns:       r.dns || false,
        bibNumber: r.bibNumber || null,
      }).returning();
      inserted.push(result as Record<string, unknown>);
    }

    // Mark moto as completed
    await tx.update(motosTable).set({ status: "completed" }).where(eq(motosTable.id, motoId));
  }));

  if (isEnduroTest) {
    // Positions come from run times within each class; points from the event overall.
    await withMotoLock(Number(motoId), () => rerankEnduroTest(Number(motoId)));
    await scoreEnduroEventPoints(eventId);
    const fresh = await db.select().from(raceResultsTable).where(eq(raceResultsTable.motoId, Number(motoId)));
    const byId = new Map(fresh.map(r => [r.id, r]));
    for (let i = 0; i < inserted.length; i++) {
      const latest = byId.get(inserted[i].id as number);
      if (latest) inserted[i] = latest as unknown as Record<string, unknown>;
    }
  } else {
    awardSeriesPoints(eventId, raceClass, motoId);
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

  // Fetch the moto's lapCount to enforce the cap
  const [existingResult] = await db.select({ motoId: raceResultsTable.motoId })
    .from(raceResultsTable)
    .where(and(eq(raceResultsTable.id, resultId), eq(raceResultsTable.eventId, eventId)));
  if (!existingResult) { res.status(404).json({ error: "Result not found" }); return; }

  const [lapMoto] = await db.select({ lapCount: motosTable.lapCount, type: motosTable.type, status: motosTable.status })
    .from(motosTable).where(eq(motosTable.id, existingResult.motoId));

  const cappedLapTimes = capLapTimes(lapTimes as number[], lapMoto?.lapCount) as number[];
  const totalMs = cappedLapTimes.reduce((s, t) => s + t, 0);
  const totalTime = cappedLapTimes.length > 0 ? formatMs(totalMs) : null;

  const [updated] = await db
    .update(raceResultsTable)
    .set({ lapTimes: cappedLapTimes, totalTime })
    .where(and(eq(raceResultsTable.id, resultId), eq(raceResultsTable.eventId, eventId)))
    .returning();

  if (!updated) { res.status(404).json({ error: "Result not found" }); return; }

  if (lapMoto?.type === "enduro_test") {
    await withMotoLock(existingResult.motoId, () => rerankEnduroTest(existingResult.motoId));
    if (lapMoto.status === "completed") await scoreEnduroEventPoints(eventId);
  }

  res.json({ id: updated.id, lapTimes: updated.lapTimes, totalTime: updated.totalTime });
});

router.post("/events/:eventId/results/publish", async (req, res) => {
  const eventId = Number(req.params.eventId);
  if (!await checkEventOwnership(eventId, getStaffClubId(res), res)) return;
  const { published } = req.body;

  // Results are finalized moto by moto now; this switch (older pages and the
  // desktop app) finalizes, or reopens, every finished moto at once.
  await db.update(motosTable)
    .set({ resultsFinalizedAt: published === true ? new Date() : null })
    .where(and(
      eq(motosTable.eventId, eventId),
      eq(motosTable.status, "completed"),
      ne(motosTable.type, "practice"),
      published === true ? isNull(motosTable.resultsFinalizedAt) : isNotNull(motosTable.resultsFinalizedAt),
    ));
  const newlyPublished = await syncEventPublication(eventId);
  // Tell followers their riders' results are in (only when the event first becomes official).
  if (newlyPublished) void notifyFollowersOfResults(eventId);

  return res.json({ ok: true, published });
});

// ── Brand contingency report ─────────────────────────────────────────────────
// Each brand the event offers contingency with, and the finishers who ran it
// (bike brand or a listed sponsor), from the class overall. Promoters send this
// to each brand (or upload it to XTRM); the brand applies its own rules.
router.get("/events/:eventId/contingency-report", async (req, res) => {
  const session = req.session as any;
  if (!session?.userId) return res.status(401).json({ error: "Unauthorized" });
  const eventId = Number(req.params.eventId);
  const [event] = await db.select({
    id: eventsTable.id, clubId: eventsTable.clubId, name: eventsTable.name, date: eventsTable.date,
    contingencyBrands: eventsTable.contingencyBrands,
  }).from(eventsTable).where(eq(eventsTable.id, eventId));
  if (!event) return res.status(404).json({ error: "Event not found" });
  const staffCId = getStaffClubId(res);
  if (staffCId !== null) {
    if (event.clubId !== staffCId) return res.status(403).json({ error: "Forbidden" });
  } else if (event.clubId !== session.clubId && session.role !== "super_admin") {
    return res.status(403).json({ error: "Forbidden" });
  }

  const overall = await computeEventOverall(eventId);
  // Official once every finished race counted here has been finalized.
  const counted = await db.select({ finalizedAt: motosTable.resultsFinalizedAt }).from(motosTable)
    .where(and(eq(motosTable.eventId, eventId), eq(motosTable.status, "completed"), ne(motosTable.type, "practice")));
  const official = overall.format === "enduro"
    ? !!overall.official
    : counted.length > 0 && counted.every(m => m.finalizedAt != null);

  const regs = await db.select({
    riderId: registrationsTable.riderId,
    raceClass: registrationsTable.raceClass,
    amaNumber: registrationsTable.amaNumber,
    bikeBrand: registrationsTable.bikeBrand,
    bikeModel: registrationsTable.bikeModel,
    bikeYear: registrationsTable.bikeYear,
    sponsors: registrationsTable.sponsors,
    firstName: ridersTable.firstName,
    lastName: ridersTable.lastName,
  }).from(registrationsTable)
    .innerJoin(ridersTable, eq(registrationsTable.riderId, ridersTable.id))
    .where(and(eq(registrationsTable.eventId, eventId), ne(registrationsTable.status, "void")))
    .orderBy(registrationsTable.id);
  // The entry in the result's class, else the rider's first entry.
  const details = (riderId: number, raceClass: string) => {
    const r = regs.find(x => x.riderId === riderId && x.raceClass === raceClass) ?? regs.find(x => x.riderId === riderId);
    return r ? {
      firstName: r.firstName ?? "", lastName: r.lastName ?? "", amaNumber: r.amaNumber ?? null,
      bikeBrand: r.bikeBrand, bikeModel: r.bikeModel ?? null, bikeYear: r.bikeYear ?? null, sponsors: r.sponsors,
    } : null;
  };

  return res.json({
    eventId,
    eventName: event.name,
    eventDate: String(event.date).slice(0, 10),
    official,
    brands: buildContingencyReport((event.contingencyBrands as string[] | null) ?? [], overall.classes, details),
  });
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
    resultClass: raceResultsTable.raceClass,
    bibNumber: raceResultsTable.bibNumber,
  }).from(raceResultsTable)
    .innerJoin(motosTable, eq(raceResultsTable.motoId, motosTable.id))
    .innerJoin(ridersTable, eq(raceResultsTable.riderId, ridersTable.id))
    .where(eq(motosTable.eventId, eventId));
  const amaRegDetails = await registrationDetailsLookup(eventId);

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
      // Build "IN ($1, $2, …)": interpolating the array directly made "ANY(($1,$2))", which Postgres rejects.
      sqlTag`SELECT id, home_state FROM riders WHERE id IN (${sqlTag.join(riderIds.map(id => sqlTag`${id}`), sqlTag`, `)})`
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
      escCsv(amaRegDetails(r.riderId, r.resultClass ?? r.raceClass).amaNumber ?? ""),
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
