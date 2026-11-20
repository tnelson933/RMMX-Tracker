/**
 * Series standings per class as a pure function (no database): the cloud API
 * loads the rows and calls this, and tests run whole seasons through it.
 */
import { calcPoints } from "./motoPoints";
import { compareOverall, countFinishes, isLowerBetter, motoStatus, olympicPenalty, overallPositions, type OverallRow } from "./overallOrder";

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

/**
 * The series' rounds in the order they were raced: by event date, then id.
 * The tie-break "final moto of the last round" and the round columns follow
 * this order, however the events were added to the series.
 */
export function orderSeriesRounds(events: Array<{ id: number; date: unknown }>): number[] {
  const day = (d: unknown) => (d instanceof Date ? d.toISOString() : String(d ?? "")).slice(0, 10);
  return [...events]
    .sort((a, b) => (day(a.date) || "9999").localeCompare(day(b.date) || "9999") || a.id - b.id)
    .map(e => e.id);
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

/** A finished, non-practice moto of an event in the series. */
export interface SeriesMotoRow {
  id: number;
  eventId: number;
  type: string | null;
  raceClass: string | null;
  motoNumber: number | null;
  resultsFinalizedAt: unknown;
}

export interface SeriesResultRow {
  motoId: number;
  riderId: number;
  firstName: string | null;
  lastName: string | null;
  position: number;
  points: number | null;
  dnf: boolean;
  dns: boolean;
  raceClass: string | null;
}

export interface SeriesScoring {
  scoringMethod: string;
  pointsScale: number[];
  scoringFormula: string | null;
  mainEventOnly: boolean;
}

/**
 * Standings from the series' rounds (`eventIds`, in raced order), the classes
 * that count at each, their finished motos and those motos' results.
 */
export function buildSeriesStandings(input: {
  eventIds: number[];
  eventNames: Map<number, string>;
  eligibleClasses: Map<number, Set<string> | null>;
  motos: SeriesMotoRow[];
  results: SeriesResultRow[];
  scoring: SeriesScoring;
}): SeriesStandingRow[] {
  const { eventIds, eligibleClasses, scoring } = input;
  const eventNameMap = input.eventNames;
  // Enduro tests are created for "All Classes"; their results carry the
  // rider's class and are split by it below.
  const finishedMotos = input.motos
    .filter(m => m.type === "enduro_test" ? eligibleClasses.has(m.eventId) : motoCounts(eligibleClasses, m));
  if (finishedMotos.length === 0) return [];
  const counted = new Set(finishedMotos.map(m => m.id));
  const allResults = input.results.filter(r => counted.has(r.motoId));

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
  if (allMotos.length === 0) return [];
  // Points: the stored value (it includes club auto-DNF), or scored with the
  // series' table when none was stored. Same rule as the stored series totals.
  const motoById = new Map(finishedMotos.map(m => [m.id, m]));
  const starters = new Map<string, number>();
  for (const r of allResults) if (!r.dns) starters.set(keyOfResult(r), (starters.get(keyOfResult(r)) ?? 0) + 1);
  // Olympic tables: lowest total wins and DNF/DNS/missed motos score penalties.
  const lowerIsBetter = isLowerBetter(scoring.scoringMethod);
  // Olympic DNF/DNS penalties count the moto's starters (riders who aren't DNS).
  const classSizeOf = (key: string) => starters.get(key) ?? 0;
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
      const statuses: number[] = []; // outcome of each result, in raced order
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
            statuses.push(motoStatus(r));
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
        _order: { total: totalScore, finishedAny: finishes.some(f => f != null), lastMotoFinish: finishes[finishes.length - 1] ?? null, finishCounts: countFinishes(finishes), motoStatuses: [...statuses].reverse() },
      } as SeriesStandingRow & { _order: OverallRow });
    }

    const ordered = rows as Array<SeriesStandingRow & { _order: OverallRow }>;
    ordered.sort((a, b) => compareOverall(a._order, b._order, lowerIsBetter) || a.riderName.localeCompare(b.riderName));
    const positions = overallPositions(ordered.map(r => r._order), lowerIsBetter);
    ordered.forEach((row, idx) => { row.position = positions[idx]; delete (row as any)._order; });
    standings.push(...ordered);
  }
  return standings;
}
