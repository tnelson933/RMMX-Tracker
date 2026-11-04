/**
 * Live / Past split for race-event lists (rider app Results tab and the
 * website results page). Dates are compared as local YYYY-MM-DD strings.
 */
export interface DatedEvent {
  status: string;
  date: string | null;
  endDate?: string | null;
}

const ymd = (s: string | null | undefined) => (s ? s.substring(0, 10) : "");

/** True when today falls within the event's start..end dates. */
export function isOnToday(e: DatedEvent, todayYmd: string): boolean {
  const start = ymd(e.date);
  const end = ymd(e.endDate) || start;
  return !!start && start <= todayYmd && todayYmd <= end;
}

/** A race is live when it is on race day and today is one of its days. */
export function isLive(e: DatedEvent, todayYmd: string): boolean {
  return e.status === "race_day" && isOnToday(e, todayYmd);
}

/**
 * Live: race-day events happening today. Past: completed events, plus race-day
 * events whose dates are over (organizer never closed them), newest first.
 */
export function splitLivePast<T extends DatedEvent>(events: T[], todayYmd: string): { live: T[]; past: T[] } {
  const live = events.filter(e => isLive(e, todayYmd));
  const past = events
    .filter(e => e.status === "completed" || (e.status === "race_day" && !isOnToday(e, todayYmd)))
    .sort((a, b) => (ymd(b.endDate) || ymd(b.date)).localeCompare(ymd(a.endDate) || ymd(a.date)));
  return { live, past };
}

/** Which side to open on: Live when anything is running, otherwise Past. */
export function defaultSide(liveCount: number): "live" | "past" {
  return liveCount > 0 ? "live" : "past";
}

/**
 * For the "No races live right now" state: races on today that haven't
 * started, then the next few scheduled, soonest first. Drafts and finished
 * events are skipped.
 */
export function nextScheduled<T extends DatedEvent>(events: T[], todayYmd: string, n = 3): T[] {
  return events
    .filter(e => e.status !== "completed" && e.status !== "draft" && !isLive(e, todayYmd))
    .filter(e => (ymd(e.endDate) || ymd(e.date)) >= todayYmd)
    .sort((a, b) => ymd(a.date).localeCompare(ymd(b.date)))
    .slice(0, n);
}
