/**
 * Which events public lists and search show (home, results, upcoming, series
 * pages, the rider app's browse/upcoming lists). An event page itself still
 * opens by direct link; these only keep events out of lists.
 */
import { sql, type SQL } from "drizzle-orm";
import { eventsTable } from "@workspace/db";

/** Not marked as a test event by its organizer (events.is_test). */
export const notTestEvent: SQL = sql`${eventsTable.isTest} = false`;

/**
 * Something happened at the event: at least one class entry or one result.
 * A finished event with neither (never raced, nobody entered) is an abandoned
 * placeholder, and a public results list would only show "No results posted".
 */
export const eventHasActivity: SQL = sql`(
  exists (select 1 from registrations pe_r where pe_r.event_id = ${eventsTable.id})
  or exists (select 1 from race_results pe_rr where pe_rr.event_id = ${eventsTable.id})
)`;

/** A finished event worth listing publicly: not a test, and something happened. */
export const listableFinishedEvent: SQL = sql`(${notTestEvent} and ${eventHasActivity})`;
