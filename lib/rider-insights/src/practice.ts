/**
 * Practice (Train › Track) trends. Practice at one track is the one place raw
 * lap times compare directly, so these charts use real lap times: laps in a
 * session, and best and average lap per session over time. Pure functions,
 * tested in lib/practice.test.ts.
 */
import { fmtLapShort, fmtSecs, type LapSummary } from "./raceReport";

export interface PracticeLap { lapNumber: number; lapTimeMs: number | null }
export interface PracticeSession {
  key: string;
  label: string;
  startedAt?: string | null;
  raceStyle?: string | null;
  myLaps: PracticeLap[];
}

/** Motocross lap 1 includes the start, so it doesn't count for pace. */
const counts = (lapNumber: number, raceStyle?: string | null) => raceStyle !== "motocross" || lapNumber > 1;

export interface SessionSummary extends LapSummary {
  /** The real lap number of each entry in `laps` (a session's first crossing has no lap time). */
  lapNumbers: number[];
}

/** A session's timed laps in order, for the lap chart and its takeaway. */
export function sessionSummary(laps: PracticeLap[], raceStyle?: string | null): SessionSummary {
  const sorted = [...laps].filter(l => (l.lapTimeMs ?? 0) > 0).sort((a, b) => a.lapNumber - b.lapNumber);
  const firstCounted = sorted.length > 1 && !counts(sorted[0].lapNumber, raceStyle) ? 1 : 0;
  const ms = sorted.map(l => l.lapTimeMs as number);
  let bestIndex: number | null = null;
  let worst: number | null = null;
  for (let i = firstCounted; i < ms.length; i++) {
    if (bestIndex == null || ms[i] < ms[bestIndex]) bestIndex = i;
    if (worst == null || ms[i] > worst) worst = ms[i];
  }
  const bestMs = bestIndex != null ? ms[bestIndex] : null;
  return {
    laps: ms, lapNumbers: sorted.map(l => l.lapNumber), firstCounted, bestIndex, bestMs,
    rangeMs: bestMs != null && worst != null ? worst - bestMs : null,
  };
}

/** Where the fastest lap came (by its real lap number) and how much the rider faded after it. */
export function sessionTakeaway(sum: SessionSummary): string | null {
  const counted = sum.laps.length - sum.firstCounted;
  if (counted < 2 || sum.bestIndex == null || sum.bestMs == null) return null;
  const lastIndex = sum.laps.length - 1;
  const last = sum.laps[lastIndex]!;
  const lapNo = sum.lapNumbers[sum.bestIndex];
  if (sum.bestIndex === lastIndex) return "Fastest on the last lap. Strong finish.";
  if (last - sum.bestMs >= 1000) return `Fastest on lap ${lapNo}. Last lap was ${fmtSecs(last - sum.bestMs)} slower.`;
  return `Fastest on lap ${lapNo}. Laps stayed within ${fmtSecs(sum.rangeMs ?? 0)}.`;
}

export interface SessionPoint { key: string; label: string; bestMs: number | null; avgMs: number | null; laps: number }

/** Best and average counted lap per session, oldest first. */
export function sessionTrend(sessions: PracticeSession[]): SessionPoint[] {
  return [...sessions]
    .map((s, i) => ({ s, i }))
    .sort((a, b) => {
      const ta = a.s.startedAt ? Date.parse(a.s.startedAt) : NaN;
      const tb = b.s.startedAt ? Date.parse(b.s.startedAt) : NaN;
      if (!Number.isNaN(ta) && !Number.isNaN(tb) && ta !== tb) return ta - tb;
      return a.i - b.i;
    })
    .map(({ s }) => {
      const sum = sessionSummary(s.myLaps, s.raceStyle);
      const counted = sum.laps.slice(sum.firstCounted).filter((v): v is number => v != null);
      return {
        key: s.key,
        label: s.label,
        bestMs: sum.bestMs,
        avgMs: counted.length ? Math.round(counted.reduce((a, b) => a + b, 0) / counted.length) : null,
        laps: sum.laps.length,
      };
    });
}

/** Progress at this track: improvement since the first session, or how close the latest is to the best. */
export function trendTakeaway(points: SessionPoint[], trackLabel: string): string | null {
  const p = points.filter(x => x.bestMs != null);
  if (p.length < 2) return null;
  const first = p[0].bestMs!, last = p[p.length - 1].bestMs!;
  const best = Math.min(...p.map(x => x.bestMs!));
  if (last === best && last < first) return `New best at ${trackLabel}: ${fmtLapShort(best)}, ${fmtSecs(first - best)} faster than your first session.`;
  if (best < first - 100 && last > best) return `Best lap down ${fmtSecs(first - best)} since your first session. Latest is ${fmtSecs(last - best)} off it.`;
  if (last > first + 100) return `Latest best is ${fmtSecs(last - first)} slower than your first session here.`;
  return `Best laps steady at about ${fmtLapShort(best)}.`;
}
