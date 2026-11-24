/**
 * Result moments (components/ResultMoment.tsx): a one-time celebration on
 * Home after a win, a podium or a rider's best finish yet. Pure, so it runs
 * under node:test.
 */

/** A race-history entry (components/RaceSubScreens EventHistory), only the fields used here. */
export interface MomentResult {
  eventId: number;
  eventName: string;
  eventDate: string;
  raceClass: string;
  bestPosition: number | null;
  riderName?: string;
}

export type MomentKind = "win" | "podium" | "best";

export interface Moment<T extends MomentResult = MomentResult> {
  key: string;
  kind: MomentKind;
  result: T;
}

/** Shown for results this recent (days since the race). */
export const MOMENT_WINDOW_DAYS = 7;

export function momentKey(r: MomentResult): string {
  return `${r.eventId}:${r.raceClass}:${r.riderName ?? ""}`;
}

function dayNumber(ymd: string): number {
  const [y, m, d] = ymd.slice(0, 10).split("-").map(Number);
  return Date.UTC(y, (m || 1) - 1, d || 1) / 86_400_000;
}

/**
 * The newest result worth celebrating that hasn't been shown: a win, a podium,
 * or a finish better than every earlier one for that rider (with at least one
 * earlier race to beat). Only races from the last week.
 */
export function pickMoment<T extends MomentResult>(history: T[], seen: ReadonlySet<string>, todayYmd: string): Moment<T> | null {
  const today = dayNumber(todayYmd);
  const newestFirst = [...history].sort((a, b) => b.eventDate.localeCompare(a.eventDate));
  for (const r of newestFirst) {
    const age = today - dayNumber(r.eventDate);
    if (age > MOMENT_WINDOW_DAYS) break;
    if (age < 0 || r.bestPosition == null || seen.has(momentKey(r))) continue;
    if (r.bestPosition === 1) return { key: momentKey(r), kind: "win", result: r };
    if (r.bestPosition <= 3) return { key: momentKey(r), kind: "podium", result: r };
    const earlier = history.filter(h =>
      (h.riderName ?? "") === (r.riderName ?? "") && h.eventDate < r.eventDate && h.bestPosition != null);
    if (earlier.length > 0 && earlier.every(h => r.bestPosition! < h.bestPosition!)) {
      return { key: momentKey(r), kind: "best", result: r };
    }
  }
  return null;
}

export function momentHeadline(kind: MomentKind, position: number): string {
  if (kind === "win") return "Winner!";
  if (kind === "podium") return position === 2 ? "Second place!" : "Third place!";
  return "Best finish yet!";
}

/** "You won 250 B at Spring Opener." / "Sam finished P2 in 250 B at Spring Opener." */
export function momentLine(m: Moment, firstName: string | null): string {
  const who = firstName ?? "You";
  const you = who === "You";
  const r = m.result;
  if (m.kind === "win") return `${who} won ${r.raceClass} at ${r.eventName}.`;
  return `${who} finished P${r.bestPosition} in ${r.raceClass} at ${r.eventName}${m.kind === "best" ? `, ${you ? "your" : "their"} best yet` : ""}.`;
}
