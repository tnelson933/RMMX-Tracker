import { Router } from "express";
import bcrypt from "bcryptjs";
import { timingSafeEqual } from "crypto";
import { getDb } from "../db";
import { setRuntimeCloudCredentials } from "../lib/cloud-session";

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

/**
 * POST /api/desktop/cloud-credentials
 *
 * Called only by the Electron main process (never the renderer) to hand over
 * the signed-in organizer's cloud account, which the cloud pass-through uses.
 * Body: { email, password, cloudUrl } to sign in, or { clear: true } to sign out.
 * Requires the per-launch DESKTOP_CONTROL_TOKEN the desktop passed when it
 * started this server, and rejects anything a web page could send.
 */
const DESKTOP_CONTROL_TOKEN = process.env.DESKTOP_CONTROL_TOKEN ?? "";

function controlTokenMatches(given: unknown): boolean {
  if (!DESKTOP_CONTROL_TOKEN || typeof given !== "string") return false;
  const a = Buffer.from(given);
  const b = Buffer.from(DESKTOP_CONTROL_TOKEN);
  return a.length === b.length && timingSafeEqual(a, b);
}

router.post("/desktop/cloud-credentials", (req, res) => {
  if (req.headers.origin !== undefined || !req.is("application/json")) {
    return res.status(403).json({ error: "Forbidden" });
  }
  if (!controlTokenMatches(req.headers["x-rm-desktop-control"])) {
    return res.status(403).json({ error: "Forbidden" });
  }
  const { email, password, cloudUrl, clear } = (req.body ?? {}) as Record<string, unknown>;
  if (clear === true) {
    setRuntimeCloudCredentials(null);
    return res.json({ ok: true });
  }
  if (typeof email !== "string" || !email || typeof password !== "string" || !password) {
    return res.status(400).json({ error: "email and password are required" });
  }
  let url: string | undefined;
  if (typeof cloudUrl === "string" && cloudUrl) {
    try {
      const parsed = new URL(cloudUrl);
      if (parsed.protocol !== "https:" && parsed.protocol !== "http:") throw new Error("bad protocol");
      url = parsed.origin;
    } catch {
      return res.status(400).json({ error: "cloudUrl must be an http(s) URL" });
    }
  }
  setRuntimeCloudCredentials({ email, password, cloudUrl: url });
  return res.json({ ok: true });
});

export default router;
