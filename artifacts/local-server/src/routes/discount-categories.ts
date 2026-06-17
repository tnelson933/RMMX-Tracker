import { Router } from "express";
import { getDb } from "../db";

const router = Router();

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

  return res.json(
    categories.map((c) => ({
      id: c.id,
      clubId: c.club_id,
      name: c.name,
      description: c.description ?? null,
      createdAt: c.created_at,
    })),
  );
});

export default router;
