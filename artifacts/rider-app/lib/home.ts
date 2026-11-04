/**
 * Home screen helpers: which race is next and how far away it is. Pure
 * functions, unit tested in lib/home.test.ts. Dates are "YYYY-MM-DD" (or ISO
 * strings, of which only the date part is used), compared as calendar days.
 */

export interface ScheduledRace {
  eventId: number;
  eventDate: string | null;
  eventEndDate?: string | null;
  status: string;
}

const day = (iso: string | null | undefined) => (iso ?? "").slice(0, 10);

function daysBetween(fromYmd: string, toYmd: string): number {
  const a = Date.UTC(+fromYmd.slice(0, 4), +fromYmd.slice(5, 7) - 1, +fromYmd.slice(8, 10));
  const b = Date.UTC(+toYmd.slice(0, 4), +toYmd.slice(5, 7) - 1, +toYmd.slice(8, 10));
  return Math.round((b - a) / 86_400_000);
}

/** The rider's next race: one running today first, then the soonest that hasn't ended. */
export function pickNextRace<T extends ScheduledRace>(races: T[], todayYmd: string): T | null {
  const open = races.filter(r => r.eventDate && (day(r.eventEndDate) || day(r.eventDate)) >= todayYmd);
  if (open.length === 0) return null;
  const live = open.find(r => r.status === "race_day" && day(r.eventDate) <= todayYmd);
  if (live) return live;
  return [...open].sort((a, b) => day(a.eventDate).localeCompare(day(b.eventDate)))[0];
}

/** "Racing today", "Tomorrow", "In 3 days", "In 2 weeks", or the date. */
export function countdownLabel(race: ScheduledRace, todayYmd: string): string {
  const start = day(race.eventDate);
  const end = day(race.eventEndDate) || start;
  if (!start) return "Date to be announced";
  if (start <= todayYmd && todayYmd <= end) return "Racing today";
  const d = daysBetween(todayYmd, start);
  if (d === 1) return "Tomorrow";
  if (d < 14) return `In ${d} days`;
  if (d < 56) return `In ${Math.round(d / 7)} weeks`;
  const dt = new Date(Date.UTC(+start.slice(0, 4), +start.slice(5, 7) - 1, +start.slice(8, 10)));
  return dt.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
}
