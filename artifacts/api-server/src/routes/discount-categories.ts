import { Router } from "express";
import { db } from "@workspace/db";
import { discountCategoriesTable, usersTable } from "@workspace/db";
import { eq, and } from "drizzle-orm";

const router = Router();

async function getClubId(userId: number): Promise<number | null> {
  const [user] = await db.select({ clubId: usersTable.clubId }).from(usersTable).where(eq(usersTable.id, userId));
  return user?.clubId ?? null;
}

router.get("/discount-categories", async (req, res) => {
  const userId = (req.session as any).userId;
  if (!userId) return res.status(401).json({ error: "Unauthorized" });

  const clubId = await getClubId(userId);
  if (!clubId) return res.status(403).json({ error: "No club associated with account" });

  const categories = await db.select().from(discountCategoriesTable)
    .where(eq(discountCategoriesTable.clubId, clubId))
    .orderBy(discountCategoriesTable.name);

  return res.json(categories.map(c => ({ ...c, createdAt: c.createdAt.toISOString() })));
});

router.post("/discount-categories", async (req, res) => {
  const userId = (req.session as any).userId;
  if (!userId) return res.status(401).json({ error: "Unauthorized" });

  const clubId = await getClubId(userId);
  if (!clubId) return res.status(403).json({ error: "No club associated with account" });

  const { name } = req.body;
  if (!name?.trim()) return res.status(400).json({ error: "name required" });

  const [cat] = await db.insert(discountCategoriesTable).values({
    clubId,
    name: String(name).trim(),
  }).returning();

  return res.status(201).json({ ...cat, createdAt: cat.createdAt.toISOString() });
});

router.patch("/discount-categories/:categoryId", async (req, res) => {
  const userId = (req.session as any).userId;
  if (!userId) return res.status(401).json({ error: "Unauthorized" });

  const clubId = await getClubId(userId);
  if (!clubId) return res.status(403).json({ error: "No club associated with account" });

  const categoryId = Number(req.params.categoryId);
  const { name } = req.body;
  if (!name?.trim()) return res.status(400).json({ error: "name required" });

  const [cat] = await db.update(discountCategoriesTable)
    .set({ name: String(name).trim() })
    .where(and(eq(discountCategoriesTable.id, categoryId), eq(discountCategoriesTable.clubId, clubId)))
    .returning();

  if (!cat) return res.status(404).json({ error: "Category not found" });
  return res.json({ ...cat, createdAt: cat.createdAt.toISOString() });
});

router.delete("/discount-categories/:categoryId", async (req, res) => {
  const userId = (req.session as any).userId;
  if (!userId) return res.status(401).json({ error: "Unauthorized" });

  const clubId = await getClubId(userId);
  if (!clubId) return res.status(403).json({ error: "No club associated with account" });

  const categoryId = Number(req.params.categoryId);
  const [deleted] = await db.delete(discountCategoriesTable)
    .where(and(eq(discountCategoriesTable.id, categoryId), eq(discountCategoriesTable.clubId, clubId)))
    .returning();

  if (!deleted) return res.status(404).json({ error: "Category not found" });
  return res.json({ ok: true });
});

export default router;
