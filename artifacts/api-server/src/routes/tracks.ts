import { Router } from "express";
import { db } from "@workspace/db";
import { tracksTable } from "@workspace/db/schema";
import { eq, and } from "drizzle-orm";
import { usersTable } from "@workspace/db/schema";

const router = Router();

async function getClubId(req: any): Promise<number | null> {
  const userId = (req.session as any)?.userId;
  if (!userId) return null;
  const [user] = await db.select({ clubId: usersTable.clubId }).from(usersTable).where(eq(usersTable.id, userId));
  return user?.clubId ?? null;
}

// GET /tracks — list all tracks for the organizer's club
router.get("/tracks", async (req, res) => {
  const clubId = await getClubId(req);
  if (!clubId) return res.status(401).json({ error: "Unauthorized" });

  const tracks = await db
    .select()
    .from(tracksTable)
    .where(eq(tracksTable.clubId, clubId))
    .orderBy(tracksTable.name);

  return res.json(tracks);
});

// POST /tracks — create a track in the library
router.post("/tracks", async (req, res) => {
  const clubId = await getClubId(req);
  if (!clubId) return res.status(401).json({ error: "Unauthorized" });

  const { name, address, city, state, zip } = req.body as { name?: string; address?: string; city?: string; state?: string; zip?: string };
  if (!name?.trim()) return res.status(400).json({ error: "name is required" });

  const [track] = await db
    .insert(tracksTable)
    .values({
      clubId,
      name: name.trim(),
      address: address?.trim() || null,
      city: city?.trim() || null,
      state: state?.trim() || null,
      zip: zip?.trim() || null,
    })
    .returning();

  return res.status(201).json(track);
});

// DELETE /tracks/:id — remove a track
router.delete("/tracks/:id", async (req, res) => {
  const clubId = await getClubId(req);
  if (!clubId) return res.status(401).json({ error: "Unauthorized" });

  const id = Number(req.params.id);
  if (!id) return res.status(400).json({ error: "Invalid id" });

  const [deleted] = await db
    .delete(tracksTable)
    .where(and(eq(tracksTable.id, id), eq(tracksTable.clubId, clubId)))
    .returning();

  if (!deleted) return res.status(404).json({ error: "Not found" });
  return res.json({ ok: true });
});

export default router;
