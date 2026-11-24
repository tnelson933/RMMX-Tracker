/**
 * What an event's public page (/results/:eventId) is showing right now: the
 * one link per race changes with the race. The website page and the server's
 * link preview (api-server lib/shareMeta.ts) both decide it here, so a shared
 * link's preview always matches the page it opens.
 *
 * Event status and result publication are separate: status says where the
 * event is in its life (registration, race day, completed), publication says
 * whether the finished races' results are official (every finished race
 * finalized by the organizer). Pure: no clock reads unless defaulted.
 */

export type EventPageState =
  /** Announced; registration isn't open (yet). */
  | "upcoming"
  | "registration_open"
  /** Registration has closed; race day is still ahead. */
  | "registration_closed"
  /** Race day (or a multi-day event's day), with no race running at this moment. */
  | "race_day"
  /** A race is running now. */
  | "live"
  /** Over, and some finished results are still unofficial (or none are posted yet). */
  | "finished_unofficial"
  /** Over, and every finished race's results are official. */
  | "official";

export interface EventPageInput {
  /** The event's settled status (api-server eventStatus.settleStatus applied). */
  status: string;
  /** First day, YYYY-MM-DD (a longer ISO string is cut to the day). */
  date: string | null | undefined;
  endDate?: string | null;
  registrationClose?: string | Date | null;
  /** The event's motos; any one in progress makes the page live. */
  motos?: ReadonlyArray<{ status: string }> | null;
  /**
   * Finished (non-practice) results: how many rows, and whether every one is
   * official. Leave out when unknown; it only decides official vs unofficial.
   */
  results?: { count: number; official: boolean } | null;
}

const day = (v: string | null | undefined) => (v ? String(v).slice(0, 10) : null);

/**
 * The page's state, or null for a draft (no public page). `localToday` is the
 * track's local date (eventToday from ./eventTimeZone).
 */
export function eventPageState(e: EventPageInput, localToday: string, now: Date = new Date()): EventPageState | null {
  if (e.status === "draft") return null;
  if ((e.motos ?? []).some(m => m.status === "in_progress")) return "live";

  const start = day(e.date);
  const last = day(e.endDate) ?? start;
  const over = e.status === "completed" || e.status === "results_published" || (!!last && last < localToday);
  if (over) {
    const r = e.results;
    return r && r.count > 0 && r.official ? "official" : "finished_unofficial";
  }
  if (e.status === "race_day" || (start && last && start <= localToday && localToday <= last)) return "race_day";
  if (e.status === "registration_open") {
    return e.registrationClose && now >= new Date(e.registrationClose) ? "registration_closed" : "registration_open";
  }
  if (e.status === "registration_closed") return "registration_closed";
  return "upcoming";
}

/** Race day or a race running: the page leads with the live section. */
export const isLivePageState = (s: EventPageState | null | undefined): s is "race_day" | "live" =>
  s === "race_day" || s === "live";

/** The event is over: the page is its results. */
export const isFinishedPageState = (s: EventPageState | null | undefined): s is "finished_unofficial" | "official" =>
  s === "finished_unofficial" || s === "official";
