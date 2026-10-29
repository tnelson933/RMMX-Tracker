import { db } from "@workspace/db";
import { eventsTable, motosTable, raceResultsTable, ridersTable, seriesTable } from "@workspace/db";
import { and, eq, inArray, ne } from "drizzle-orm";
import { calcPoints, loadSeriesScoring } from "./scoringTables";
import { compareOverall, countFinishes, isLowerBetter, olympicPenalty, overallPositions, type OverallRow } from "./overallOrder";

type Series = typeof seriesTable.$inferSelect;

/**
 * Which events and classes count toward a series. Used by every series
 * calculation (standings pages and the stored series_points) so they agree.
 *
 * An event counts when it is in `series.eventIds` or one of its classes is
 * linked to the series in `raceClassSeriesMap`. When any class of an event is
 * linked, only linked classes count; otherwise (older events) every class does.
 */
export async function seriesScope(series: Series): Promise<{
  eventIds: number[];
  eligibleClasses: Map<number, Set<string> | null>;
}> {
  const listed = [...new Set(((series.eventIds as number[]) ?? []).map(Number).filter(Number.isFinite))];
  const clubEvents = await db.select({ id: eventsTable.id, map: eventsTable.raceClassSeriesMap })
    .from(eventsTable).where(eq(eventsTable.clubId, series.clubId));

  const eligibleClasses = new Map<number, Set<string> | null>();
  const linkedOnly: number[] = [];
  for (const evt of clubEvents) {
    const map = (evt.map ?? {}) as Record<string, number[]>;
    const classes = new Set<string>();
    for (const [cls, ids] of Object.entries(map)) {
      if (Array.isArray(ids) && ids.map(Number).includes(series.id)) classes.add(cls.trim());
    }
    if (classes.size > 0) {
      eligibleClasses.set(evt.id, classes);
      if (!listed.includes(evt.id)) linkedOnly.push(evt.id);
    } else if (listed.includes(evt.id)) {
      eligibleClasses.set(evt.id, null);
    }
  }
  // Events from another club never count, even if listed.
  const eventIds = [...listed.filter(id => eligibleClasses.has(id)), ...linkedOnly];
  return { eventIds, eligibleClasses };
}

/** Is this finished moto's class counted for the series? */
export function motoCounts(
  eligibleClasses: Map<number, Set<string> | null>,
  moto: { eventId: number; raceClass: string | null },
): boolean {
  const classes = eligibleClasses.get(moto.eventId);
  if (classes === undefined) return false;
  if (classes === null) return true;
  return moto.raceClass != null && classes.has(moto.raceClass.trim());
}

export interface SeriesStandingRow {
  position: number;
  riderId: number;
  riderName: string;
  raceClass: string;
  totalScore: number;
  eventsEntered: number;
  /** Every counted race in this class has been finalized by the organizer. */
  official: boolean;
  /** Olympic scoring: the lowest total wins. */
  lowerIsBetter: boolean;
  events: Array<{
    eventId: number;
    eventName: string;
    eventScore: number;
    attended: boolean;
    motos: number[];
    finishPositions: (number | null)[];
  }>;
}

/**
 * Series standings per class from the points stored on each result. Finished
 * races are public; `official` says whether a class's races are all finalized.
 */
