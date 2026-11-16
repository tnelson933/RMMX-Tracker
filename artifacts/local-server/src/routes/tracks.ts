import { Router } from "express";
import { getDb } from "../db";
import { isoTime, parseJson } from "../lib/cloud-shape";

// The club's Track Library. Tracks are pulled from the cloud and ones made or
// changed here are pushed back (desktop sync). Same rules, messages and JSON
// as api-server/src/routes/tracks.ts.

const router = Router();

const SIGNED_OUT = "You're signed out. Sign in again, then try once more.";
const NOT_FOUND = "That item couldn't be found. It may have been deleted. Refresh the page and try again.";
const LIMITS = { name: 120, address: 200, city: 80, state: 40, zip: 20 } as const;

/** A trimmed text field (null when blank), or an error when it's too long. */
function field(value: unknown, key: keyof typeof LIMITS): { value: string | null } | { error: string } {
  const text = typeof value === "string" ? value.trim().replace(/\s+/g, " ") : "";
  if (text.length > LIMITS[key]) return { error: `Keep the ${key === "zip" ? "ZIP" : key} to ${LIMITS[key]} characters or fewer.` };
  return { value: text || null };
}

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
    createdAt: isoTime(row.created_at),
  };
}

// GET /tracks — the club's tracks, each with its course map (finish first, then
// splits in order) and how many events use it.
router.get("/tracks", (req, res) => {
  const clubId = getClubId(req);
  if (!clubId) return res.status(401).json({ error: SIGNED_OUT });

  const db = getDb();
  const tracks = db
    .prepare("SELECT * FROM tracks WHERE club_id = ? ORDER BY name ASC")
    .all(clubId) as any[];
  const usage = db.prepare("SELECT COUNT(*) AS n FROM events WHERE club_id = ? AND track_id = ?");
  return res.json(tracks.map((t) => ({
    ...serializeTrack(t),
    eventCount: (usage.get(clubId, t.id) as { n: number }).n,
    course: parseJson<unknown[]>(t.course, []) ?? [],
  })));
});

// POST /tracks — add a track to the library
router.post("/tracks", (req, res) => {
  const clubId = getClubId(req);
  if (!clubId) return res.status(401).json({ error: SIGNED_OUT });

  const values: Record<string, string | null> = {};
  for (const key of Object.keys(LIMITS) as Array<keyof typeof LIMITS>) {
    const checked = field(req.body?.[key], key);
    if ("error" in checked) return res.status(400).json({ error: checked.error });
    values[key] = checked.value;
  }
  if (!values.name) return res.status(400).json({ error: "Enter the track or venue name." });

  const db = getDb();
  const existing = db.prepare("SELECT name FROM tracks WHERE club_id = ?").all(clubId) as Array<{ name: string }>;
  if (existing.some((t) => t.name.toLowerCase() === values.name!.toLowerCase())) {
    return res.status(409).json({ error: `${values.name} is already in your Track Library.` });
  }
  const ins = db
    .prepare("INSERT INTO tracks (club_id, name, address, city, state, zip, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .run(clubId, values.name, values.address, values.city, values.state, values.zip, new Date().toISOString());

  const track = db.prepare("SELECT * FROM tracks WHERE id = ?").get(ins.lastInsertRowid);
  return res.status(201).json({ ...serializeTrack(track), course: [], eventCount: 0 });
});

// PATCH /tracks/:id — rename a library track or update its address
router.patch("/tracks/:id", (req, res) => {
  const clubId = getClubId(req);
  if (!clubId) return res.status(401).json({ error: SIGNED_OUT });

  const id = Number(req.params.id);
  if (!id) return res.status(400).json({ error: "This link looks broken. Go back and open it again from the list." });

  const updates: Record<string, string | null> = {};
  for (const key of Object.keys(LIMITS) as Array<keyof typeof LIMITS>) {
    if (req.body?.[key] === undefined) continue;
    const checked = field(req.body[key], key);
    if ("error" in checked) return res.status(400).json({ error: checked.error });
    updates[key] = checked.value;
  }
  const db = getDb();
  if ("name" in updates) {
    if (!updates.name) return res.status(400).json({ error: "Enter the track or venue name." });
    const others = db.prepare("SELECT id, name FROM tracks WHERE club_id = ?").all(clubId) as Array<{ id: number; name: string }>;
    if (others.some((t) => t.id !== id && t.name.toLowerCase() === String(updates.name).toLowerCase())) {
      return res.status(409).json({ error: `${updates.name} is already in your Track Library.` });
    }
  }
  const fields = Object.keys(updates);
  if (fields.length === 0) return res.json({ ok: true });

  const result = db
    .prepare(`UPDATE tracks SET ${fields.map((f) => `${f} = ?`).join(", ")} WHERE id = ? AND club_id = ?`)
    .run(...Object.values(updates), id, clubId);
  if (result.changes === 0) return res.status(404).json({ error: NOT_FOUND });
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
  const clubId = getClubId(req);
  if (!clubId) return res.status(401).json({ error: SIGNED_OUT });

  const id = Number(req.params.id);
  if (!id) return res.status(400).json({ error: "This link looks broken. Go back and open it again from the list." });

  const db = getDb();
  const existing = db
    .prepare("SELECT id FROM tracks WHERE id = ? AND club_id = ?")
    .get(id, clubId);
  if (!existing) return res.status(404).json({ error: NOT_FOUND });

  // Events and practice sessions there keep their own copy of the course map;
  // they just stop following the track.
  db.transaction(() => {
    db.prepare("UPDATE events SET track_id = NULL, course_source = 'custom' WHERE track_id = ? AND club_id = ?").run(id, clubId);
    db.prepare("UPDATE practice_sessions SET track_id = NULL WHERE track_id = ? AND club_id = ?").run(id, clubId);
    db.prepare("DELETE FROM tracks WHERE id = ? AND club_id = ?").run(id, clubId);
  })();
  return res.json({ ok: true });
});

export default router;
