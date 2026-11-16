// The parts of the website's live leaderboard JSON that are derived from stored
// laps and results (api-server routes/timing.ts: buildRaceAnalytics, the lap
// normalizers, and lib/announcerLifecycle.ts calculateRaceTimeRemainingMs).
// Display only: nothing here scores a lap.
import { getDb } from "../db";

function formatLapTime(ms: number): string {
  if (ms <= 0) return "0:00.00";
  const minutes = Math.floor(ms / 60000);
  const seconds = Math.floor((ms % 60000) / 1000);
  const centis = Math.floor((ms % 1000) / 10);
  return `${minutes}:${String(seconds).padStart(2, "0")}.${String(centis).padStart(2, "0")}`;
}

/** "M:SS.f" or "M:SS.ff" → ms (0 when it can't be read). */
export function parseTimeToMs(t: string): number {
  try {
    const [minPart, rest] = t.split(":");
    const [secPart, fracPart] = rest.split(".");
    const frac = fracPart ? parseInt(fracPart.padEnd(3, "0").slice(0, 3), 10) : 0;
    const ms = (parseInt(minPart, 10) * 60 + parseInt(secPart, 10)) * 1000 + frac;
    return Number.isFinite(ms) ? ms : 0;
  } catch {
    return 0;
  }
}

/** A stored lap as milliseconds: a number, or an older `{ time: "M:SS.ff" }` entry. */
export function normalizeLapMs(val: unknown): number {
  if (typeof val === "number") return val;
  if (val && typeof val === "object" && "time" in val) return parseTimeToMs(String((val as { time: unknown }).time));
  return 0;
}

/** Time left on a timed race's clock (null when the race has no time limit or hasn't started). */
export function raceTimeRemainingMs(moto: any, nowMs = Date.now()): number | null {
  if (moto.time_limit_ms == null || !moto.started_at) return null;
  if (moto.time_expired_at) return 0;
  const effectiveNowMs = moto.paused_at ? new Date(moto.paused_at).getTime() : nowMs;
  const elapsedMs = Math.max(0, effectiveNowMs - new Date(moto.started_at).getTime() - Math.max(0, moto.total_paused_ms ?? 0));
  return Math.max(0, moto.time_limit_ms - elapsedMs);
}

type Entry = { position: number | null; riderId: number; riderName: string; bibNumber: string | null; laps: number; dnf: boolean; dns: boolean };

