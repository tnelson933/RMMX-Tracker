import { Router, type Response } from "express";
import { db } from "@workspace/db";
import { eventReaderAssignmentsTable, eventsTable, readersTable, usersTable, motosTable, enduroTimeChecksTable } from "@workspace/db/schema";
import { eq, and, inArray } from "drizzle-orm";
import { copyTrackCourseToEvent } from "../lib/trackCourse";

const router = Router();

async function authEvent(req: any, res: Response, eventId: number): Promise<boolean> {
  const userId = (req.session as any)?.userId;
  if (!userId) { res.status(401).json({ error: "You're signed out. Sign in again, then try once more." }); return false; }
  const [ev] = await db.select({ clubId: eventsTable.clubId }).from(eventsTable).where(eq(eventsTable.id, eventId));
  if (!ev) { res.status(404).json({ error: "This event couldn't be found. It may have been deleted. Go back to Events and open it again." }); return false; }
  const [user] = await db.select({ clubId: usersTable.clubId }).from(usersTable).where(eq(usersTable.id, userId));
  const staffClubId = res.locals.staffClubId;
  const restrictClub = typeof staffClubId === "number" ? staffClubId : user?.clubId ?? null;
  if (restrictClub !== null && restrictClub !== ev.clubId) { res.status(403).json({ error: "Your account doesn't have access to this. If it should, ask your club's owner to check your role on the Team page." }); return false; }
  return true;
}

// GET /events/:eventId/reader-assignments
router.get("/events/:eventId/reader-assignments", async (req, res) => {
  const eventId = Number(req.params.eventId);
  if (!eventId) return res.status(400).json({ error: "This link looks broken. Go back and open it again from the list." });
  if (!(await authEvent(req, res, eventId))) return;

  const rows = await db
    .select()
    .from(eventReaderAssignmentsTable)
    .where(eq(eventReaderAssignmentsTable.eventId, eventId));

  return res.json(rows);
});

