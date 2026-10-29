/**
 * Motocross lap scoring from crossing times (pure; shared rules for the cloud
 * API and the desktop's local server, which keeps a copy).
 *
 * - Laps belong to the rider, not the tag: a rider's crossings from every tag
 *   and manual entries are merged and ordered by time.
 * - Lap 1 runs from the moto's start; each later lap from the rider's previous
 *   crossing.
 * - The checkered flag: once the leader finishes (the lap count in a fixed-lap
 *   race; the extra laps after the time-limit flag in a timed race), every
 *   other rider finishes on their next crossing. Crossings after a rider's
 *   checkered (cool-down laps) don't count.
 */

export type ScoringMoto = {
  startedAt: Date;
  lapCount: number | null;
  timeLimitMs: number | null;
  plusLaps: number | null;
  timeExpiredAt: Date | null;
};

const ms = (d: Date) => d.getTime();

function sortedTimes(times: Date[], startedAt: Date): Date[] {
  return times.filter(t => ms(t) >= ms(startedAt)).sort((a, b) => ms(a) - ms(b));
}

/**
 * When the leader took the checkered flag, or null while the race is on.
 * `riders` holds each rider's crossing times (any order).
 */
export function computeFinishAt(moto: ScoringMoto, riders: Date[][]): Date | null {
  const lists = riders.map(r => sortedTimes(r, moto.startedAt));

  if (moto.timeLimitMs && moto.timeExpiredAt) {
    const flag = moto.timeExpiredAt;
    const plus = Math.max(0, moto.plusLaps ?? 0);
    // No extra laps: everyone finishes on their first crossing after the flag.
    if (plus === 0) return flag;
    // The leader at the flag: most laps completed by then, then the earliest to get there.
    let leader: Date[] | null = null;
    let best = { laps: -1, last: Infinity };
    for (const list of lists) {
      const before = list.filter(t => ms(t) <= ms(flag));
      const last = before.length ? ms(before[before.length - 1]) : Infinity;
      if (before.length > best.laps || (before.length === best.laps && last < best.last)) {
        best = { laps: before.length, last };
        leader = list;
      }
    }
    if (!leader) return null;
    const after = leader.filter(t => ms(t) > ms(flag));
    return after.length >= plus ? after[plus - 1] : null;
  }

  if (moto.lapCount && moto.lapCount > 0 && !moto.timeLimitMs) {
    const finishes = lists.filter(l => l.length >= moto.lapCount!).map(l => ms(l[moto.lapCount! - 1]));
    return finishes.length ? new Date(Math.min(...finishes)) : null;
  }
  return null;
}

export type RiderScore = {
  /** Crossings that count, in order. */
  counted: Date[];
  lapTimes: number[];
  totalMs: number;
  /** Took the checkered flag. */
  finished: boolean;
};

export function scoreRider(moto: ScoringMoto, crossings: Date[], finishAt: Date | null): RiderScore {
  const list = sortedTimes(crossings, moto.startedAt);
  let counted = list;
  let finished = false;
  if (finishAt) {
    const idx = list.findIndex(t => ms(t) >= ms(finishAt));
    if (idx >= 0) {
      counted = list.slice(0, idx + 1);
      finished = true;
    }
  }
  if (moto.lapCount && moto.lapCount > 0 && !moto.timeLimitMs && counted.length >= moto.lapCount) {
    counted = counted.slice(0, moto.lapCount);
    finished = true;
  }
  const lapTimes = counted.map((t, i) => ms(t) - ms(i === 0 ? moto.startedAt : counted[i - 1]));
  return { counted, lapTimes, totalMs: lapTimes.reduce((s, t) => s + t, 0), finished };
}

/** Riders that have taken the flag vs. riders still expected (raced at least one lap, not out). */
export function everyoneFinished(scores: Array<{ score: RiderScore; out: boolean }>): boolean {
  const racing = scores.filter(s => !s.out && s.score.counted.length > 0);
  return racing.length > 0 && racing.every(s => s.score.finished);
}

/**
 * How long after the leader's finish to wait for the rest before closing the
 * moto: one and a half of the leader's typical laps, between 1 and 5 minutes.
 */
export function finishGraceMs(leaderLapTimes: number[]): number {
  const laps = leaderLapTimes.slice(1).length ? leaderLapTimes.slice(1) : leaderLapTimes;
  if (laps.length === 0) return 3 * 60_000;
  const sorted = [...laps].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];
  return Math.min(5 * 60_000, Math.max(60_000, Math.round(median * 1.5)));
}

/** Finishing order: more laps first, then less total time; riders out (DNF/DNS) last. */
export function compareStandings(
  a: { laps: number; totalMs: number; out?: boolean },
  b: { laps: number; totalMs: number; out?: boolean },
): number {
  if (!!a.out !== !!b.out) return a.out ? 1 : -1;
  return b.laps - a.laps || a.totalMs - b.totalMs;
}

/** Time-limit flag time for a timed race: start + limit + any red-flag time, or null if not yet. */
export function flagTimeFor(
  moto: { startedAt: Date | null; timeLimitMs: number | null; totalPausedMs: number; pausedAt: Date | null },
  nowMs = Date.now(),
): Date | null {
  if (!moto.startedAt || !moto.timeLimitMs || moto.pausedAt) return null;
  const flag = ms(moto.startedAt) + moto.timeLimitMs + Math.max(0, moto.totalPausedMs);
  return nowMs >= flag ? new Date(flag) : null;
}