/** Race callouts for the live timing screen: biggest mover, most passes, fastest laps. */
export function buildRaceAnalytics(motoId: number, raceStyle: string | null | undefined, leaderboard: Entry[]) {
  const db = getDb();
  const activeEntries = leaderboard.filter(entry => !entry.dnf && !entry.dns);
  const activeRiderIds = new Set(activeEntries.map(entry => entry.riderId));
  const fieldCompletedLaps = activeEntries.length > 0 ? Math.min(...activeEntries.map(entry => entry.laps)) : 0;
  const requestedLapNumbers = [...new Set([
    1,
    fieldCompletedLaps > 1 ? fieldCompletedLaps - 1 : null,
    fieldCompletedLaps > 0 ? fieldCompletedLaps : null,
  ].filter((lap): lap is number => lap != null))];

  const crossings = db.prepare(
    `SELECT rider_id AS riderId, lap_number AS lapNumber FROM lap_crossings
     WHERE moto_id = ? AND lap_number IN (${requestedLapNumbers.map(() => "?").join(",")})
     ORDER BY crossing_time ASC, id ASC`,
  ).all(motoId, ...requestedLapNumbers) as Array<{ riderId: number | null; lapNumber: number | null }>;
  const fastestLapRows = db.prepare(
    `SELECT rider_id AS riderId, MIN(lap_time_ms) AS bestLapMs FROM lap_crossings
     WHERE moto_id = ? AND rider_id IS NOT NULL AND lap_number > ? AND lap_time_ms > 0
     GROUP BY rider_id`,
  ).all(motoId, raceStyle === "motocross" ? 1 : 0) as Array<{ riderId: number; bestLapMs: number | null }>;

  // Order at the line per lap: a rider's first crossing in a lap counts.
  const positionsByLap = new Map<number, Map<number, number>>();
  for (const crossing of crossings) {
    if (crossing.riderId == null || !activeRiderIds.has(crossing.riderId) || crossing.lapNumber == null || crossing.lapNumber < 1) continue;
    const lapPositions = positionsByLap.get(crossing.lapNumber) ?? new Map<number, number>();
    if (!lapPositions.has(crossing.riderId)) lapPositions.set(crossing.riderId, lapPositions.size + 1);
    positionsByLap.set(crossing.lapNumber, lapPositions);
  }
  const isCompleteFieldLap = (positions: Map<number, number> | undefined | null) =>
    !!positions && activeRiderIds.size > 0 && activeRiderIds.size === positions.size
    && [...activeRiderIds].every(riderId => positions.has(riderId));
  const firstLapCandidate = positionsByLap.get(1);
  const firstLapPositions = isCompleteFieldLap(firstLapCandidate) ? firstLapCandidate! : null;
  const latestLapCandidate = fieldCompletedLaps > 0 ? positionsByLap.get(fieldCompletedLaps) : undefined;
  const lastCompletedLap = isCompleteFieldLap(latestLapCandidate) ? fieldCompletedLaps : null;
  const previousLapPositions = lastCompletedLap && lastCompletedLap > 1 ? positionsByLap.get(lastCompletedLap - 1) ?? null : null;
  const latestLapPositions = lastCompletedLap ? latestLapCandidate ?? null : null;
  const currentPositions = new Map(
    leaderboard.filter(entry => !entry.dnf && !entry.dns && entry.position != null).map(entry => [entry.riderId, entry.position as number]),
  );
  const entryByRiderId = new Map(leaderboard.map(entry => [entry.riderId, entry]));
  const describeRider = (riderId: number) => {
    const entry = entryByRiderId.get(riderId);
    return entry ? { riderId: entry.riderId, riderName: entry.riderName, bibNumber: entry.bibNumber } : null;
  };

  let movingUp: Record<string, unknown> & { positionsGained: number } | null = null;
  if (previousLapPositions && latestLapPositions && lastCompletedLap && isCompleteFieldLap(previousLapPositions)) {
    for (const [riderId, fromPosition] of previousLapPositions) {
      const toPosition = latestLapPositions.get(riderId);
      const rider = describeRider(riderId);
      if (!rider || toPosition == null) continue;
      const positionsGained = fromPosition - toPosition;
      if (positionsGained > (movingUp?.positionsGained ?? 0)) {
        movingUp = { ...rider, positionsGained, fromPosition, toPosition, lapNumber: lastCompletedLap };
      }
    }
  }

  let mostPasses: Record<string, unknown> & { positionsGained: number } | null = null;
  let fallingBack: Record<string, unknown> & { positionsLost: number } | null = null;
  if (firstLapPositions) {
    for (const [riderId, startPosition] of firstLapPositions) {
      const currentPosition = currentPositions.get(riderId);
      const rider = describeRider(riderId);
      if (!rider || currentPosition == null) continue;
      const positionDelta = startPosition - currentPosition;
      if (positionDelta > (mostPasses?.positionsGained ?? 0)) {
        mostPasses = { ...rider, positionsGained: positionDelta, startPosition, currentPosition };
      }
      const positionsLost = currentPosition - startPosition;
      if (positionsLost > (fallingBack?.positionsLost ?? 0)) {
        fallingBack = { ...rider, positionsLost, startPosition, currentPosition };
      }
    }
  }

  const bestLapByRiderId = new Map(
    fastestLapRows.filter(row => row.riderId != null && row.bestLapMs != null && row.bestLapMs > 0).map(row => [row.riderId, Number(row.bestLapMs)]),
  );
  const fastestLaps = leaderboard
    .filter(entry => !entry.dnf && !entry.dns)
    .sort((a, b) => {
      const aBest = bestLapByRiderId.get(a.riderId) ?? null;
      const bBest = bestLapByRiderId.get(b.riderId) ?? null;
      if (aBest == null && bBest == null) return (a.position ?? 9999) - (b.position ?? 9999);
      if (aBest == null) return 1;
      if (bBest == null) return -1;
      return aBest - bBest;
    })
    .map(entry => {
      const bestLapMs = bestLapByRiderId.get(entry.riderId) ?? null;
      return {
        riderId: entry.riderId,
        riderName: entry.riderName,
        bibNumber: entry.bibNumber,
        bestLapMs,
        bestLap: bestLapMs != null ? formatLapTime(bestLapMs) : null,
      };
    });
  const timedFastestLaps = fastestLaps.filter(entry => entry.bestLapMs != null);
  const fastest = timedFastestLaps[0] ?? null;
  const nextFastest = timedFastestLaps[1] ?? null;

  return {
    lastCompletedLap,
    movingUp,
    mostPasses,
    fallingBack,
    fastestLap: fastest ? {
      ...fastest,
      marginMs: nextFastest ? (nextFastest.bestLapMs as number) - (fastest.bestLapMs as number) : null,
      margin: nextFastest ? formatLapTime((nextFastest.bestLapMs as number) - (fastest.bestLapMs as number)) : null,
      nextRiderName: nextFastest?.riderName ?? null,
    } : null,
    fastestLaps,
  };
}
