import { Router } from "express";
import { db } from "@workspace/db";
import { tracksTable, trackCoursePointsTable, eventsTable, practiceSessionsTable } from "@workspace/db/schema";
import { eq, and, inArray, count } from "drizzle-orm";
import { normaliseCourse, propagateTrackCourse } from "../lib/trackCourse";
import { usersTable } from "@workspace/db/schema";

const router = Router();

const LIMITS = { name: 120, address: 200, city: 80, state: 40, zip: 20 } as const;

/** A trimmed text field (null when blank), or an error when it's too long. */
function field(value: unknown, key: keyof typeof LIMITS): { value: string | null } | { error: string } {
  const text = typeof value === "string" ? value.trim().replace(/\s+/g, " ") : "";
  if (text.length > LIMITS[key]) return { error: `Keep the ${key === "zip" ? "ZIP" : key} to ${LIMITS[key]} characters or fewer.` };
  return { value: text || null };
}

async function getClubId(req: any): Promise<number | null> {
  const userId = (req.session as any)?.userId;
  if (!userId) return null;
  const [user] = await db.select({ clubId: usersTable.clubId }).from(usersTable).where(eq(usersTable.id, userId));
  return user?.clubId ?? null;
}

// GET /tracks — list all tracks for the organizer's club
router.get("/tracks", async (req, res) => {
  const clubId = await getClubId(req);
  if (!clubId) return res.status(401).json({ error: "You're signed out. Sign in again, then try once more." });

  const tracks = await db
    .select()
    .from(tracksTable)
    .where(eq(tracksTable.clubId, clubId))
    .orderBy(tracksTable.name);

  // Each track's course map (finish + ordered splits).
  const points = tracks.length === 0 ? [] : await db.select().from(trackCoursePointsTable)
    .where(inArray(trackCoursePointsTable.trackId, tracks.map(t => t.id)));
  // How many events use each track, so removing one can say what it affects.
  const usage = tracks.length === 0 ? [] : await db.select({ trackId: eventsTable.trackId, n: count() }).from(eventsTable)
    .where(and(eq(eventsTable.clubId, clubId), inArray(eventsTable.trackId, tracks.map(t => t.id))))
    .groupBy(eventsTable.trackId);
  return res.json(tracks.map(t => ({
    ...t,
    eventCount: usage.find(u => u.trackId === t.id)?.n ?? 0,
    course: points
      .filter(p => p.trackId === t.id)
      .sort((a, b) => (a.role === "finish" ? -1 : 0) - (b.role === "finish" ? -1 : 0) || (a.sequence ?? 0) - (b.sequence ?? 0))
      .map(p => ({ readerId: p.readerId, role: p.role, sequence: p.sequence, label: p.label })),
  })));
});

// POST /tracks — create a track in the library
router.post("/tracks", async (req, res) => {
  const clubId = await getClubId(req);
  if (!clubId) return res.status(401).json({ error: "You're signed out. Sign in again, then try once more." });

  const values: Record<string, string | null> = {};
  for (const key of Object.keys(LIMITS) as Array<keyof typeof LIMITS>) {
    const checked = field(req.body?.[key], key);
    if ("error" in checked) return res.status(400).json({ error: checked.error });
    values[key] = checked.value;
  }
  if (!values.name) return res.status(400).json({ error: "Enter the track or venue name." });
  const existing = await db.select({ name: tracksTable.name }).from(tracksTable).where(eq(tracksTable.clubId, clubId));
  if (existing.some(t => t.name.toLowerCase() === values.name!.toLowerCase())) {
    return res.status(409).json({ error: `${values.name} is already in your Track Library.` });
  }

  const [track] = await db
    .insert(tracksTable)
    .values({ clubId, name: values.name, address: values.address, city: values.city, state: values.state, zip: values.zip })
    .returning();

  return res.status(201).json({ ...track, course: [], eventCount: 0 });
});

