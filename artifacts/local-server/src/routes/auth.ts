import { Router } from "express";
import bcrypt from "bcryptjs";
import { getDb, parseBool } from "../db";

const router = Router();

function formatUser(u: Record<string, unknown>) {
  const firstName = String(u.first_name ?? "").trim();
  const lastName = String(u.last_name ?? "").trim();
  const fullName = [firstName, lastName].filter(Boolean).join(" ") || String(u.email ?? "");
  return {
    id: u.id,
    email: u.email,
    name: fullName,
    role: u.role ?? "organizer",
    clubId: u.club_id,
    tourCompleted: parseBool(u.tour_completed as number | null),
    createdAt: u.created_at,
    permissions: u.permissions
      ? (() => { try { return JSON.parse(u.permissions as string) as string[]; } catch { return [] as string[]; } })()
      : [] as string[],
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

router.patch("/auth/me", async (req, res) => {
  const userId = (req.session as any).userId;
  if (!userId) return res.status(401).json({ error: "Not authenticated" });

  const db = getDb();
  const { name, email, password } = req.body;

  const fields: string[] = [];
  const values: unknown[] = [];

  if (name !== undefined) {
    const parts = String(name).trim().split(" ");
    fields.push("first_name = ?", "last_name = ?");
    values.push(parts[0] ?? "", parts.slice(1).join(" ") || "");
  }
  if (email !== undefined) {
    fields.push("email = ?");
    values.push(String(email).trim());
  }
  if (password) {
    const hash = await bcrypt.hash(String(password), 10);
    fields.push("password_hash = ?");
    values.push(hash);
  }

  if (fields.length === 0) {
    const user = db.prepare("SELECT * FROM users WHERE id = ?").get(userId) as Record<string, unknown>;
    return res.json(formatUser(user));
  }

  values.push(userId);
  db.prepare(`UPDATE users SET ${fields.join(", ")} WHERE id = ?`).run(...(values as any[]));

  const updated = db.prepare("SELECT * FROM users WHERE id = ?").get(userId) as Record<string, unknown>;
  return res.json(formatUser(updated));
});

router.post("/auth/complete-tour", (req, res) => {
  const userId = (req.session as any).userId;
  if (!userId) return res.status(401).json({ error: "Not authenticated" });
  getDb().prepare("UPDATE users SET tour_completed = 1 WHERE id = ?").run(userId);
  return res.json({ ok: true });
});

router.post("/auth/request-setup", (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ error: "Email required" });
  return res.json({ ok: true });
});

router.post("/auth/complete-setup", async (req, res) => {
  const { token, password } = req.body;
  if (!token || !password) {
    return res.status(400).json({ error: "Token and password are required" });
  }
  if (String(password).length < 8) {
    return res.status(400).json({ error: "Password must be at least 8 characters" });
  }

  const db = getDb();
  const record = db
    .prepare("SELECT * FROM password_setup_tokens WHERE token = ?")
    .get(String(token)) as Record<string, unknown> | undefined;

  if (!record || record.used_at) {
    return res.status(400).json({ error: "This link is invalid or has already been used." });
  }
  if (record.expires_at && new Date(record.expires_at as string) < new Date()) {
    return res.status(400).json({ error: "This link has expired. Please request a new one." });
  }

  const hash = await bcrypt.hash(String(password), 12);
  const now = new Date().toISOString();

  db.prepare("UPDATE users SET password_hash = ? WHERE id = ?").run(hash, record.user_id);
  db.prepare("UPDATE password_setup_tokens SET used_at = ? WHERE id = ?").run(now, record.id);

  return res.json({ ok: true });
});

export default router;
