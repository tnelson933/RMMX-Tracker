/**
 * My Season maths and takeaways. Pure functions over the rider history API's
 * events, unit tested in lib/season.test.ts.
 *
 * Raw lap times can't be compared between tracks, so the season trends are
 * track-independent: finishing position, points, % off the moto winner's
 * average lap, and lap spread (how even the laps were).
 */
import { fmtSecs, parseLap } from "./raceReport";

export interface SeasonMoto {
  position: number | null;
  dnf: boolean;
  dns: boolean;
  lapTimes: string[];
  points: number | null;
  motoType?: string;
  /** The moto winner's average lap in ms (from the history API). */
  winnerAvgLapMs?: number | null;
}

export interface SeasonEvent {
  eventId: number;
  eventName: string;
  eventDate: string;
  raceClass: string;
  raceStyle?: string | null;
  motos: SeasonMoto[];
  totalPoints: number;
}

export interface SeasonRound {
  eventId: number;
  eventName: string;
  eventDate: string;
  /** Average finishing position across the motos the rider finished. */
  avgFinish: number | null;
  points: number;
  /** % slower than the winner's average lap, averaged over motos. */
  pacePct: number | null;
  /** Slowest minus fastest lap (ms), averaged over motos, ignoring crash laps. */
  spreadMs: number | null;
}

const yearOf = (iso: string) => (iso ?? "").slice(0, 4);
const isRace = (m: SeasonMoto) => m.motoType !== "practice";

/** Seasons with results, newest first. */
export function seasonYears(events: SeasonEvent[]): string[] {
  return [...new Set(events.map(e => yearOf(e.eventDate)).filter(y => /^\d{4}$/.test(y)))].sort().reverse();
}