// PUT /events/:eventId/reader-assignments — replace all assignments for this event
router.put("/events/:eventId/reader-assignments", async (req, res) => {
  const eventId = Number(req.params.eventId);
  if (!eventId) return res.status(400).json({ error: "This link looks broken. Go back and open it again from the list." });
  if (!(await authEvent(req, res, eventId))) return;

  const body = req.body as { assignments?: unknown };
  if (!Array.isArray(body?.assignments)) {
    return res.status(400).json({ error: "Something was missing from that request. Refresh the page and try again." });
  }

  // Verify all referenced readers belong to the event's club
  const [ev] = await db.select({ clubId: eventsTable.clubId }).from(eventsTable).where(eq(eventsTable.id, eventId));
  const readerIds = [...new Set(body.assignments.map((a: any) => Number(a?.readerId)).filter(Boolean))];
  if (readerIds.length > 0) {
    const ownedReaders = await db
      .select({ id: readersTable.id })
      .from(readersTable)
      .where(and(eq(readersTable.clubId, ev!.clubId)));
    const ownedIds = new Set(ownedReaders.map((r) => r.id));
    const unowned = readerIds.filter((id) => !ownedIds.has(id));
    if (unowned.length > 0) return res.status(403).json({ error: "Some of these readers aren't on your club. Refresh Reader Setup and try again." });
  }

  const incoming = body.assignments.map((a: any) => ({
    eventId,
    readerId: Number(a.readerId),
    antennaId: a.antennaId != null ? Number(a.antennaId) : null,
    role: ["start", "finish", "split", "time_check"].includes(a.role) ? a.role : "start",
    motoId: a.motoId != null ? Number(a.motoId) : null,
    timeCheckId: a.timeCheckId != null ? Number(a.timeCheckId) : null,
    sequence: Number.isInteger(a.sequence) ? a.sequence : null,
    label: typeof a.label === "string" && a.label.trim() ? a.label.trim().slice(0, 60) : null,
  }));

  // Test gates and time checks must be this event's own: otherwise a reader
  // could be aimed at another club's test and inject crossings into it.
  const motoIds = [...new Set(incoming.map(a => a.motoId).filter((v): v is number => v != null))];
  if (motoIds.length > 0) {
    const own = await db.select({ id: motosTable.id }).from(motosTable)
      .where(and(eq(motosTable.eventId, eventId), inArray(motosTable.id, motoIds)));
    if (own.length !== motoIds.length) return res.status(400).json({ error: "One or more tests don't belong to this event" });
  }
  const checkIds = [...new Set(incoming.map(a => a.timeCheckId).filter((v): v is number => v != null))];
  if (checkIds.length > 0) {
    const own = await db.select({ id: enduroTimeChecksTable.id }).from(enduroTimeChecksTable)
      .where(and(eq(enduroTimeChecksTable.eventId, eventId), inArray(enduroTimeChecksTable.id, checkIds)));
    if (own.length !== checkIds.length) return res.status(400).json({ error: "One or more time checks don't belong to this event" });
  }

  // Course map rules: one finish line for the event, splits are event-wide,
  // and a reader can't be two course points at once.
  const course = incoming.filter(a => a.motoId == null && (a.role === "finish" || a.role === "split"));
  if (incoming.some(a => a.role === "split" && a.motoId != null)) {
    return res.status(400).json({ error: "Split readers apply to the whole event, not one moto" });
  }
  if (course.filter(a => a.role === "finish").length > 1) {
    return res.status(400).json({ error: "An event has one finish-line reader" });
  }
  if (new Set(course.map(a => a.readerId)).size !== course.length) {
    return res.status(400).json({ error: "Each reader can only be in one place on the course" });
  }
  // Store splits as 1..N in the order given, so course positions are never
  // duplicated or missing.
  incoming
    .filter(a => a.role === "split")
    .sort((a, b) => (a.sequence ?? Number.MAX_SAFE_INTEGER) - (b.sequence ?? Number.MAX_SAFE_INTEGER))
    .forEach((a, i) => { a.sequence = i + 1; });

  // Changing the finish line or splits here makes the course this event's own
  // (it stops following its track). Enduro gates and time checks don't.
  const courseKey = (rows: Array<{ motoId: number | null; role: string; readerId: number; sequence: number | null; label: string | null }>) =>
    JSON.stringify(rows
      .filter(r => r.motoId == null && (r.role === "finish" || r.role === "split"))
      .map(r => [r.role, r.readerId, r.role === "split" ? r.sequence : null, r.role === "split" ? (r.label ?? null) : null])
      .sort());
  const previous = await db.select().from(eventReaderAssignmentsTable).where(eq(eventReaderAssignmentsTable.eventId, eventId));
  const courseChanged = courseKey(previous) !== courseKey(incoming);

  const saved = await db.transaction(async (tx) => {
    await tx.delete(eventReaderAssignmentsTable).where(eq(eventReaderAssignmentsTable.eventId, eventId));
    if (courseChanged) await tx.update(eventsTable).set({ courseSource: "custom" }).where(eq(eventsTable.id, eventId));
    if (incoming.length === 0) return [];
    return tx.insert(eventReaderAssignmentsTable).values(incoming).returning();
  });

  return res.json(saved);
});

// POST /events/:eventId/course/reset — follow the track's course again (copies it now).
router.post("/events/:eventId/course/reset", async (req, res) => {
  const eventId = Number(req.params.eventId);
  if (!eventId) return res.status(400).json({ error: "This link looks broken. Go back and open it again from the list." });
  if (!(await authEvent(req, res, eventId))) return;
  const [ev] = await db.select({ trackId: eventsTable.trackId }).from(eventsTable).where(eq(eventsTable.id, eventId));
  if (!ev?.trackId) return res.status(400).json({ error: "This event isn't linked to a Track Library track" });
  await db.update(eventsTable).set({ courseSource: "track" }).where(eq(eventsTable.id, eventId));
  await copyTrackCourseToEvent(eventId, { force: true });
  const rows = await db.select().from(eventReaderAssignmentsTable).where(eq(eventReaderAssignmentsTable.eventId, eventId));
  return res.json(rows);
});

export default router;