// PATCH /tracks/:id — rename a library track or update its address
router.patch("/tracks/:id", async (req, res) => {
  const clubId = await getClubId(req);
  if (!clubId) return res.status(401).json({ error: "You're signed out. Sign in again, then try once more." });

  const id = Number(req.params.id);
  if (!id) return res.status(400).json({ error: "This link looks broken. Go back and open it again from the list." });

  const updates: Record<string, unknown> = {};
  for (const key of Object.keys(LIMITS) as Array<keyof typeof LIMITS>) {
    if (req.body?.[key] === undefined) continue;
    const checked = field(req.body[key], key);
    if ("error" in checked) return res.status(400).json({ error: checked.error });
    updates[key] = checked.value;
  }
  if ("name" in updates) {
    if (!updates.name) return res.status(400).json({ error: "Enter the track or venue name." });
    const others = await db.select({ id: tracksTable.id, name: tracksTable.name }).from(tracksTable).where(eq(tracksTable.clubId, clubId));
    if (others.some(t => t.id !== id && t.name.toLowerCase() === String(updates.name).toLowerCase())) {
      return res.status(409).json({ error: `${updates.name} is already in your Track Library.` });
    }
  }

  if (Object.keys(updates).length === 0) return res.json({ ok: true });

  const [track] = await db
    .update(tracksTable)
    .set(updates as any)
    .where(and(eq(tracksTable.id, id), eq(tracksTable.clubId, clubId)))
    .returning();

  if (!track) return res.status(404).json({ error: "That item couldn't be found. It may have been deleted. Refresh the page and try again." });
  return res.json(track);
});

// PUT /tracks/:id/course — the track's course map (finish reader + ordered
// splits). Events at the track that follow it get the new course, unless they
// were customized or have already raced.
router.put("/tracks/:id/course", async (req, res) => {
  const clubId = await getClubId(req);
  if (!clubId) return res.status(401).json({ error: "You're signed out. Sign in again, then try once more." });
  const id = Number(req.params.id);
  const [track] = await db.select().from(tracksTable).where(and(eq(tracksTable.id, id), eq(tracksTable.clubId, clubId)));
  if (!track) return res.status(404).json({ error: "That item couldn't be found. It may have been deleted. Refresh the page and try again." });

  const checked = await normaliseCourse((req.body as any)?.points, clubId);
  if (!checked.ok) return res.status(400).json({ error: checked.error });

  await db.transaction(async (tx) => {
    await tx.delete(trackCoursePointsTable).where(eq(trackCoursePointsTable.trackId, id));
    if (checked.points.length > 0) {
      await tx.insert(trackCoursePointsTable).values(checked.points.map(p => ({ trackId: id, ...p })));
    }
  });
  const eventsUpdated = await propagateTrackCourse(id);
  return res.json({ ok: true, course: checked.points, eventsUpdated });
});

// DELETE /tracks/:id — remove a track
router.delete("/tracks/:id", async (req, res) => {
  const clubId = await getClubId(req);
  if (!clubId) return res.status(401).json({ error: "You're signed out. Sign in again, then try once more." });

  const id = Number(req.params.id);
  if (!id) return res.status(400).json({ error: "This link looks broken. Go back and open it again from the list." });

  // Events and practice sessions there keep their own copy of the course map;
  // they just stop following the track. Unlink them before the delete (the
  // database's ON DELETE SET NULL would otherwise leave them marked as
  // following a track).
  const deleted = await db.transaction(async (tx) => {
    const [row] = await tx.select({ id: tracksTable.id }).from(tracksTable)
      .where(and(eq(tracksTable.id, id), eq(tracksTable.clubId, clubId)));
    if (!row) return null;
    await tx.update(eventsTable).set({ trackId: null, courseSource: "custom" })
      .where(and(eq(eventsTable.trackId, id), eq(eventsTable.clubId, clubId)));
    await tx.update(practiceSessionsTable).set({ trackId: null })
      .where(and(eq(practiceSessionsTable.trackId, id), eq(practiceSessionsTable.clubId, clubId)));
    await tx.delete(tracksTable).where(eq(tracksTable.id, id));
    return row;
  });

  if (!deleted) return res.status(404).json({ error: "That item couldn't be found. It may have been deleted. Refresh the page and try again." });
  return res.json({ ok: true });
});

export default router;
