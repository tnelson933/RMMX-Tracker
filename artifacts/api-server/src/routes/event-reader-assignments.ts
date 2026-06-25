import { Router, type Response } from "express";
import { db } from "@workspace/db";
import { eventReaderAssignmentsTable, eventsTable, readersTable, usersTable } from "@workspace/db/schema";
import { eq, and } from "drizzle-orm";

const router = Router();

async function authEvent(req: any, res: Response, eventId: number): Promise<boolean> {
  const userId = (req.session as any)?.userId;
  if (!userId) { res.status(401).json({ error: "Unauthorized" }); return false; }
  const [ev] = await db.select({ clubId: eventsTable.clubId }).from(eventsTable).where(eq(eventsTable.id, eventId));
  if (!ev) { res.status(404).json({ error: "Event not found" }); return false; }
  const [user] = await db.select({ clubId: usersTable.clubId }).from(usersTable).where(eq(usersTable.id, userId));
  const staffClubId = res.locals.staffClubId;
  const restrictClub = typeof staffClubId === "number" ? staffClubId : user?.clubId ?? null;
  if (restrictClub !== null && restrictClub !== ev.clubId) { res.status(403).json({ error: "Forbidden" }); return false; }
  return true;
}

// GET /events/:eventId/reader-assignments
router.get("/events/:eventId/reader-assignments", async (req, res) => {
  const eventId = Number(req.params.eventId);
  if (!eventId) return res.status(400).json({ error: "Invalid eventId" });
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
  if (!eventId) return res.status(400).json({ error: "Invalid eventId" });
  if (!(await authEvent(req, res, eventId))) return;

  const body = req.body as { assignments?: unknown };
  if (!Array.isArray(body?.assignments)) {
    return res.status(400).json({ error: "assignments array is required" });
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
    if (unowned.length > 0) return res.status(403).json({ error: "One or more readers do not belong to this club" });
  }

  const incoming = body.assignments.map((a: any) => ({
    eventId,
    readerId: Number(a.readerId),
    antennaId: a.antennaId != null ? Number(a.antennaId) : null,
    role: ["start", "finish", "time_check"].includes(a.role) ? a.role : "start",
    motoId: a.motoId != null ? Number(a.motoId) : null,
    timeCheckId: a.timeCheckId != null ? Number(a.timeCheckId) : null,
  }));

  const saved = await db.transaction(async (tx) => {
    await tx.delete(eventReaderAssignmentsTable).where(eq(eventReaderAssignmentsTable.eventId, eventId));
    if (incoming.length === 0) return [];
    return tx.insert(eventReaderAssignmentsTable).values(incoming).returning();
  });

  return res.json(saved);
});

export default router;
