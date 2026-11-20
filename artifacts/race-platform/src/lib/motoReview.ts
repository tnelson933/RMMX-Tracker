/**
 * Review & finalize: which riders are listed for a finished moto, what each
 * row starts as, and the finishing positions that get saved (pure; the screen
 * is components/organizer/MotoResults.tsx).
 *
 * - Everyone on the lineup is listed, plus anyone who has a result without
 *   being on it (a late add scored by their tag). Saving replaces the moto's
 *   results with the listed rows, so a rider left off the list would lose
 *   their result.
 * - Once a moto has results, a lineup rider with none never completed a lap:
 *   they start as DNS, not as a finisher behind the field (which would score
 *   them points for a race they didn't ride).
 * - Saved positions are 1, 2, 3 … through the finishers in the order shown,
 *   then DNF, then DNS, so marking a rider DNF moves everyone behind them up.
 */

export interface ReviewEntry {
  riderId: number;
  bibNumber?: string | null;
  riderName?: string | null;
}

export interface StoredReviewResult {
  riderId: number;
  position: number;
  totalTime?: string | null;
  dnf?: boolean | null;
  dns?: boolean | null;
  lapTimes?: unknown;
  bibNumber?: string | null;
  riderName?: string | null;
}

export interface ReviewRow {
  pos: string;
  time: string;
  dnf: boolean;
  dns: boolean;
  laps: string[];
  totalOverridden: boolean;
  bibNumber: string;
  riderName: string;
}

/** Live timing's placeholder position before a rider is ranked. */
const UNRANKED = 999;

/** The lineup, then riders who have a result but aren't on the lineup (by finishing position). */
export function reviewEntries(lineup: ReviewEntry[] | null | undefined, stored: StoredReviewResult[]): ReviewEntry[] {
  const entries: ReviewEntry[] = [...(lineup ?? [])];
  const listed = new Set(entries.map(e => e.riderId));
  for (const r of [...stored].sort((a, b) => a.position - b.position)) {
    if (listed.has(r.riderId)) continue;
    listed.add(r.riderId);
    entries.push({ riderId: r.riderId, bibNumber: r.bibNumber ?? null, riderName: r.riderName ?? null });
  }
  return entries;
}

/** Each listed rider's starting row. `formatLap` turns a stored lap (ms or text) into the text shown. */
export function initialReviewRows(
  entries: ReviewEntry[],
  stored: StoredReviewResult[],
  lapCount: number | null | undefined,
  formatLap: (lap: string | number) => string,
): Record<number, ReviewRow> {
  const rows: Record<number, ReviewRow> = {};
  const scored = stored.length > 0;
  entries.forEach((entry, idx) => {
    const existing = stored.find(r => r.riderId === entry.riderId);
    const laps = Array.isArray(existing?.lapTimes) ? (existing!.lapTimes as Array<string | number>) : [];
    rows[entry.riderId] = {
      // Hand scoring (no results yet) starts in lineup order.
      pos: existing ? String(existing.position) : scored ? "" : String(idx + 1),
      time: existing?.totalTime ?? "",
      dnf: existing?.dnf ?? false,
      dns: existing ? !!existing.dns : scored,
      laps: laps.slice(0, lapCount != null && lapCount > 0 ? lapCount : undefined).map(formatLap),
      totalOverridden: false,
      bibNumber: existing?.bibNumber ?? entry.bibNumber ?? "",
      riderName: existing?.riderName ?? entry.riderName ?? "",
    };
  });
  return rows;
}

/**
 * The position saved for each listed rider: finishers 1..n in the order of
 * the positions entered (ties keep the listed order), then DNF, then DNS.
 */
export function finishingPositions(
  entries: ReviewEntry[],
  rows: Record<number, Pick<ReviewRow, "pos" | "dnf" | "dns"> | undefined>,
): Map<number, number> {
  const group = (riderId: number) => (rows[riderId]?.dns ? 2 : rows[riderId]?.dnf ? 1 : 0);
  const entered = (riderId: number) => parseInt(rows[riderId]?.pos ?? "", 10) || UNRANKED;
  const ordered = entries
    .map((e, index) => ({ riderId: e.riderId, index }))
    .sort((a, b) => group(a.riderId) - group(b.riderId) || entered(a.riderId) - entered(b.riderId) || a.index - b.index);
  return new Map(ordered.map((e, i) => [e.riderId, i + 1]));
}
