// Series standings, computed exactly as the website does
// (api-server/src/lib/seriesStandings.ts). Keep the two in step.
import { getDb } from "../db";
import { formulaPoints } from "./safeFormula";
import { AMA_POINTS, compareOverall, countFinishes, isLowerBetter, olympicPenalty, overallPositions, type OverallRow } from "./overallOrder";
import { parseJson } from "./cloud-shape";

type SeriesRow = { id: number; club_id: number; event_ids: string | null; scoring_table_id: number | null };

/** Which events and classes count toward a series (cloud seriesScope). */
function seriesScope(series: SeriesRow) {
  const db = getDb();
  const listed = [...new Set(parseJson<unknown[]>(series.event_ids, []).map(Number).filter(Number.isFinite))];
  const clubEvents = db.prepare("SELECT id, race_class_series_map, date FROM events WHERE club_id = ? ORDER BY id").all(series.club_id) as Array<{ id: number; race_class_series_map: string | null; date: string | null }>;
  const eligibleClasses = new Map<number, Set<string> | null>();
  const linkedOnly: number[] = [];
  for (const evt of clubEvents) {
    const map = parseJson<Record<string, number[]>>(evt.race_class_series_map, {}) ?? {};
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
  // Rounds run in date order (then id), however they were added to the series
  // (cloud orderSeriesRounds): that decides the "last round" in a tie.
  const counted = new Set([...listed.filter(id => eligibleClasses.has(id)), ...linkedOnly]);
  const day = (d: unknown) => String(d ?? "").slice(0, 10) || "9999";
  const eventIds = clubEvents.filter(e => counted.has(e.id))
    .sort((a, b) => day(a.date).localeCompare(day(b.date)) || a.id - b.id)
    .map(e => e.id);
  return { eventIds, eligibleClasses };
}

function motoCounts(eligibleClasses: Map<number, Set<string> | null>, moto: { eventId: number; raceClass: string | null }): boolean {
  const classes = eligibleClasses.get(moto.eventId);
  if (classes === undefined) return false;
  if (classes === null) return true;
  return moto.raceClass != null && classes.has(moto.raceClass.trim());
}

/** Points for a finisher under the series' table (cloud calcPoints, finisher case). */
function tablePoints(scoring: { scoringMethod: string; pointsScale: number[]; scoringFormula: string | null; mainEventOnly: boolean }, position: number, starters: number, motoType: string): number {
  if (scoring.mainEventOnly && motoType !== "main") return 0;
  switch (scoring.scoringMethod) {
    case "formula": return scoring.scoringFormula ? formulaPoints(scoring.scoringFormula, position, starters) : 0;
    case "per_rider": return Math.max(0, starters - position + 1);
    case "highest_points": return scoring.pointsScale[position - 1] ?? 0;
    case "lowest_positions": return scoring.pointsScale[position - 1] ?? position;
    default: return AMA_POINTS[position - 1] ?? 0;
  }
}

export function computeSeriesStandings(series: SeriesRow): { standings: any[]; eventIds: number[] } {
  const db = getDb();
  const { eventIds, eligibleClasses } = seriesScope(series);
  if (eventIds.length === 0) return { standings: [], eventIds };
  const ph = eventIds.map(() => "?").join(",");

  const eventNameMap = new Map((db.prepare(`SELECT id, name FROM events WHERE id IN (${ph})`).all(...eventIds) as any[]).map(e => [e.id, e.name]));
  const finishedMotos = (db.prepare(
    `SELECT id, event_id AS eventId, race_class AS raceClass, type, moto_number AS motoNumber, results_finalized_at AS resultsFinalizedAt
     FROM motos WHERE event_id IN (${ph}) AND status = 'completed' AND type != 'practice' ORDER BY id`,
  ).all(...eventIds) as any[])
    .filter(m => m.type === "enduro_test" ? eligibleClasses.has(m.eventId) : motoCounts(eligibleClasses, m));
  if (finishedMotos.length === 0) return { standings: [], eventIds };

  const allResults = (db.prepare(
    `SELECT rr.moto_id AS motoId, rr.rider_id AS riderId, r.first_name AS firstName, r.last_name AS lastName,
            rr.position, rr.points, rr.dnf, rr.dns, rr.race_class AS raceClass
     FROM race_results rr LEFT JOIN riders r ON rr.rider_id = r.id
     WHERE rr.moto_id IN (${finishedMotos.map(() => "?").join(",")}) ORDER BY rr.id`,
  ).all(...finishedMotos.map(m => m.id)) as any[]).map(r => ({ ...r, dnf: r.dnf === 1, dns: r.dns === 1 }));

  // A race is a moto, or a moto and class for an enduro test (one race per class that rode it).
  const raceKey = (motoId: number, enduroClass?: string | null) => enduroClass != null ? `${motoId}:${enduroClass.trim()}` : String(motoId);
  const enduroMotoIds = new Set(finishedMotos.filter(m => m.type === "enduro_test").map(m => m.id));
  const keyOfResult = (r: { motoId: number; raceClass: string | null }) => raceKey(r.motoId, enduroMotoIds.has(r.motoId) ? (r.raceClass ?? "") : null);
  const enduroClasses = new Map<number, Set<string>>();
  for (const r of allResults) {
    if (!enduroMotoIds.has(r.motoId)) continue;
    if (!enduroClasses.has(r.motoId)) enduroClasses.set(r.motoId, new Set());
    enduroClasses.get(r.motoId)!.add((r.raceClass ?? "").trim());
  }
  const allMotos: any[] = finishedMotos.flatMap(m => m.type === "enduro_test"
    ? [...(enduroClasses.get(m.id) ?? [])]
        .filter(cls => motoCounts(eligibleClasses, { eventId: m.eventId, raceClass: cls }))
        .map(cls => ({ ...m, raceClass: cls, key: raceKey(m.id, cls) }))
    : [{ ...m, key: raceKey(m.id) }]);
  if (allMotos.length === 0) return { standings: [], eventIds };

  // Points: the stored value, or scored with the series' table when none was stored.
  const table = series.scoring_table_id ? db.prepare("SELECT * FROM points_tables WHERE id = ?").get(series.scoring_table_id) as any : null;
  const scoring = table
    ? { scoringMethod: String(table.scoring_method), pointsScale: parseJson<number[]>(table.points_scale, []) ?? [], scoringFormula: table.scoring_formula ?? null, mainEventOnly: table.main_event_only === 1 }
    : { scoringMethod: "fallback", pointsScale: [] as number[], scoringFormula: null, mainEventOnly: false };
  const motoById = new Map(finishedMotos.map(m => [m.id, m]));
  const starters = new Map<string, number>();
  for (const r of allResults) if (!r.dns) starters.set(keyOfResult(r), (starters.get(keyOfResult(r)) ?? 0) + 1);
  const lowerIsBetter = isLowerBetter(scoring.scoringMethod);
  const resultsByMoto = new Map<string, any[]>();
  for (const r of allResults) {
    const key = keyOfResult(r);
    if (!resultsByMoto.has(key)) resultsByMoto.set(key, []);
    resultsByMoto.get(key)!.push(r);
  }
  const classSizeOf = (key: string) => resultsByMoto.get(key)?.length ?? 0;
  const pointsFor = (r: any): number => {
    if (enduroMotoIds.has(r.motoId)) return r.points ?? 0;
    if (lowerIsBetter && (r.dnf || r.dns)) return olympicPenalty(r.dns ? "dns" : "dnf", classSizeOf(keyOfResult(r)));
    if (r.dnf || r.dns) return 0;
    if (r.points != null) return r.points;
    return tablePoints(scoring, r.position, starters.get(keyOfResult(r)) ?? 1, motoById.get(r.motoId)?.type ?? "heat");
  };

  const byClass = new Map<string, Map<number, any[]>>();
  for (const moto of allMotos) {
    const cls = (moto.raceClass ?? "").trim();
    if (!byClass.has(cls)) byClass.set(cls, new Map());
    const byEvent = byClass.get(cls)!;
    if (!byEvent.has(moto.eventId)) byEvent.set(moto.eventId, []);
    byEvent.get(moto.eventId)!.push(moto);
  }

  const standings: any[] = [];
  for (const [raceClass, byEvent] of byClass) {
    const classMotos = [...byEvent.values()].flat();
    const official = classMotos.every(m => m.resultsFinalizedAt != null);
    const riderNames = new Map<number, string>();
    for (const m of classMotos) {
      for (const r of resultsByMoto.get(m.key) ?? []) riderNames.set(r.riderId, `${r.firstName ?? ""} ${r.lastName ?? ""}`.trim());
    }
    const rows: Array<Record<string, any> & { _order: OverallRow }> = [];
    for (const [riderId, riderName] of riderNames) {
      let totalScore = 0;
      let eventsEntered = 0;
      const breakdown: any[] = [];
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
            // A missed moto: nothing on a points table, a DNS on an Olympic one.
            const pts = lowerIsBetter && m.type !== "enduro_test" ? olympicPenalty("dns", classSizeOf(m.key)) : 0;
            eventScore += pts;
            motoPoints.push(pts);
            finishPositions.push(null);
          }
        }
        if (attended) eventsEntered++;
        totalScore += eventScore;
        breakdown.push({ eventId, eventName: eventNameMap.get(eventId) ?? `Event ${eventId}`, eventScore, attended, motos: motoPoints, finishPositions });
      }
      const finishes = breakdown.flatMap(e => e.finishPositions as (number | null)[]);
      rows.push({
        position: 0, riderId, riderName, raceClass, totalScore, eventsEntered, official, lowerIsBetter, events: breakdown,
        _order: { total: totalScore, finishedAny: finishes.some(f => f != null), lastMotoFinish: finishes[finishes.length - 1] ?? null, finishCounts: countFinishes(finishes) },
      });
    }
    rows.sort((a, b) => compareOverall(a._order, b._order, lowerIsBetter) || String(a.riderName).localeCompare(String(b.riderName)));
    const positions = overallPositions(rows.map(r => r._order), lowerIsBetter);
    rows.forEach((row, idx) => { row.position = positions[idx]; delete (row as any)._order; });
    standings.push(...rows);
  }
  return { standings, eventIds };
}
