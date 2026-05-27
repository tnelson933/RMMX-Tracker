import { Router } from "express";
import { db } from "@workspace/db";
import { clubsTable } from "@workspace/db";
import { eq } from "drizzle-orm";

const router = Router();

function requireAdmin(req: any, res: any, next: any) {
  if (!req.session?.userId) return res.status(401).json({ error: "Unauthorized" });
  if ((req as any).sessionUser?.role !== "super_admin") return res.status(403).json({ error: "Forbidden: super_admin only" });
  next();
}

router.get("/clubs", async (req, res) => {
  const clubs = await db.select().from(clubsTable).orderBy(clubsTable.name);
  return res.json(clubs.map(c => ({ ...c, createdAt: c.createdAt.toISOString() })));
});

router.post("/clubs", async (req, res) => {
  const session = req.session as any;
  if (!session?.userId) return res.status(401).json({ error: "Unauthorized" });

  const { name, state, contactEmail, contactPhone, logoUrl, website, description } = req.body;
  if (!name || !state) return res.status(400).json({ error: "name and state required" });

  const [club] = await db.insert(clubsTable).values({ name, state, contactEmail, contactPhone, logoUrl, website, description }).returning();
  return res.status(201).json({ ...club, createdAt: club.createdAt.toISOString() });
});

router.get("/clubs/:clubId", async (req, res) => {
  const id = Number(req.params.clubId);
  const clubs = await db.select().from(clubsTable).where(eq(clubsTable.id, id));
  if (!clubs[0]) return res.status(404).json({ error: "Not found" });
  const c = clubs[0];
  return res.json({ ...c, createdAt: c.createdAt.toISOString() });
});

router.patch("/clubs/:clubId", async (req, res) => {
  const session = req.session as any;
  if (!session?.userId) return res.status(401).json({ error: "Unauthorized" });

  const id = Number(req.params.clubId);
  const { name, state, contactEmail, contactPhone, logoUrl, website, description } = req.body;
  const [club] = await db.update(clubsTable).set({ name, state, contactEmail, contactPhone, logoUrl, website, description }).where(eq(clubsTable.id, id)).returning();
  if (!club) return res.status(404).json({ error: "Not found" });
  return res.json({ ...club, createdAt: club.createdAt.toISOString() });
});

router.delete("/clubs/:clubId", async (req, res) => {
  const session = req.session as any;
  if (!session?.userId) return res.status(401).json({ error: "Unauthorized" });

  const id = Number(req.params.clubId);
  const deleted = await db.delete(clubsTable).where(eq(clubsTable.id, id)).returning();
  if (!deleted.length) return res.status(404).json({ error: "Not found" });
  return res.status(204).send();
});

export default router;
