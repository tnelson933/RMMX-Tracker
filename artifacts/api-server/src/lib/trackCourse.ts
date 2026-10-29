/**
 * Course maps that belong to a track.
 *
 * A track in the Track Library keeps its standard course: one finish-line
 * reader and ordered split readers. An event at the track holds a copy in
 * event_reader_assignments (so every timing path keeps reading the event's
 * rows) and stays in step with the track while `events.course_source` is
 * "track". Changing the course on the event makes it "custom"; resetting
 * copies the track's course back. Events that have raced keep the course they
 * raced with. Practices snapshot the course when they start.
 */
import { db } from "@workspace/db";
import {
  eventReaderAssignmentsTable, eventsTable, motosTable, readersTable,
  trackCoursePointsTable, tracksTable, type PracticeCourse,
} from "@workspace/db/schema";
import { and, eq, inArray, isNull, ne, or, sql } from "drizzle-orm";

export interface CourseInput {
  readerId: number;
  role: "finish" | "split";
  sequence?: number | null;
  label?: string | null;
}

/**
 * Check and normalise a course: readers must be the club's, one finish line,
 * each reader in one place, splits numbered 1..N in the order given.
 */
export async function normaliseCourse(
  points: unknown,
  clubId: number,
): Promise<{ ok: true; points: Array<{ readerId: number; role: "finish" | "split"; sequence: number | null; label: string | null }> } | { ok: false; error: string }> {
  if (!Array.isArray(points)) return { ok: false, error: "points must be a list" };
  const rows = points.map((p: any) => ({
    readerId: Number(p?.readerId),
    role: p?.role === "finish" ? "finish" as const : "split" as const,
    sequence: Number.isInteger(p?.sequence) ? Number(p.sequence) : null,
    label: typeof p?.label === "string" && p.label.trim() ? p.label.trim().slice(0, 60) : null,
  }));
  if (rows.some(r => !Number.isInteger(r.readerId) || r.readerId <= 0)) return { ok: false, error: "Each course point needs a reader" };
  if (rows.filter(r => r.role === "finish").length > 1) return { ok: false, error: "A course has one finish-line reader" };
  if (new Set(rows.map(r => r.readerId)).size !== rows.length) return { ok: false, error: "Each reader can only be in one place on the course" };
  if (rows.length > 0) {
    const owned = await db.select({ id: readersTable.id }).from(readersTable)
      .where(and(eq(readersTable.clubId, clubId), inArray(readersTable.id, rows.map(r => r.readerId))));
    if (owned.length !== rows.length) return { ok: false, error: "One or more readers do not belong to this club" };
  }
  rows
    .filter(r => r.role === "split")
    .sort((a, b) => (a.sequence ?? Number.MAX_SAFE_INTEGER) - (b.sequence ?? Number.MAX_SAFE_INTEGER))
    .forEach((r, i) => { r.sequence = i + 1; });
  rows.filter(r => r.role === "finish").forEach(r => { r.sequence = null; });
  return { ok: true, points: rows };
}

/** The track's course, splits in order. */
export async function getTrackCourse(trackId: number) {
  const rows = await db.select().from(trackCoursePointsTable).where(eq(trackCoursePointsTable.trackId, trackId));
  return rows.sort((a, b) =>
    (a.role === "finish" ? -1 : 0) - (b.role === "finish" ? -1 : 0) || (a.sequence ?? 0) - (b.sequence ?? 0) || a.id - b.id);
}

/** Frozen copy for a practice session (labels default to "Split N"). */
export async function practiceCourseFor(trackId: number | null): Promise<PracticeCourse | null> {
  if (!trackId) return null;
  const points = await getTrackCourse(trackId);
  if (points.length === 0) return null;
  const finish = points.find(p => p.role === "finish");
  const splits = points.filter(p => p.role === "split")
    .map((p, i) => ({ readerId: p.readerId, sequence: i + 1, label: p.label?.trim() || `Split ${i + 1}` }));
  return { finishReaderId: finish?.readerId ?? null, splits };
}

/** True once the event has run a race (its course is then part of its results). */
async function eventHasRaced(eventId: number): Promise<boolean> {
  const [row] = await db.select({ id: motosTable.id }).from(motosTable).where(and(
    eq(motosTable.eventId, eventId),
    ne(motosTable.type, "practice"),
    or(eq(motosTable.status, "in_progress"), eq(motosTable.status, "completed")),
  )).limit(1);
  return !!row;
}

/**
 * Replace the event's course (finish + splits, not enduro gates or time
 * checks) with its track's. Does nothing for a custom course, an event with
 * no track, or (unless `force`) an event that has raced.
 */
export async function copyTrackCourseToEvent(eventId: number, opts: { force?: boolean } = {}): Promise<boolean> {
  const [event] = await db.select({ trackId: eventsTable.trackId, courseSource: eventsTable.courseSource })
    .from(eventsTable).where(eq(eventsTable.id, eventId));
  if (!event?.trackId || event.courseSource !== "track") return false;
  if (!opts.force && await eventHasRaced(eventId)) return false;
  const points = await getTrackCourse(event.trackId);
  await db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(${EVENT_COURSE_LOCK}, ${eventId})`);
    await tx.delete(eventReaderAssignmentsTable).where(and(
      eq(eventReaderAssignmentsTable.eventId, eventId),
      isNull(eventReaderAssignmentsTable.motoId),
      inArray(eventReaderAssignmentsTable.role, ["finish", "split"]),
    ));
    if (points.length > 0) {
      await tx.insert(eventReaderAssignmentsTable).values(points.map(p => ({
        eventId,
        readerId: p.readerId,
        role: p.role,
        sequence: p.role === "split" ? p.sequence : null,
        label: p.label,
      })));
    }
  });
  return true;
}

/** After a track's course changes: refresh every linked event still following it. */
export async function propagateTrackCourse(trackId: number): Promise<number> {
  const events = await db.select({ id: eventsTable.id }).from(eventsTable).where(and(
    eq(eventsTable.trackId, trackId),
    eq(eventsTable.courseSource, "track"),
    ne(eventsTable.status, "completed"),
    ne(eventsTable.status, "results_published"),
  ));
  let updated = 0;
  for (const e of events) if (await copyTrackCourseToEvent(e.id)) updated++;
  return updated;
}

/** The library track for an event or practice: by id (the club's own) or by name. */
export async function resolveTrackId(clubId: number, trackId: unknown, trackName: unknown): Promise<number | null> {
  if (trackId != null && trackId !== "") {
    const [t] = await db.select({ id: tracksTable.id }).from(tracksTable)
      .where(and(eq(tracksTable.id, Number(trackId)), eq(tracksTable.clubId, clubId)));
    if (t) return t.id;
  }
  if (typeof trackName === "string" && trackName.trim()) {
    const [t] = await db.select({ id: tracksTable.id }).from(tracksTable)
      .where(and(eq(tracksTable.clubId, clubId), sql`lower(trim(${tracksTable.name})) = lower(trim(${trackName}))`))
      .limit(1);
    if (t) return t.id;
  }
  return null;
}

/** Advisory-lock namespace for copying a track's course into an event. */
const EVENT_COURSE_LOCK = 7_320_002;
