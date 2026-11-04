/**
 * Career stats screen: finish spread, starts vs finishes, laps led, each with
 * a plain-language takeaway. Pure functions, tested in lib/career.test.ts.
 */

export interface CareerNumbers {
  starts: number;
  finishes: number;
  dnfs?: number;
  wins: number;
  podiums: number;
  top5s: number;
  totalLaps: number;
  lapsLed: number;
  pctLapsLed: number | null;
  avgLap1Position: number | null;
  avgFinish: number | null;
  avgPositionsGained: number | null;
}

export interface SpreadSegment { key: string; label: string; count: number }

/** Finished motos split into wins, other podiums, other top 5s and the rest, plus DNFs. */
export function finishSpread(s: CareerNumbers): SpreadSegment[] {
  const dnfs = s.dnfs ?? Math.max(0, s.starts - s.finishes);
  return [
    { key: "wins", label: "Wins", count: s.wins },
    { key: "podiums", label: "2nd–3rd", count: Math.max(0, s.podiums - s.wins) },
    { key: "top5", label: "4th–5th", count: Math.max(0, s.top5s - s.podiums) },
    { key: "rest", label: "6th+", count: Math.max(0, s.finishes - s.top5s) },
    { key: "dnf", label: "DNF", count: dnfs },
  ];
}

const pct = (n: number, d: number) => Math.round((n / d) * 100);

export function spreadTakeaway(s: CareerNumbers): string | null {
  if (s.finishes === 0) return s.starts > 0 ? `${s.starts} starts, no finishes yet.` : null;
  if (s.wins > 0) return `Won ${pct(s.wins, s.finishes)}% and podiumed ${pct(s.podiums, s.finishes)}% of finished motos.`;
  if (s.podiums > 0) return `On the podium in ${pct(s.podiums, s.finishes)}% of finished motos.`;
  if (s.top5s > 0) return `Top 5 in ${pct(s.top5s, s.finishes)}% of finished motos.`;
  return `${s.finishes} motos finished. Average finish P${Math.round(s.avgFinish ?? 0)}.`;
}

/** Where the rider is after lap 1 compared with where they finish. */
export function startTakeaway(s: CareerNumbers): string | null {
  if (s.avgLap1Position == null || s.avgPositionsGained == null) return null;
  const g = s.avgPositionsGained;
  if (g >= 0.3) return `You gain ${g.toFixed(1)} places per moto after lap 1.`;
  if (g <= -0.3) return `You lose ${Math.abs(g).toFixed(1)} places per moto after lap 1. Your starts are strong.`;
  return "You finish about where you are after lap 1.";
}

export function lapsLedTakeaway(s: CareerNumbers): string | null {
  if (s.totalLaps === 0) return null;
  if (s.lapsLed > 0) return `Led ${s.lapsLed} of ${s.totalLaps} laps (${s.pctLapsLed ?? pct(s.lapsLed, s.totalLaps)}%).`;
  return s.avgLap1Position != null
    ? `No laps led yet. Average position after lap 1: P${Math.round(s.avgLap1Position)}.`
    : "No laps led yet.";
}
