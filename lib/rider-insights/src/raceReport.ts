/**
 * Race Report maths and plain-language takeaways. Pure functions (no React
 * Native imports) so they can be unit tested: lib/raceReport.test.ts.
 *
 * Takeaways come from fixed rules over the rider's own data, so they are
 * always true. Each one is a short sentence (about 12 words or fewer).
 */

/** Parse a lap string ("1:55.732", "58.41", "58.41s", or "115732" ms) to milliseconds; null if unreadable. */
export function parseLap(s: string | null | undefined): number | null {
  if (!s) return null;
  const t = s.trim().replace(/s$/i, "");
  // A bare whole number above 1000 is milliseconds (some imports store ms as text), as on the server.
  if (/^\d+$/.test(t) && parseInt(t, 10) > 1000) return parseInt(t, 10);
  const c = t.indexOf(":");
  const ms = c >= 0
    ? (parseInt(t.slice(0, c), 10) * 60 + parseFloat(t.slice(c + 1))) * 1000
    : parseFloat(t) * 1000;
  return Number.isFinite(ms) && ms > 0 ? Math.round(ms) : null;
}

/** "1:55.7" or "58.4": lap times rounded to tenths, for chart labels. */
export function fmtLapShort(ms: number | null | undefined): string {
  if (ms == null || !Number.isFinite(ms)) return "—";
  const tenths = Math.round(ms / 100);
  const m = Math.floor(tenths / 600);
  const s = ((tenths % 600) / 10).toFixed(1);
  return m > 0 ? `${m}:${s.padStart(4, "0")}` : s;
}

/** "1.6 s": a time difference in seconds, to tenths. */
export function fmtSecs(ms: number): string {
  return `${(Math.abs(ms) / 1000).toFixed(1)} s`;
}

export interface LapSummary {
  /** Every lap in ms (null if unreadable), lap 1 first. */
  laps: Array<number | null>;
  /** Index of the first lap that counts for pace (1 in motocross, where lap 1 includes the start). */
  firstCounted: number;
  bestIndex: number | null;
  bestMs: number | null;
  /** Slowest minus fastest counted lap. */
  rangeMs: number | null;
}

export function summarizeLaps(lapTimes: string[], skipFirstLap: boolean): LapSummary {
  const laps = lapTimes.map(parseLap);
  const firstCounted = skipFirstLap && laps.length > 1 ? 1 : 0;
  let bestIndex: number | null = null;
  let worst: number | null = null;
  for (let i = firstCounted; i < laps.length; i++) {
    const v = laps[i];
    if (v == null) continue;
    if (bestIndex == null || v < laps[bestIndex]!) bestIndex = i;
    if (worst == null || v > worst) worst = v;
  }
  const bestMs = bestIndex != null ? laps[bestIndex] : null;
  return { laps, firstCounted, bestIndex, bestMs, rangeMs: bestMs != null && worst != null ? worst - bestMs : null };
}

/** Lap chart: where the fastest lap came and how much the rider faded after it. */
export function lapTakeaway(sum: LapSummary): string | null {
  const counted = sum.laps.slice(sum.firstCounted).filter((v): v is number => v != null);
  if (counted.length < 2 || sum.bestIndex == null || sum.bestMs == null) return null;
  const lastIndex = sum.laps.length - 1;
  const last = sum.laps[lastIndex];
  if (sum.bestIndex === lastIndex) return "Fastest on the last lap. Strong finish.";
  if (last != null && last - sum.bestMs >= 1000) {
    return `Fastest on lap ${sum.bestIndex + 1}. Last lap was ${fmtSecs(last - sum.bestMs)} slower.`;
  }
  return `Fastest on lap ${sum.bestIndex + 1}. Laps stayed within ${fmtSecs(sum.rangeMs ?? 0)}.`;
}

/** Gap-to-leader chart, from the history API's lapGaps[].leader (ms; 0 = leading). */
export function gapTakeaway(leaderGaps: Array<number | null>): string | null {
  const gaps = leaderGaps.filter((g): g is number => g != null);
  if (gaps.length < 2) return null;
  if (gaps.every(g => g === 0)) return "Led every lap.";
  const final = gaps[gaps.length - 1];
  if (final === 0) {
    let k = gaps.length - 1;
    while (k > 0 && gaps[k - 1] === 0) k--;
    return `Took the lead on lap ${k + 1} and kept it.`;
  }
  // Led at some point but not at the finish: that's the headline.
  const lastLed = gaps.lastIndexOf(0);
  if (lastLed >= 0) return `Led on lap ${lastLed + 1}, finished ${fmtSecs(final)} behind the leader.`;
  let maxIdx = 0;
  for (let i = 1; i < gaps.length; i++) if (gaps[i] > gaps[maxIdx]) maxIdx = i;
  // A late comeback: the gap peaked before the finish and the rider closed at least 2 s.
  if (maxIdx > 0 && maxIdx < gaps.length - 1 && gaps[maxIdx] - final >= 2000) {
    return `Gap peaked at ${fmtSecs(gaps[maxIdx])} on lap ${maxIdx + 1}, then you closed ${fmtSecs(gaps[maxIdx] - final)}.`;
  }
  let minIdx = 0;
  for (let i = 1; i < gaps.length; i++) if (gaps[i] < gaps[minIdx]) minIdx = i;
  const min = gaps[minIdx];
  if (minIdx < gaps.length - 1 && final - min >= 1000) {
    return `${fmtSecs(min)} back on lap ${minIdx + 1}, then lost ${fmtSecs(final - min)} more.`;
  }
  if (gaps[0] - final >= 1000) return `Gained ${fmtSecs(gaps[0] - final)} on the leader after lap 1.`;
  return `Finished ${fmtSecs(final)} behind the leader.`;
}

