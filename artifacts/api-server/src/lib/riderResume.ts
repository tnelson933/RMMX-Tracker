/**
 * Racer profile ("résumé"): highlights, badges, season trend and a one-line
 * headline built from a rider's results, plus who may see the personal parts
 * of the profile. Pure functions, tested in riderResume.test.ts.
 *
 * Every line is derived from timing data with fixed rules, so it can't be
 * faked and is always true for the results it was given.
 */
import { cumulativeMs, lapPositions, type CareerStats, type LapValue } from "./careerStats";

const FINISH_SENTINEL = 999;

export interface ResumeMoto {
  motoId: number;
  motoType: string | null;
  position: number;
  dnf: boolean;
  dns: boolean;
  lapTimes: LapValue[];
  eventId: number;
  eventName: string;
  /** "YYYY-MM-DD" (or longer ISO). */
  eventDate: string;
  raceClass: string;
  /** Track or venue name, when the event has one. */
  track: string | null;
}

export interface RacerResume {
  headline: string | null;
  highlights: {
    bestFinish: { position: number; eventId: number; eventName: string; eventDate: string } | null;
    bestComeback: { gained: number; eventId: number; eventName: string } | null;
  };
  /** Average finish per season, oldest first. */
  seasons: Array<{ year: string; avgFinish: number | null; motos: number }>;
  badges: Array<{ key: string; label: string }>;
  /** Most-raced first. */
  classes: string[];
  tracks: string[];
  firstYear: string | null;
}

const finished = (m: ResumeMoto) => !m.dns && !m.dnf && m.position > 0 && m.position < FINISH_SENTINEL;
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const byCount = (values: string[]) => {
  const counts = new Map<string, number>();
  for (const v of values) if (v) counts.set(v, (counts.get(v) ?? 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([v]) => v);
};

export function computeResume(motos: ResumeMoto[], fieldByMoto: Map<number, number[][]>, stats: CareerStats): RacerResume {
  const raced = motos
    .filter(m => m.motoType !== "practice" && !m.dns)
    .sort((a, b) => a.eventDate.localeCompare(b.eventDate) || a.motoId - b.motoId);
  const done = raced.filter(finished);

  // Best finish: lowest position, the most recent when tied.
  let bestFinish: RacerResume["highlights"]["bestFinish"] = null;
  for (const m of done) {
    if (!bestFinish || m.position <= bestFinish.position) {
      bestFinish = { position: m.position, eventId: m.eventId, eventName: m.eventName, eventDate: m.eventDate.slice(0, 10) };
    }
  }

  // Biggest comeback: places gained from the end of lap 1 to the finish, in one moto.
  let bestComeback: RacerResume["highlights"]["bestComeback"] = null;
  for (const m of done) {
    const cum = cumulativeMs(m.lapTimes);
    if (!cum || cum.length < 2) continue;
    const lap1 = lapPositions(cum, fieldByMoto.get(m.motoId) ?? [cum])[0];
    const gained = lap1 - m.position;
    if (gained > 0 && (!bestComeback || gained >= bestComeback.gained)) bestComeback = { gained, eventId: m.eventId, eventName: m.eventName };
  }

  const years = [...new Set(raced.map(m => m.eventDate.slice(0, 4)))].filter(y => /^\d{4}$/.test(y)).sort();
  const seasons = years.map(year => {
    const f = done.filter(m => m.eventDate.startsWith(year));
    return {
      year,
      avgFinish: f.length ? Math.round((f.reduce((s, m) => s + m.position, 0) / f.length) * 10) / 10 : null,
      motos: raced.filter(m => m.eventDate.startsWith(year)).length,
    };
  });

  // Badges, strongest first; at most five.
  const badges: RacerResume["badges"] = [];
  if (stats.wins > 0) badges.push({ key: "wins", label: plural(stats.wins, "moto win") });
  if (stats.lap1Leads > 0) badges.push({ key: "lap1", label: `Led lap 1 ×${stats.lap1Leads}` });
  if (stats.lapsLed > 0) badges.push({ key: "lapsLed", label: `Led ${plural(stats.lapsLed, "lap")}` });
  let streak = 0;
  for (let i = raced.length - 1; i >= 0 && finished(raced[i]); i--) streak++;
  if (streak >= 5) badges.push({ key: "streak", label: `${streak} motos finished in a row` });
  const podiumTracks = byCount(done.filter(m => m.position <= 3 && m.track).map(m => m.track!));
  if (podiumTracks.length) {
    const n = done.filter(m => m.position <= 3 && m.track === podiumTracks[0]).length;
    if (n >= 2) badges.push({ key: "trackPodiums", label: `${n} podiums at ${podiumTracks[0]}` });
  }

  return {
    headline: headline(stats, seasons, years[0] ?? null),
    highlights: { bestFinish, bestComeback },
    seasons,
    badges: badges.slice(0, 5),
    classes: byCount(raced.map(m => m.raceClass)),
    tracks: byCount(raced.map(m => m.track ?? "")),
    firstYear: years[0] ?? null,
  };
}

function headline(stats: CareerStats, seasons: RacerResume["seasons"], firstYear: string | null): string | null {
  if (stats.starts === 0) return null;
  const motos = plural(stats.starts, "moto");
  if (stats.wins > 0) return `${plural(stats.wins, "moto win")} and ${plural(stats.podiums, "podium")} in ${motos}.`;
  if (stats.podiums > 0) return `${plural(stats.podiums, "podium")} in ${motos}.`;
  const rated = seasons.filter(s => s.avgFinish != null);
  if (rated.length >= 2) {
    const first = Math.round(rated[0].avgFinish!), last = Math.round(rated[rated.length - 1].avgFinish!);
    if (first - last >= 1) return `Average finish up from P${first} to P${last} since ${rated[0].year}.`;
  }
  if (stats.top5s > 0) return `${plural(stats.top5s, "top-5 finish", "top-5 finishes")} in ${motos}.`;
  return firstYear ? `Racing since ${firstYear}: ${motos} so far.` : `${motos} so far.`;
}

/** Age in whole years from "YYYY-MM-DD"; null when unknown or unreadable. */
export function ageOn(dateOfBirth: string | null | undefined, todayYmd: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(dateOfBirth ?? "");
  if (!m) return null;
  const [y, mo, d] = [+m[1], +m[2], +m[3]];
  const [ty, tmo, td] = [+todayYmd.slice(0, 4), +todayYmd.slice(5, 7), +todayYmd.slice(8, 10)];
  return ty - y - (tmo < mo || (tmo === mo && td < d) ? 1 : 0);
}

export type ProfileVisibility = "public" | "private";

/**
 * Who can see the personal parts of a racer profile (bio, home state).
 * Owner decision 2026-11-04: riders under 18 start private; a parent or
 * profile manager can make the profile public. A missing birth date is
 * treated as an adult (there's nothing to go on); anyone managing the
 * profile can still set it to private.
 */
export function effectiveVisibility(
  rider: { dateOfBirth: string | null; profileVisibility: string | null },
  todayYmd: string,
): ProfileVisibility {
  if (rider.profileVisibility === "public" || rider.profileVisibility === "private") return rider.profileVisibility;
  const age = ageOn(rider.dateOfBirth, todayYmd);
  return age != null && age < 18 ? "private" : "public";
}

export const PLATE_COLORS = ["white", "black", "red", "yellow", "blue", "green", "orange"] as const;
export const BIO_MAX = 160;
