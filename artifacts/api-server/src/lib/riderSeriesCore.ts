/**
 * A rider's place in each series they've raced, from the official standings
 * (pure; routes/rider-portal.ts loads the standings). The rider app shows the
 * series a rider ranks highest in on its tiles, then every series in a list.
 */
import type { SeriesStandingRow } from "./seriesStandingsCore";

export interface RiderSeriesEntry {
  seriesId: number;
  seriesName: string;
  season: number | string | null;
  eventIds: number[];
  raceClass: string;
  riderId: number;
  riderName: string;
  /** The rider's series total (points, or Olympic score when lowerIsBetter). */
  totalPoints: number;
  position: number;
  /** Riders ranked in this class of the series. */
  ridersInClass: number;
  lowerIsBetter: boolean;
  /** Every counted race in the class is finalized. */
  official: boolean;
  /** Moto wins, top-3 moto finishes and motos finished. */
  wins: number;
  podiums: number;
  motosFinished: number;
  bestFinish: number | null;
  /** Rounds the rider raced, of the rounds run so far in this class. */
  roundsRaced: number;
  roundsRun: number;
  /** How far the rider is from the class leader's total (0 for the leader). */
  gapToLeader: number;
}

/** One entry per class of the series that any of these riders is ranked in. */
export function riderSeriesEntries(
  series: { id: number; name: string; season: number | string | null; eventIds: number[] },
  standings: SeriesStandingRow[],
  riderIds: number[],
): RiderSeriesEntry[] {
  const entries: RiderSeriesEntry[] = [];
  for (const row of standings) {
    if (!riderIds.includes(row.riderId)) continue;
    const inClass = standings.filter(s => s.raceClass === row.raceClass);
    const leader = inClass.reduce((best, s) => (s.position < best.position ? s : best), inClass[0]);
    const finishes = row.events.flatMap(e => e.finishPositions).filter((p): p is number => p != null);
    entries.push({
      seriesId: series.id,
      seriesName: series.name,
      season: series.season,
      eventIds: series.eventIds,
      raceClass: row.raceClass,
      riderId: row.riderId,
      riderName: row.riderName,
      totalPoints: row.totalScore,
      position: row.position,
      ridersInClass: inClass.length,
      lowerIsBetter: row.lowerIsBetter,
      official: row.official,
      wins: finishes.filter(p => p === 1).length,
      podiums: finishes.filter(p => p <= 3).length,
      motosFinished: finishes.length,
      bestFinish: finishes.length ? Math.min(...finishes) : null,
      roundsRaced: row.eventsEntered,
      roundsRun: row.events.length,
      gapToLeader: Math.abs(leader.totalScore - row.totalScore),
    });
  }
  return entries;
}

/**
 * Best first: the highest place, then the bigger class (2nd of 30 beats 2nd of
 * 3), then the most recent season, then by name. The first entry is the series
 * the rider "ranks highest in".
 */
export function sortRiderSeries(entries: RiderSeriesEntry[]): RiderSeriesEntry[] {
  return [...entries].sort((a, b) =>
    a.position - b.position
    || b.ridersInClass - a.ridersInClass
    || String(b.season ?? "").localeCompare(String(a.season ?? ""))
    || a.seriesName.localeCompare(b.seriesName)
    || a.raceClass.localeCompare(b.raceClass));
}
