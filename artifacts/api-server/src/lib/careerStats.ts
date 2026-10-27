/**
 * Career stats for one rider, computed from race results.
 *
 * Lap-by-lap running positions come from cumulative lap times of everyone in the
 * same moto (the same method the rider history uses for lap gaps), so they work
 * for live-timed, manually entered and imported results alike.
 */

export type LapValue = unknown;

export interface CareerMotoInput {
  motoId: number;
  motoType: string | null;
  position: number;
  dnf: boolean;
  dns: boolean;
  lapTimes: LapValue[];
  eventId: number;
  eventName: string;
  motoName: string;
  /** "motocross" starts lap 1 from the gate, so lap 1 isn't a comparable lap time. */
  raceStyle?: string | null;
}

export interface CareerStats {
  starts: number;
  finishes: number;
  dnfs: number;
  wins: number;
  podiums: number;
  top5s: number;
  avgFinish: number | null;
  totalLaps: number;
  lapsLed: number;
  pctLapsLed: number | null;
  lap1Leads: number;
  avgLap1Position: number | null;
  positionsGained: number;
  avgPositionsGained: number | null;
  bestLap: { ms: number; eventId: number; eventName: string; motoName: string } | null;
}

/** Parse a stored lap value (ms number, "m:ss.mmm" / "ss.mmm" string, or { time }) to ms. */
export function parseLapMs(lt: LapValue): number | null {
  if (typeof lt === "number") return lt > 0 ? lt : null;
  const s = lt && typeof lt === "object" && "time" in lt ? String((lt as { time: unknown }).time) : String(lt ?? "");
  const m = s.trim().match(/^(\d+):(\d{2})\.(\d{1,3})$/);
  if (m) return parseInt(m[1]) * 60_000 + parseInt(m[2]) * 1_000 + parseInt(m[3].padEnd(3, "0"));
  // A bare whole number above 1000 is milliseconds (some imports store ms as text).
  if (/^\d+$/.test(s.trim()) && parseInt(s.trim(), 10) > 1000) return parseInt(s.trim(), 10);
  const sec = s.trim().replace(/s$/i, "").match(/^(\d+)(?:\.(\d{1,3}))?$/);
  if (sec) return parseInt(sec[1]) * 1_000 + (sec[2] ? parseInt(sec[2].padEnd(3, "0")) : 0);
  return null;
}

/** Cumulative race time at the end of each lap, or null if any lap is unreadable. */
export function cumulativeMs(lapTimes: LapValue[]): number[] | null {
  const laps = (lapTimes ?? []).map(parseLapMs);
  if (laps.length === 0 || laps.some(l => l == null)) return null;
  const cum: number[] = [];
  let t = 0;
  for (const l of laps) { t += l!; cum.push(t); }
  return cum;
}

/**
 * Running position at the end of each lap: rank of this rider's cumulative time among
 * everyone in the moto who completed that lap. `field` includes this rider.
 */
export function lapPositions(mine: number[], field: number[][]): number[] {
  return mine.map((myCum, i) => 1 + field.filter(f => f[i] != null && f[i] < myCum).length);
}

const FINISH_SENTINEL = 999; // live timing's placeholder before positions are final

export function computeCareerStats(
  motos: CareerMotoInput[],
  fieldByMoto: Map<number, number[][]>,
): CareerStats {
  const raced = motos.filter(m => m.motoType !== "practice");
  const starts = raced.filter(m => !m.dns);
  const finishes = starts.filter(m => !m.dnf && m.position > 0 && m.position < FINISH_SENTINEL);

  let totalLaps = 0, lapsLed = 0, lap1Leads = 0, lap1Sum = 0, lap1Count = 0, gained = 0, gainedCount = 0;
  let bestLap: CareerStats["bestLap"] = null;

  for (const m of starts) {
    const timedLaps = m.raceStyle === "motocross" ? (m.lapTimes ?? []).slice(1) : (m.lapTimes ?? []);
    for (const lt of timedLaps) {
      const ms = parseLapMs(lt);
      if (ms != null && (!bestLap || ms < bestLap.ms)) bestLap = { ms, eventId: m.eventId, eventName: m.eventName, motoName: m.motoName };
    }
    const cum = cumulativeMs(m.lapTimes);
    if (!cum) continue;
    totalLaps += cum.length;
    const field = fieldByMoto.get(m.motoId) ?? [cum];
    const pos = lapPositions(cum, field);
    lapsLed += pos.filter(p => p === 1).length;
    if (pos.length > 0) {
      lap1Sum += pos[0]; lap1Count++;
      if (pos[0] === 1) lap1Leads++;
      if (!m.dnf && m.position > 0 && m.position < FINISH_SENTINEL) { gained += pos[0] - m.position; gainedCount++; }
    }
  }

  const round1 = (n: number) => Math.round(n * 10) / 10;
  return {
    starts: starts.length,
    finishes: finishes.length,
    dnfs: starts.filter(m => m.dnf).length,
    wins: finishes.filter(m => m.position === 1).length,
    podiums: finishes.filter(m => m.position <= 3).length,
    top5s: finishes.filter(m => m.position <= 5).length,
    avgFinish: finishes.length ? round1(finishes.reduce((s, m) => s + m.position, 0) / finishes.length) : null,
    totalLaps,
    lapsLed,
    pctLapsLed: totalLaps ? round1((lapsLed / totalLaps) * 100) : null,
    lap1Leads,
    avgLap1Position: lap1Count ? round1(lap1Sum / lap1Count) : null,
    positionsGained: gained,
    avgPositionsGained: gainedCount ? round1(gained / gainedCount) : null,
    bestLap,
  };
}
