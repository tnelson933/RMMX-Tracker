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

function getClubIdForUser(userId: number): number | null {
  const db = getDb();
  const user = db
    .prepare("SELECT club_id FROM users WHERE id = ?")
    .get(userId) as { club_id: number } | undefined;
  return user?.club_id ?? null;
}

router.post("/discount-categories", (req, res) => {
  const userId = (req.session as any).userId;
  if (!userId) return res.status(401).json({ error: "Not authenticated" });

  const clubId = getClubIdForUser(userId);
  if (!clubId) return res.status(403).json({ error: "No club associated with account" });

  const { name } = req.body;
  if (!String(name ?? "").trim()) return res.status(400).json({ error: "name required" });

  const db = getDb();
  const result = db
    .prepare("INSERT INTO discount_categories (club_id, name) VALUES (?, ?)")
    .run(clubId, String(name).trim());

  const row = db
    .prepare("SELECT * FROM discount_categories WHERE id = ?")
    .get(Number(result.lastInsertRowid)) as Record<string, unknown>;
  return res.status(201).json(serializeCategory(row));
});

router.patch("/discount-categories/:categoryId", (req, res) => {
  const userId = (req.session as any).userId;
  if (!userId) return res.status(401).json({ error: "Not authenticated" });

  const clubId = getClubIdForUser(userId);
  if (!clubId) return res.status(403).json({ error: "No club associated with account" });

  const categoryId = Number(req.params.categoryId);
  const { name } = req.body;
  if (!String(name ?? "").trim()) return res.status(400).json({ error: "name required" });

  const db = getDb();
  db.prepare("UPDATE discount_categories SET name = ? WHERE id = ? AND club_id = ?")
    .run(String(name).trim(), categoryId, clubId);

  const row = db
    .prepare("SELECT * FROM discount_categories WHERE id = ? AND club_id = ?")
    .get(categoryId, clubId) as Record<string, unknown> | undefined;
  if (!row) return res.status(404).json({ error: "Category not found" });
  return res.json(serializeCategory(row));
});

router.delete("/discount-categories/:categoryId", (req, res) => {
  const userId = (req.session as any).userId;
  if (!userId) return res.status(401).json({ error: "Not authenticated" });

  const clubId = getClubIdForUser(userId);
  if (!clubId) return res.status(403).json({ error: "No club associated with account" });

  const categoryId = Number(req.params.categoryId);
  const db = getDb();
  const row = db
    .prepare("SELECT id FROM discount_categories WHERE id = ? AND club_id = ?")
    .get(categoryId, clubId) as any;
  if (!row) return res.status(404).json({ error: "Category not found" });

  db.prepare("DELETE FROM discount_categories WHERE id = ? AND club_id = ?").run(categoryId, clubId);
  return res.json({ ok: true });
});

export default router;
