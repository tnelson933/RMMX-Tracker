/**
 * Overall order and Olympic (low-points) scoring rules, shared by the cloud
 * API, the offline server and the website (keep the copies identical; see
 * overallOrder.parity.test.ts).
 *
 * Olympic scoring follows the AMA amateur motocross rules (MX Sports
 * Competition Bulletin 2017-12, AMA rulebook):
 *   - a finish scores its position (or the table's value for it);
 *   - DNF scores the moto's starters (riders who aren't DNS), never less than 20;
 *   - DNS scores the moto's starters plus 30;
 *   - a missed moto scores as a DNS;
 *   - lowest total wins; a tie goes to the better finish in the last moto;
 *   - a rider must finish at least one moto to place ahead of anyone who did.
 * Points tables (highest total wins) break ties like AMA Pro Motocross and
 * Supercross:
 *   - an event overall: the better finish in the last moto;
 *   - a series championship: most wins, then most 2nds, 3rds, ... (count-back,
 *     when `finishCounts` is given), then the final moto of the last round.
 * On equal totals, both kinds also rank:
 *   - a rider who made the main event ahead of one who didn't (Supercross:
 *     a main-event DNF beats a heat-only DNQ), when `reachedMain` is given;
 *   - after the last-moto finish, DNF ahead of DNS, result by result from the
 *     rider's last one back, when `motoStatuses` is given. So [DNS, DNF] beats
 *     [DNF, DNS], and both beat [DNS, DNS]. Only motos the rider has a result in
 *     count (a heat they weren't in isn't a DNS).
 */

/**
 * AMA Supercross main events and Pro Motocross motos (same scale since 2024):
 * 25, 22, 20, 18, 17, 16 … one point less per place, 21st = 1.
 */
export const AMA_POINTS = [25, 22, 20, 18, 17, 16, 15, 14, 13, 12, 11, 10, 9, 8, 7, 6, 5, 4, 3, 2, 1];

export const OLYMPIC_DNF_MINIMUM = 20;
export const OLYMPIC_DNS_EXTRA = 30;

export function isLowerBetter(scoringMethod: string | null | undefined): boolean {
  return scoringMethod === "lowest_positions";
}

/**
 * Olympic score for a moto the rider didn't finish (DNF) or didn't start / missed
 * (DNS). `starters`: riders in the moto who aren't DNS (a 24-starter gate: DNF 24, DNS 54).
 */
export function olympicPenalty(kind: "dnf" | "dns", starters: number): number {
  const riders = Math.max(0, Math.floor(starters));
  return kind === "dns" ? riders + OLYMPIC_DNS_EXTRA : Math.max(riders, OLYMPIC_DNF_MINIMUM);
}

export interface OverallRow {
  /** Total score: points (higher wins) or Olympic score (lower wins). */
  total: number;
  /** Finished at least one moto. */
  finishedAny: boolean;
  /** Finishing position in the last moto (null: DNF, DNS or missed). */
  lastMotoFinish: number | null;
  /** Series count-back: finishCounts[0] = wins, [1] = 2nds, … (points tables). */
  finishCounts?: number[];
  /** Raced the class's main event (an event with a main; Supercross format). */
  reachedMain?: boolean;
  /** Outcome (MOTO_FINISHED / MOTO_DNF / MOTO_DNS) of each moto the rider has a result in, last first. */
  motoStatuses?: number[];
}

export const MOTO_FINISHED = 0;
export const MOTO_DNF = 1;
export const MOTO_DNS = 2;

/** A result's outcome for `motoStatuses`. */
export function motoStatus(r: { dnf?: boolean | null; dns?: boolean | null }): number {
  return r.dns ? MOTO_DNS : r.dnf ? MOTO_DNF : MOTO_FINISHED;
}

/** Last-moto finish, then DNF over DNS result by result from the last one back. */
function lastMotoTieBreak(a: OverallRow, b: OverallRow): number {
  const last = (a.lastMotoFinish ?? Number.MAX_SAFE_INTEGER) - (b.lastMotoFinish ?? Number.MAX_SAFE_INTEGER);
  if (last !== 0) return last;
  const sa = a.motoStatuses, sb = b.motoStatuses;
  if (sa && sb) {
    for (let i = 0; i < Math.max(sa.length, sb.length); i++) {
      const diff = (sa[i] ?? MOTO_DNS) - (sb[i] ?? MOTO_DNS);
      if (diff !== 0) return diff;
    }
  }
  return 0;
}

/** Made the main event ahead of didn't (only when both say). */
function mainEventTieBreak(a: OverallRow, b: OverallRow): number {
  if (a.reachedMain == null || b.reachedMain == null || a.reachedMain === b.reachedMain) return 0;
  return a.reachedMain ? -1 : 1;
}

/** finishCounts from finishing positions (nulls ignored). */
export function countFinishes(positions: Array<number | null | undefined>): number[] {
  const counts: number[] = [];
  for (const p of positions) {
    if (p == null || p < 1 || p >= 999) continue;
    while (counts.length < p) counts.push(0);
    counts[p - 1]++;
  }
  return counts;
}

/** Sort comparator: best first. */
export function compareOverall(a: OverallRow, b: OverallRow, lowerIsBetter: boolean): number {
  if (!lowerIsBetter) {
    if (b.total !== a.total) return b.total - a.total;
    const main = mainEventTieBreak(a, b);
    if (main !== 0) return main;
    if (a.finishCounts && b.finishCounts) {
      for (let i = 0; i < Math.max(a.finishCounts.length, b.finishCounts.length); i++) {
        const diff = (b.finishCounts[i] ?? 0) - (a.finishCounts[i] ?? 0);
        if (diff !== 0) return diff;
      }
    }
    return lastMotoTieBreak(a, b);
  }
  if (a.finishedAny !== b.finishedAny) return a.finishedAny ? -1 : 1;
  return a.total - b.total || mainEventTieBreak(a, b) || lastMotoTieBreak(a, b);
}

/** Overall positions for rows already sorted with compareOverall (ties share a position). */
export function overallPositions(sorted: OverallRow[], lowerIsBetter: boolean): number[] {
  const positions: number[] = [];
  sorted.forEach((row, i) => {
    positions.push(i > 0 && compareOverall(sorted[i - 1], row, lowerIsBetter) === 0 ? positions[i - 1] : i + 1);
  });
  return positions;
}
