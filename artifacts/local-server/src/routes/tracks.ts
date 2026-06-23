import { Router } from "express";
import { getDb } from "../db";

const router = Router();

function getClubId(req: any): number | null {
  const userId = (req.session as any)?.userId;
  if (!userId) return null;
  const db = getDb();
  const user = db
    .prepare("SELECT club_id FROM users WHERE id = ?")
    .get(userId) as { club_id: number } | undefined;
  return user?.club_id ?? null;
}

function serializeTrack(row: any) {
  return {
    id: row.id,
    clubId: row.club_id,
    name: row.name,
    state: row.state ?? null,
    createdAt: row.created_at,
  };
}

// GET /tracks — list all tracks for this club
router.get("/tracks", (req, res) => {
  const userId = (req.session as any)?.userId;
  if (!userId) return res.status(401).json({ error: "Unauthorized" });
  const clubId = getClubId(req);
  if (!clubId) return res.status(403).json({ error: "No club" });

  const db = getDb();
  const tracks = db
    .prepare("SELECT * FROM tracks WHERE club_id = ? ORDER BY name ASC")
    .all(clubId);
  return res.json(tracks.map(serializeTrack));
});

// POST /tracks — add a track to the library
router.post("/tracks", (req, res) => {
  const userId = (req.session as any)?.userId;
  if (!userId) return res.status(401).json({ error: "Unauthorized" });
  const clubId = getClubId(req);
  if (!clubId) return res.status(403).json({ error: "No club" });

  const { name, state } = req.body as { name?: string; state?: string };
  if (!name?.trim()) return res.status(400).json({ error: "name is required" });

  const db = getDb();
  const ins = db
    .prepare("INSERT INTO tracks (club_id, name, state) VALUES (?, ?, ?)")
    .run(clubId, name.trim(), state?.trim() || null);

  const track = db
    .prepare("SELECT * FROM tracks WHERE id = ?")
    .get(ins.lastInsertRowid);
  return res.status(201).json(serializeTrack(track));
});

// DELETE /tracks/:id — remove a track
router.delete("/tracks/:id", (req, res) => {
  const userId = (req.session as any)?.userId;
  if (!userId) return res.status(401).json({ error: "Unauthorized" });
  const clubId = getClubId(req);
  if (!clubId) return res.status(403).json({ error: "No club" });

  const id = Number(req.params.id);
  if (!id) return res.status(400).json({ error: "Invalid id" });

  const db = getDb();
  const existing = db
    .prepare("SELECT id FROM tracks WHERE id = ? AND club_id = ?")
    .get(id, clubId);
  if (!existing) return res.status(404).json({ error: "Not found" });

  db.prepare("DELETE FROM tracks WHERE id = ? AND club_id = ?").run(id, clubId);
  return res.json({ ok: true });
});

export default router;
