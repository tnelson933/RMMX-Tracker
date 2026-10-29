import { db, eventsTable, eventReaderAssignmentsTable, readersTable, trackCoursePointsTable } from "@workspace/db";
import { eq, inArray } from "drizzle-orm";
import { isValidActiveTransponderIdentifier } from "./riderTimingIdentity";

/**
 * Which kinds of timing tag an event's riders need. Events don't pick a timing
 * technology: the readers do. An RM TrackR loop at the finish and RFID readers
 * at course sections can time the same event, so a rider may need both.
 */
export interface TimingTags {
  /** RM TrackR (active) transponder. */
  transponder: boolean;
  /** Passive RFID sticker. */
  rfid: boolean;
  /**
   * False when no readers are set up yet: then a rider with either kind of
   * tag counts as having one, instead of needing both.
   */
  fromReaders: boolean;
}

/** Does a rider holding these tags have what the event's readers need? */
export function hasRequiredTags(tags: TimingTags, held: { transponder: boolean; rfid: boolean }): boolean {
  if (!tags.fromReaders) return held.transponder || held.rfid;
  return (!tags.transponder || held.transponder) && (!tags.rfid || held.rfid);
}

/**
 * Tag kinds from the readers that time the event, most specific first: the
 * event's own course map, else its track's course map, else every reader the
 * club has. With no readers set up yet, either kind may be used.
 */
export function timingTagsFromReaders(sources: Array<Array<string | null | undefined>>): TimingTags {
  const types = sources.find(list => list.length > 0);
  if (types) {
    return {
      transponder: types.includes("active_transponder"),
      rfid: types.some(t => t !== "active_transponder"),
      fromReaders: true,
    };
  }
  return { transponder: true, rfid: true, fromReaders: false };
}

export async function eventTimingTags(eventId: number): Promise<TimingTags> {
  return (await eventsTimingTags([eventId])).get(eventId) ?? { transponder: true, rfid: true, fromReaders: false };
}

/** eventTimingTags for several events with a fixed number of queries. */
export async function eventsTimingTags(eventIds: number[]): Promise<Map<number, TimingTags>> {
  const out = new Map<number, TimingTags>();
  const ids = [...new Set(eventIds)];
  if (ids.length === 0) return out;
  const events = await db.select({
    id: eventsTable.id, clubId: eventsTable.clubId, trackId: eventsTable.trackId,
  }).from(eventsTable).where(inArray(eventsTable.id, ids));

  const assigned = await db.select({ eventId: eventReaderAssignmentsTable.eventId, type: readersTable.type })
    .from(eventReaderAssignmentsTable)
    .innerJoin(readersTable, eq(eventReaderAssignmentsTable.readerId, readersTable.id))
    .where(inArray(eventReaderAssignmentsTable.eventId, ids));
  const trackIds = [...new Set(events.map(e => e.trackId).filter((id): id is number => id != null))];
  const course = trackIds.length === 0 ? [] : await db.select({ trackId: trackCoursePointsTable.trackId, type: readersTable.type })
    .from(trackCoursePointsTable)
    .innerJoin(readersTable, eq(trackCoursePointsTable.readerId, readersTable.id))
    .where(inArray(trackCoursePointsTable.trackId, trackIds));
  const clubIds = [...new Set(events.map(e => e.clubId).filter((id): id is number => id != null))];
  const club = clubIds.length === 0 ? [] : await db.select({ clubId: readersTable.clubId, type: readersTable.type })
    .from(readersTable).where(inArray(readersTable.clubId, clubIds));

  for (const e of events) {
    out.set(e.id, timingTagsFromReaders([
      assigned.filter(a => a.eventId === e.id).map(a => a.type),
      course.filter(c => c.trackId === e.trackId).map(c => c.type),
      club.filter(c => c.clubId === e.clubId).map(c => c.type),
    ]));
  }
  return out;
}

/**
 * A registration's transponder field, split by what it really holds. Before an
 * event could use both kinds of reader, assigning an RFID sticker also copied
 * its number there, so a value that isn't a valid RM TrackR ID (1–9 hex
 * characters) is an RFID sticker, not a bad transponder number.
 */
export function splitRegistrationTag(value: string | null | undefined): { transponder: string | null; sticker: string | null } {
  const v = value?.trim() || null;
  if (!v) return { transponder: null, sticker: null };
  return isValidActiveTransponderIdentifier(v) ? { transponder: v, sticker: null } : { transponder: null, sticker: v };
}

/** "RM TrackR", "RFID" or "RM TrackR + RFID", for labels. */
export function timingTagsLabel(tags: TimingTags): string {
  if (tags.transponder && tags.rfid) return "RM TrackR + RFID";
  return tags.transponder ? "RM TrackR" : "RFID";
}
