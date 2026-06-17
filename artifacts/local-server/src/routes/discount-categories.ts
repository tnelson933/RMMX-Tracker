import { Router } from "express";
import { getDb } from "../db";

const router = Router();

function serializeCategory(c: Record<string, unknown>) {
  return {
    id: c.id,
    clubId: c.club_id,
    name: c.name,
    description: c.description ?? null,
    createdAt: c.created_at,
  };
}

router.get("/discount-categories", (req, res) => {
  const userId = (req.session as any).userId;
  if (!userId) return res.status(401).json({ error: "Not authenticated" });

  const db = getDb();
  const user = db
    .prepare("SELECT club_id FROM users WHERE id = ?")
    .get(userId) as { club_id: number } | null;
  if (!user) return res.status(401).json({ error: "User not found" });

  const categories = db
    .prepare(
      "SELECT * FROM discount_categories WHERE club_id = ? ORDER BY name",
    )
    .all(user.club_id) as Record<string, unknown>[];

  return res.json(categories.map(serializeCategory));
});

router.get("/clubs/:clubId/discount-categories", (req, res) => {
  const userId = (req.session as any).userId;
  if (!userId) return res.status(401).json({ error: "Not authenticated" });

  const db = getDb();
  const clubId = Number(req.params.clubId);

  const categories = db
    .prepare(
      "SELECT * FROM discount_categories WHERE club_id = ? ORDER BY name",
    )
    .all(clubId) as Record<string, unknown>[];

  return res.json(categories.map(serializeCategory));
});

export default router;