/**
 * Position chart, from positionByLap (1 = leading at the end of that lap).
 * Mentions the best (or worst) lap when the race moved around, so a rider who
 * led mid-race isn't told they "held" a position.
 */
export function positionTakeaway(positions: Array<number | null>): string | null {
  const laps = positions.map((p, i) => ({ p, lap: i + 1 })).filter((x): x is { p: number; lap: number } => x.p != null);
  if (laps.length < 2) return null;
  const first = laps[0].p;
  const last = laps[laps.length - 1].p;
  const best = laps.reduce((a, b) => (b.p < a.p ? b : a));
  const worst = laps.reduce((a, b) => (b.p > a.p ? b : a));
  if (best.p === worst.p) return first === 1 ? "Led from lap 1 to the flag." : `Held P${first} from lap 1 to the finish.`;
  // Higher than both the start and the finish at some point: that's the headline.
  if (best.p < first && best.p < last) {
    return best.p === 1
      ? `Led on lap ${best.lap}, finished P${last}.`
      : `Ran as high as P${best.p} (lap ${best.lap}), finished P${last}.`;
  }
  if (first === last) return `Dropped as low as P${worst.p} (lap ${worst.lap}), back to P${last} by the finish.`;
  const d = first - last;
  return d > 0
    ? `P${first} after lap 1, finished P${last}: up ${d}.`
    : `P${first} after lap 1, finished P${last}: down ${-d}.`;
}

export interface SectorRow { index: number; name: string; lossMs: number }

/** Each sector: the rider's best split minus the fastest split in the race. */
export function sectorLosses(names: string[], bestMs: Array<number | null>, fieldBestMs: Array<number | null>): SectorRow[] {
  const rows: SectorRow[] = [];
  names.forEach((name, i) => {
    const mine = bestMs[i];
    const field = fieldBestMs[i];
    if (mine == null || field == null) return;
    rows.push({ index: i, name, lossMs: Math.max(0, mine - field) });
  });
  return rows;
}

export function sectorTakeaway(rows: SectorRow[]): string | null {
  if (rows.length === 0) return null;
  const worst = rows.reduce((a, b) => (b.lossMs > a.lossMs ? b : a));
  if (worst.lossMs < 100) return "Within 0.1 s of the fastest rider in every sector.";
  return `${worst.name || `Sector ${worst.index + 1}`} costs you most: ${fmtSecs(worst.lossMs)} off the fastest.`;
}

export interface TeamMemberLaps { name: string; isYou: boolean; lapTimes: string[] }

/** Group races: the rider's best lap against the quickest teammate's. */
export function teamTakeaway(members: TeamMemberLaps[]): string | null {
  const best = (m: TeamMemberLaps) => {
    const v = m.lapTimes.map(parseLap).filter((x): x is number => x != null);
    return v.length ? Math.min(...v) : null;
  };
  const you = members.find(m => m.isYou);
  if (!you) return null;
  const yourBest = best(you);
  const others = members.filter(m => !m.isYou).map(m => ({ m, b: best(m) })).filter((o): o is { m: TeamMemberLaps; b: number } => o.b != null);
  if (yourBest == null || others.length === 0) return null;
  const quickest = others.reduce((a, b) => (b.b < a.b ? b : a));
  const first = quickest.m.name.split(" ")[0] || "Your teammate";
  const diff = yourBest - quickest.b;
  if (diff >= 100) return `${first}'s best lap was ${fmtSecs(diff)} quicker than yours.`;
  if (diff <= -100) return `Your best lap was ${fmtSecs(diff)} quicker than ${first}'s.`;
  return `You and ${first} matched on best lap.`;
}

/** Evenly spaced axis ticks that cover [min, max], with "nice" steps (1, 2, 5 × 10ⁿ). */
export function niceTicks(min: number, max: number, count = 3): number[] {
  if (!Number.isFinite(min) || !Number.isFinite(max)) return [];
  if (max === min) return [min];
  const raw = (max - min) / Math.max(1, count);
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const step = [1, 2, 5, 10].map(m => m * mag).find(s => s >= raw) ?? 10 * mag;
  const ticks: number[] = [];
  for (let v = Math.ceil(min / step) * step; v <= max + step * 1e-9; v += step) ticks.push(Number(v.toFixed(6)));
  return ticks;
}