export async function computeSeriesStandings(series: Series): Promise<{ standings: SeriesStandingRow[]; eventIds: number[] }> {
  const { eventIds, eligibleClasses } = await seriesScope(series);
  if (eventIds.length === 0) return { standings: [], eventIds };

  const events = await db.select({ id: eventsTable.id, name: eventsTable.name })
    .from(eventsTable).where(inArray(eventsTable.id, eventIds));
  const eventNameMap = new Map(events.map(e => [e.id, e.name]));

  const finishedMotos = (await db.select().from(motosTable)
    .where(and(
      inArray(motosTable.eventId, eventIds),
      eq(motosTable.status, "completed"),
      ne(motosTable.type, "practice"),
    )))
    // Enduro tests are created for "All Classes"; their results carry the
    // rider's class and are split by it below.
    .filter(m => m.type === "enduro_test" ? eligibleClasses.has(m.eventId) : motoCounts(eligibleClasses, m));
  if (finishedMotos.length === 0) return { standings: [], eventIds };

  const allResults = await db.select({
    motoId: raceResultsTable.motoId,
    riderId: raceResultsTable.riderId,
    firstName: ridersTable.firstName,
    lastName: ridersTable.lastName,
    position: raceResultsTable.position,
    points: raceResultsTable.points,
    dnf: raceResultsTable.dnf,
    dns: raceResultsTable.dns,
    raceClass: raceResultsTable.raceClass,
  }).from(raceResultsTable)
    .leftJoin(ridersTable, eq(raceResultsTable.riderId, ridersTable.id))
    .where(inArray(raceResultsTable.motoId, finishedMotos.map(m => m.id)));

  // A race is keyed by moto, or by moto and class for an enduro test, which
  // counts as one race per class that rode it.
  const raceKey = (motoId: number, enduroClass?: string | null) =>
    enduroClass != null ? `${motoId}:${enduroClass.trim()}` : String(motoId);
  const enduroMotoIds = new Set(finishedMotos.filter(m => m.type === "enduro_test").map(m => m.id));
  const keyOfResult = (r: { motoId: number; raceClass: string | null }) =>
    raceKey(r.motoId, enduroMotoIds.has(r.motoId) ? (r.raceClass ?? "") : null);
  const enduroClasses = new Map<number, Set<string>>();
  for (const r of allResults) {
    if (!enduroMotoIds.has(r.motoId)) continue;
    const cls = (r.raceClass ?? "").trim();
    if (!enduroClasses.has(r.motoId)) enduroClasses.set(r.motoId, new Set());
    enduroClasses.get(r.motoId)!.add(cls);
  }
  const allMotos = finishedMotos.flatMap(m => m.type === "enduro_test"
    ? [...(enduroClasses.get(m.id) ?? [])]
        .filter(cls => motoCounts(eligibleClasses, { eventId: m.eventId, raceClass: cls }))
        .map(cls => ({ ...m, raceClass: cls, key: raceKey(m.id, cls) }))
    : [{ ...m, key: raceKey(m.id) }]);
  if (allMotos.length === 0) return { standings: [], eventIds };
  // Points: the stored value (it includes club auto-DNF), or scored with the
  // series' table when none was stored. Same rule as the stored series totals.
  const scoring = await loadSeriesScoring(series.scoringTableId);
  const motoById = new Map(finishedMotos.map(m => [m.id, m]));
  const starters = new Map<string, number>();
  for (const r of allResults) if (!r.dns) starters.set(keyOfResult(r), (starters.get(keyOfResult(r)) ?? 0) + 1);
  // Olympic tables: lowest total wins and DNF/DNS/missed motos score penalties.
  const lowerIsBetter = isLowerBetter(scoring.scoringMethod);
  const classSizeOf = (key: string) => resultsByMoto.get(key)?.length ?? 0;
  const pointsFor = (r: (typeof allResults)[number]): number => {
    // Enduro: one award per event, stored on one test result (0 on the others).
    if (enduroMotoIds.has(r.motoId)) return r.points ?? 0;
    if (lowerIsBetter && (r.dnf || r.dns)) return olympicPenalty(r.dns ? "dns" : "dnf", classSizeOf(keyOfResult(r)));
    if (r.dnf || r.dns) return 0;
    if (r.points != null) return r.points;
    return calcPoints({
      position: r.position,
      dnf: false,
      dns: false,
      totalStarters: starters.get(keyOfResult(r)) ?? 1,
      ...scoring,
      motoType: motoById.get(r.motoId)?.type ?? "heat",
    });
  };

  const resultsByMoto = new Map<string, typeof allResults>();
  for (const r of allResults) {
    const key = keyOfResult(r);
    if (!resultsByMoto.has(key)) resultsByMoto.set(key, []);
    resultsByMoto.get(key)!.push(r);
  }

  // class → event → motos (in moto order)
  const byClass = new Map<string, Map<number, typeof allMotos>>();
  for (const moto of allMotos) {
    const cls = (moto.raceClass ?? "").trim();
    if (!byClass.has(cls)) byClass.set(cls, new Map());
    const byEvent = byClass.get(cls)!;
    if (!byEvent.has(moto.eventId)) byEvent.set(moto.eventId, []);
    byEvent.get(moto.eventId)!.push(moto);
  }

  const standings: SeriesStandingRow[] = [];
  for (const [raceClass, byEvent] of byClass) {
    const classMotos = [...byEvent.values()].flat();
    const official = classMotos.every(m => m.resultsFinalizedAt != null);
    const riderNames = new Map<number, string>();
    for (const m of classMotos) {
      for (const r of resultsByMoto.get(m.key) ?? []) {
        riderNames.set(r.riderId, `${r.firstName ?? ""} ${r.lastName ?? ""}`.trim());
      }
    }

    const rows: SeriesStandingRow[] = [];
    for (const [riderId, riderName] of riderNames) {
      let totalScore = 0;
      let eventsEntered = 0;
      const breakdown: SeriesStandingRow["events"] = [];
      for (const eventId of eventIds) {
        const motos = byEvent.get(eventId);
        if (!motos?.length) continue;
        const sorted = [...motos].sort((a, b) => (a.motoNumber ?? 0) - (b.motoNumber ?? 0));
        let eventScore = 0;
        let attended = false;
        const motoPoints: number[] = [];
        const finishPositions: (number | null)[] = [];
        for (const m of sorted) {
          const r = (resultsByMoto.get(m.key) ?? []).find(x => x.riderId === riderId);
          if (r) {
            attended = true;
            const pts = pointsFor(r);
            eventScore += pts;
            motoPoints.push(pts);
            finishPositions.push(r.dnf || r.dns ? null : (r.position ?? null));
          } else {
            // A missed moto: nothing on a points table, a DNS on an Olympic one
            // (not for enduro tests, which are scored once per event).
            const pts = lowerIsBetter && m.type !== "enduro_test" ? olympicPenalty("dns", classSizeOf(m.key)) : 0;
            eventScore += pts;
            motoPoints.push(pts);
            finishPositions.push(null);
          }
        }
        if (attended) eventsEntered++;
        totalScore += eventScore;
        breakdown.push({
          eventId,
          eventName: eventNameMap.get(eventId) ?? `Event ${eventId}`,
          eventScore,
          attended,
          motos: motoPoints,
          finishPositions,
        });
      }
      const finishes = breakdown.flatMap(e => e.finishPositions);
      rows.push({
        position: 0, riderId, riderName, raceClass, totalScore, eventsEntered, official, lowerIsBetter, events: breakdown,
        // For ordering: ties go to the count-back of moto finishes (points tables),
        // then the better finish in the class's last moto.
        _order: { total: totalScore, finishedAny: finishes.some(f => f != null), lastMotoFinish: finishes[finishes.length - 1] ?? null, finishCounts: countFinishes(finishes) },
      } as SeriesStandingRow & { _order: OverallRow });
    }

    const ordered = rows as Array<SeriesStandingRow & { _order: OverallRow }>;
    ordered.sort((a, b) => compareOverall(a._order, b._order, lowerIsBetter) || a.riderName.localeCompare(b.riderName));
    const positions = overallPositions(ordered.map(r => r._order), lowerIsBetter);
    ordered.forEach((row, idx) => { row.position = positions[idx]; delete (row as any)._order; });
    standings.push(...ordered);
  }
  return { standings, eventIds };
}