/** Classes raced in a season, most-raced first. */
export function seasonClasses(events: SeasonEvent[], year: string): string[] {
  const counts = new Map<string, number>();
  for (const e of events) if (yearOf(e.eventDate) === year) counts.set(e.raceClass, (counts.get(e.raceClass) ?? 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([c]) => c);
}

/** The rider's laps that count for pace (motocross lap 1 includes the start). */
function countedLaps(m: SeasonMoto, raceStyle?: string | null): number[] | null {
  const laps = m.lapTimes.map(parseLap);
  if (laps.length === 0 || laps.some(l => l == null)) return null;
  const all = laps as number[];
  return raceStyle === "motocross" && all.length > 1 ? all.slice(1) : all;
}

function median(v: number[]): number {
  const s = [...v].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/** Slowest minus fastest lap, after dropping laps over 30% slower than the median (a crash or a stop). */
export function lapSpreadMs(laps: number[]): number | null {
  if (laps.length < 3) return null;
  const med = median(laps);
  const clean = laps.filter(l => l <= med * 1.3);
  if (clean.length < 3) return null;
  return Math.max(...clean) - Math.min(...clean);
}

const mean = (v: number[]) => (v.length ? v.reduce((a, b) => a + b, 0) / v.length : null);

export function seasonRounds(events: SeasonEvent[], year: string, raceClass: string): SeasonRound[] {
  return events
    .filter(e => yearOf(e.eventDate) === year && e.raceClass === raceClass)
    .sort((a, b) => a.eventDate.localeCompare(b.eventDate))
    .map(eventRound);
}

/** The most recent races in any class, oldest first (Home's recent form). */
export function recentRounds(events: SeasonEvent[], count: number): SeasonRound[] {
  return [...events]
    .sort((a, b) => a.eventDate.localeCompare(b.eventDate))
    .slice(-count)
    .map(eventRound);
}

/** One race's finish, points, pace and lap spread. */
export function eventRound(e: SeasonEvent): SeasonRound {
      const races = e.motos.filter(isRace);
      const finishes = races.filter(m => !m.dnf && !m.dns && m.position != null).map(m => m.position!);
      const pace: number[] = [];
      const spread: number[] = [];
      for (const m of races) {
        if (m.dnf || m.dns) continue;
        const laps = countedLaps(m, e.raceStyle);
        if (!laps || laps.length === 0) continue;
        const avg = laps.reduce((a, b) => a + b, 0) / laps.length;
        if (m.winnerAvgLapMs) pace.push((avg / m.winnerAvgLapMs - 1) * 100);
        const sp = lapSpreadMs(laps);
        if (sp != null) spread.push(sp);
      }
      const avgFinish = mean(finishes);
      const pacePct = mean(pace);
      const spreadMs = mean(spread);
      return {
        eventId: e.eventId,
        eventName: e.eventName,
        eventDate: e.eventDate,
        avgFinish: avgFinish == null ? null : Math.round(avgFinish * 10) / 10,
        points: e.totalPoints ?? 0,
        pacePct: pacePct == null ? null : Math.round(pacePct * 10) / 10,
        spreadMs: spreadMs == null ? null : Math.round(spreadMs),
      };
}

const P = (v: number) => `P${Math.round(v)}`;

export function finishTakeaway(rounds: SeasonRound[]): string | null {
  const r = rounds.filter(x => x.avgFinish != null);
  if (r.length === 0) return null;
  if (r.length === 1) return `Averaged ${P(r[0].avgFinish!)} at ${r[0].eventName}.`;
  let streak = 0;
  for (let i = r.length - 1; i >= 0 && Math.round(r[i].avgFinish!) <= 5; i--) streak++;
  if (streak >= 3) return `Top 5 in your last ${streak} races.`;
  const first = Math.round(r[0].avgFinish!), last = Math.round(r[r.length - 1].avgFinish!);
  if (first - last >= 1) return `Average finish improved from P${first} to P${last}.`;
  if (last - first >= 1) return `Average finish slipped from P${first} to P${last}.`;
  return `Steady: about P${last} every race.`;
}

export function pointsTakeaway(rounds: SeasonRound[], series?: { seriesName: string; position: number; totalPoints: number } | null): string | null {
  if (rounds.length === 0) return null;
  const total = rounds.reduce((a, r) => a + r.points, 0);
  if (series) return `${ordinal(series.position)} in ${series.seriesName} with ${series.totalPoints} series points.`;
  if (total === 0) return null;
  const best = rounds.reduce((a, b) => (b.points > a.points ? b : a));
  return rounds.length === 1
    ? `${total} points at ${best.eventName}.`
    : `${total} points in ${rounds.length} races. Best: ${best.points} at ${best.eventName}.`;
}

/** `scope` names the span for "your best …": "this season", or "in your last 5 races" on Home. */
export function paceTakeaway(rounds: SeasonRound[], scope = "this season"): string | null {
  const r = rounds.filter(x => x.pacePct != null);
  if (r.length === 0) return null;
  const last = r[r.length - 1];
  const fmt = (v: number) => `${Math.max(0, v).toFixed(1)}%`;
  if (last.pacePct! <= 0) return "Matched the winner's pace in your last race.";
  if (r.length === 1) return `${fmt(last.pacePct!)} off the winner's pace.`;
  const best = r.reduce((a, b) => (b.pacePct! < a.pacePct! ? b : a));
  if (best === last) return `${fmt(last.pacePct!)} off the winner's pace, your best ${scope}.`;
  return `${fmt(last.pacePct!)} off the winner's pace. Best: ${fmt(best.pacePct!)} at ${best.eventName}.`;
}

export function spreadTakeaway(rounds: SeasonRound[]): string | null {
  const r = rounds.filter(x => x.spreadMs != null);
  if (r.length === 0) return null;
  const last = r[r.length - 1].spreadMs!;
  if (r.length === 1) return `Your laps were within ${fmtSecs(last)} of each other.`;
  const first = r[0].spreadMs!;
  if (first - last >= 300) return `Lap spread down from ${fmtSecs(first)} to ${fmtSecs(last)}. More consistent.`;
  if (last - first >= 300) return `Lap spread up from ${fmtSecs(first)} to ${fmtSecs(last)}.`;
  return `Laps stay within about ${fmtSecs(last)} of each other.`;
}

export function ordinal(n: number): string {
  const s = ["th", "st", "nd", "rd"];
  const v = n % 100;
  return `${n}${s[(v - 20) % 10] || s[v] || s[0]}`;
}
