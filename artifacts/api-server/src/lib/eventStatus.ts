import { db, eventsTable } from "@workspace/db";
import { eq, inArray } from "drizzle-orm";
import { eventToday } from "@workspace/api-zod";
import { logger } from "./logger";

// Event statuses move forward on their own:
//   draft → registration_open (registration window opens)
//   registration_open → registration_closed (registration window closes)
//   any pre-race status → race_day (event start date arrives)
//   race_day → completed (day after the last event day)
// Dates are compared in each event's local time (its track's time zone).

export type EventStatusRow = {
  id: number;
  date: string;
  endDate?: string | null;
  status: string;
  registrationOpen: string | null;
  registrationClose: string | null;
  state?: string | null;
  trackLat?: number | null;
  trackLng?: number | null;
};

const PRE_RACE = new Set(["draft", "registration_open", "registration_closed"]);
const SWEEP_INTERVAL_MS = 10 * 60_000;


const day = (value: string | null | undefined) => (value ? String(value).substring(0, 10) : null);

type EventPlace = { state?: string | null; trackLat?: number | null; trackLng?: number | null };

/** True once the event's start date has arrived at the track: rider registration is over. */
export function eventDateReached(event: { date: string } & EventPlace, now = new Date()): boolean {
  const start = day(event.date);
  return !!start && start <= eventToday(event, now);
}

/** The single next status for an event, or null when it should stay as is. */
export function computeAutoStatus(event: EventStatusRow, now = new Date()): string | null {
  const today = eventToday(event, now);
  const start = day(event.date);
  const lastDay = day(event.endDate) ?? start;
  const { status, registrationOpen, registrationClose } = event;

  if (status === "race_day") return lastDay && lastDay < today ? "completed" : null;
  if (!PRE_RACE.has(status)) return null;

  // On or after the start date registration is over: the event is racing.
  if (start && start <= today) return "race_day";

  if (status === "draft" && registrationOpen && now >= new Date(registrationOpen)) return "registration_open";
  if (status === "registration_open" && registrationClose && now >= new Date(registrationClose)) return "registration_closed";
  return null;
}

/** Final status after applying every step that's due (e.g. open → race_day → completed). */
export function settleStatus(event: EventStatusRow, now = new Date()): string | null {
  let current = event.status;
  for (let step = 0; step < 4; step++) {
    const next = computeAutoStatus({ ...event, status: current }, now);
    if (!next) break;
    current = next;
  }
  return current !== event.status ? current : null;
}

/** Saves any due status changes; returns the new status per event id. */
export async function advanceEventStatuses(events: EventStatusRow[]): Promise<Map<number, string>> {
  const updates = new Map<number, string>();
  for (const e of events) {
    const next = settleStatus(e);
    if (next) updates.set(e.id, next);
  }
  await Promise.all(
    [...updates.entries()].map(([id, status]) => db.update(eventsTable).set({ status }).where(eq(eventsTable.id, id))),
  );
  return updates;
}

/** Advances every unfinished event, so statuses stay right even when nobody opens a page. */
export async function sweepEventStatuses(): Promise<number> {
  const events = await db.select({
    id: eventsTable.id,
    date: eventsTable.date,
    endDate: eventsTable.endDate,
    status: eventsTable.status,
    registrationOpen: eventsTable.registrationOpen,
    registrationClose: eventsTable.registrationClose,
    state: eventsTable.state,
    trackLat: eventsTable.trackLat,
    trackLng: eventsTable.trackLng,
  }).from(eventsTable).where(inArray(eventsTable.status, [...PRE_RACE, "race_day"]));
  const updates = await advanceEventStatuses(events);
  if (updates.size > 0) {
    logger.info({ changes: Object.fromEntries(updates) }, "Event statuses advanced");
  }
  return updates.size;
}

export function startEventStatusSweeper(): void {
  const tick = async () => {
    try {
      await sweepEventStatuses();
    } catch (err) {
      logger.error({ err }, "Event status sweep failed");
    } finally {
      setTimeout(tick, SWEEP_INTERVAL_MS);
    }
  };
  void tick();
}
