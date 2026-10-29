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
    address: row.address ?? null,
    city: row.city ?? null,
    state: row.state ?? null,
    zip: row.zip ?? null,
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

  const { name, address, city, state, zip } = req.body as {
    name?: string; address?: string; city?: string; state?: string; zip?: string;
  };
  if (!name?.trim()) return res.status(400).json({ error: "name is required" });

  const db = getDb();
  const ins = db
    .prepare("INSERT INTO tracks (club_id, name, address, city, state, zip) VALUES (?, ?, ?, ?, ?, ?)")
    .run(clubId, name.trim(), address?.trim() || null, city?.trim() || null, state?.trim() || null, zip?.trim() || null);

  const track = db
    .prepare("SELECT * FROM tracks WHERE id = ?")
    .get(ins.lastInsertRowid);
  return res.status(201).json(serializeTrack(track));
});

// PATCH /tracks/:id — update address/city/state/zip for an existing library track
router.patch("/tracks/:id", (req, res) => {
  const userId = (req.session as any)?.userId;
  if (!userId) return res.status(401).json({ error: "Unauthorized" });
  const clubId = getClubId(req);
  if (!clubId) return res.status(401).json({ error: "Unauthorized" });

  const id = Number(req.params.id);
  if (!id) return res.status(400).json({ error: "Invalid id" });

  const body = (req.body ?? {}) as Record<string, string | null | undefined>;
  const fields: string[] = [];
  const values: Array<string | null> = [];
  for (const key of ["address", "city", "state", "zip"] as const) {
    if (body[key] === undefined) continue;
    fields.push(`${key} = ?`);
    values.push(typeof body[key] === "string" ? body[key]!.trim() || null : null);
  }
  if (fields.length === 0) return res.json({ ok: true });

  const db = getDb();
  const result = db
    .prepare(`UPDATE tracks SET ${fields.join(", ")} WHERE id = ? AND club_id = ?`)
    .run(...values, id, clubId);
  if (result.changes === 0) return res.status(404).json({ error: "Not found" });
  return res.json(serializeTrack(db.prepare("SELECT * FROM tracks WHERE id = ?").get(id)));
});

// PUT /tracks/:id/course — track course maps are set up online; the desktop
// gets each event's copy when it syncs.
router.put("/tracks/:id/course", (_req, res) => {
  return res.status(409).json({
    error: "Set up a track's course map online (Team → Track Library at rmroost.com). The desktop app uses it for each event after it syncs.",
  });
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
