import { Router } from "express";
import bcrypt from "bcryptjs";
import { getDb } from "../db";

const router = Router();

/**
 * POST /api/desktop/init
 *
 * Called by the Electron main process on every launch.
 * Ensures a default club + organizer user exist in the local SQLite DB,
 * authenticates the session, and returns via Set-Cookie so Electron can
 * inject it into the BrowserWindow before loading /dashboard.
 */
router.post("/desktop/init", (req, res) => {
  const db = getDb();

  let club = db.prepare("SELECT * FROM clubs LIMIT 1").get() as Record<string, unknown> | undefined;
  if (!club) {
    const r = db
      .prepare("INSERT INTO clubs (name, state) VALUES ('My Club', '')")
      .run();
    club = { id: r.lastInsertRowid };
  }

  let user = db
    .prepare("SELECT * FROM users WHERE club_id = ? LIMIT 1")
    .get(club.id) as Record<string, unknown> | undefined;
  if (!user) {
    const hash = bcrypt.hashSync("admin", 10);
    const r = db
      .prepare(
        "INSERT INTO users (club_id, email, password_hash, role, first_name, last_name, tour_completed) VALUES (?, 'admin@localhost', ?, 'club_organizer', 'Organizer', '', 1)"
      )
      .run(club.id, hash);
    user = db
      .prepare("SELECT * FROM users WHERE id = ?")
      .get(r.lastInsertRowid) as Record<string, unknown>;
  }

  (req.session as any).userId = user.id;

  req.session.save((err) => {
    if (err) {
      console.error("[desktop/init] session save error:", err);
      return res.status(500).json({ error: "Session save failed" });
    }
    return res.json({ ok: true });
  });
});

export default router;
