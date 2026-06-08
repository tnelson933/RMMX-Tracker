import { Router } from "express";
import bcrypt from "bcryptjs";
import { getDb, parseBool } from "../db";

const router = Router();

function formatUser(u: Record<string, unknown>) {
  return {
    id: u.id,
    email: u.email,
    name: u.name ?? "",
    role: u.role ?? "organizer",
    clubId: u.club_id,
    tourCompleted: parseBool(u.tour_completed as number | null),
    createdAt: u.created_at,
  };
}

router.post("/auth/login", async (req, res) => {
  const { email, password, rememberMe } = req.body;
  if (!email || !password) {
    return res.status(400).json({ error: "Email and password required" });
  }

  const db = getDb();
  const user = db
    .prepare("SELECT * FROM users WHERE lower(email) = lower(?)")
    .get(String(email).trim()) as Record<string, unknown> | undefined;

  if (!user) {
    return res.status(401).json({ error: "Invalid credentials" });
  }

  if (!user.password_hash) {
    return res.status(401).json({
      error: "Account not activated yet. Check your email for a setup link.",
    });
  }

  const valid = await bcrypt.compare(String(password), String(user.password_hash));
  if (!valid) {
    return res.status(401).json({ error: "Invalid credentials" });
  }

  (req.session as any).userId = user.id;

  if (rememberMe) {
    req.session.cookie.maxAge = 30 * 24 * 60 * 60 * 1000;
  } else {
    req.session.cookie.expires = undefined;
  }

  return res.json({ user: formatUser(user), token: "session" });
});

router.post("/auth/logout", (req, res) => {
  req.session.destroy(() => {});
  res.json({ ok: true });
});

router.get("/auth/me", (req, res) => {
  const userId = (req.session as any).userId;
  if (!userId) {
    return res.status(401).json({ error: "Not authenticated" });
  }

  const db = getDb();
  const user = db
    .prepare("SELECT * FROM users WHERE id = ?")
    .get(userId) as Record<string, unknown> | undefined;

  if (!user) {
    return res.status(401).json({ error: "Not authenticated" });
  }

  return res.json(formatUser(user));
});

router.post("/auth/complete-tour", (req, res) => {
  const userId = (req.session as any).userId;
  if (!userId) return res.status(401).json({ error: "Not authenticated" });
  getDb().prepare("UPDATE users SET tour_completed = 1 WHERE id = ?").run(userId);
  return res.json({ ok: true });
});

export default router;
