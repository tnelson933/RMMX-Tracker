/**
 * Overall order and Olympic (low-points) scoring rules, shared by the cloud
 * API, the offline server and the website (keep the copies identical; see
 * overallOrder.parity.test.ts).
 *
 * Olympic scoring follows the AMA amateur motocross rules (MX Sports
 * Competition Bulletin 2017-12, AMA rulebook):
 *   - a finish scores its position (or the table's value for it);
 *   - DNF scores the number of riders in the class, never less than 20;
 *   - DNS scores the number of riders in the class plus 30;
 *   - a missed moto scores as a DNS;
 *   - lowest total wins; a tie goes to the better finish in the last moto;
 *   - a rider must finish at least one moto to place ahead of anyone who did.
 * Points tables (highest points wins) keep ranking by total points.
 */

export const OLYMPIC_DNF_MINIMUM = 20;
export const OLYMPIC_DNS_EXTRA = 30;

export function isLowerBetter(scoringMethod: string | null | undefined): boolean {
  return scoringMethod === "lowest_positions";
}

/** Olympic score for a moto the rider didn't finish (DNF) or didn't start / missed (DNS). */
export function olympicPenalty(kind: "dnf" | "dns", classSize: number): number {
  const riders = Math.max(0, Math.floor(classSize));
  return kind === "dns" ? riders + OLYMPIC_DNS_EXTRA : Math.max(riders, OLYMPIC_DNF_MINIMUM);
}

export interface OverallRow {
  /** Total score: points (higher wins) or Olympic score (lower wins). */
  total: number;
  /** Finished at least one moto. */
  finishedAny: boolean;
  /** Finishing position in the last moto (null: DNF, DNS or missed). */
  lastMotoFinish: number | null;
}

/** Sort comparator: best first. */
export function compareOverall(a: OverallRow, b: OverallRow, lowerIsBetter: boolean): number {
  if (!lowerIsBetter) return b.total - a.total;
  if (a.finishedAny !== b.finishedAny) return a.finishedAny ? -1 : 1;
  return a.total - b.total
    || (a.lastMotoFinish ?? Number.MAX_SAFE_INTEGER) - (b.lastMotoFinish ?? Number.MAX_SAFE_INTEGER);
}

/** Overall positions for rows already sorted with compareOverall (ties share a position). */
export function overallPositions(sorted: OverallRow[], lowerIsBetter: boolean): number[] {
  const positions: number[] = [];
  sorted.forEach((row, i) => {
    positions.push(i > 0 && compareOverall(sorted[i - 1], row, lowerIsBetter) === 0 ? positions[i - 1] : i + 1);
  });
  return positions;
}
