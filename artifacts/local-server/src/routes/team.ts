import { Router } from "express";
import bcrypt from "bcryptjs";
import crypto from "crypto";
import { getDb } from "../db";

const router = Router();

const VALID_PERMISSIONS = new Set([
  "dashboard",
  "events",
  "practice",
  "riders",
  "series",
  "points_tables",
  "payments",
  "discount_codes",
  "reader_setup",
  "offline_mode",
  "gate_schedule",
]);

function sanitizePermissions(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return (raw as unknown[]).filter(
    (p): p is string => typeof p === "string" && VALID_PERMISSIONS.has(p),
  );
}

function requireOrganizer(req: any, res: any): { userId: number; clubId: number } | null {
  const userId = (req.session as any)?.userId;
  if (!userId) {
    res.status(401).json({ error: "Not authenticated" });
    return null;
  }
  const db = getDb();
  const user = db
    .prepare("SELECT id, club_id, role FROM users WHERE id = ?")
    .get(userId) as any;
  if (!user || !["organizer", "club_organizer"].includes(user.role) || !user.club_id) {
    res.status(403).json({ error: "Forbidden" });
    return null;
  }
  return { userId: user.id, clubId: user.club_id };
}

function formatMember(u: any): object {
  return {
    id: u.id,
    email: u.email,
    name: u.name || [u.first_name, u.last_name].filter(Boolean).join(" ") || u.email,
    permissions: u.permissions
      ? (() => { try { return JSON.parse(u.permissions); } catch { return []; } })()
      : [],
    status: u.password_hash ? "active" : "invited",
    createdAt: u.created_at,
  };
}

function makeSetupUrl(token: string): string {
  const base = process.env.APP_URL ?? "http://localhost:9090";
  return `${base}/organizer/team/setup?token=${token}`;
}

// GET /organizer/team
router.get("/organizer/team", (req, res) => {
  const auth = requireOrganizer(req, res);
  if (!auth) return;

  const db = getDb();
  const members = db
    .prepare("SELECT * FROM users WHERE club_id = ? AND role = 'staff' ORDER BY created_at ASC")
    .all(auth.clubId) as any[];

  return res.json(members.map(formatMember));
});

// POST /organizer/team — create staff user + return setup URL (no email on desktop)
router.post("/organizer/team", async (req, res) => {
  const auth = requireOrganizer(req, res);
  if (!auth) return;

  const { name, email, permissions } = req.body;
  if (!name || !email) {
    return res.status(400).json({ error: "name and email are required" });
  }

  const trimmedEmail = String(email).toLowerCase().trim();
  const db = getDb();

  const existing = db
    .prepare("SELECT id, role, club_id FROM users WHERE lower(email) = lower(?)")
    .get(trimmedEmail) as any;
  if (existing) {
    if (existing.role === "staff" && existing.club_id === auth.clubId) {
      return res.status(409).json({ error: "This person is already a team member for your club." });
    }
    return res.status(409).json({ error: "This email is already associated with another account." });
  }

  const perms = sanitizePermissions(permissions);

  const result = db
    .prepare(
      `INSERT INTO users (club_id, email, name, role, password_hash, permissions, created_at)
       VALUES (?, ?, ?, 'staff', NULL, ?, datetime('now'))`,
    )
    .run(auth.clubId, trimmedEmail, String(name).trim(), JSON.stringify(perms));

  const newUserId = Number(result.lastInsertRowid);

  const token = crypto.randomBytes(32).toString("hex");
  const expiresAt = new Date(Date.now() + 72 * 60 * 60 * 1000).toISOString();
  db.prepare(
    "INSERT INTO password_setup_tokens (user_id, token, expires_at) VALUES (?, ?, ?)",
  ).run(newUserId, token, expiresAt);

  const newUser = db.prepare("SELECT * FROM users WHERE id = ?").get(newUserId) as any;

  return res.status(201).json({
    ...formatMember(newUser),
    emailSent: false,
    setupUrl: makeSetupUrl(token),
  });
});

// PATCH /organizer/team/:userId
router.patch("/organizer/team/:userId", async (req, res) => {
  const auth = requireOrganizer(req, res);
  if (!auth) return;

  const targetUserId = Number(req.params.userId);
  const db = getDb();
  const member = db
    .prepare("SELECT * FROM users WHERE id = ? AND club_id = ? AND role = 'staff'")
    .get(targetUserId, auth.clubId) as any;

  if (!member) {
    return res.status(404).json({ error: "Team member not found" });
  }

  const { name, email, permissions, resendInvite } = req.body;
  const fields: string[] = [];
  const values: unknown[] = [];

  if (name !== undefined && String(name).trim()) {
    fields.push("name = ?");
    values.push(String(name).trim());
  }
  if (email !== undefined) {
    const trimmedEmail = String(email).toLowerCase().trim();
    if (trimmedEmail !== member.email) {
      const dup = db
        .prepare("SELECT id FROM users WHERE lower(email) = lower(?) AND id != ?")
        .get(trimmedEmail, targetUserId);
      if (dup) return res.status(409).json({ error: "Email already in use" });
      fields.push("email = ?");
      values.push(trimmedEmail);
    }
  }
  if (Array.isArray(permissions)) {
    fields.push("permissions = ?");
    values.push(JSON.stringify(sanitizePermissions(permissions)));
  }

  if (fields.length > 0) {
    values.push(targetUserId);
    db.prepare(`UPDATE users SET ${fields.join(", ")} WHERE id = ?`).run(...(values as any[]));
  }

  let setupUrl: string | undefined;
  if (resendInvite) {
    const token = crypto.randomBytes(32).toString("hex");
    const expiresAt = new Date(Date.now() + 72 * 60 * 60 * 1000).toISOString();
    db.prepare(
      "INSERT INTO password_setup_tokens (user_id, token, expires_at) VALUES (?, ?, ?)",
    ).run(targetUserId, token, expiresAt);
    setupUrl = makeSetupUrl(token);
  }

  const updated = db.prepare("SELECT * FROM users WHERE id = ?").get(targetUserId) as any;
  return res.json({ ...formatMember(updated), emailSent: false, setupUrl });
});

// DELETE /organizer/team/:userId
router.delete("/organizer/team/:userId", (req, res) => {
  const auth = requireOrganizer(req, res);
  if (!auth) return;

  const targetUserId = Number(req.params.userId);
  if (targetUserId === auth.userId) {
    return res.status(400).json({ error: "Cannot remove your own account" });
  }

  const db = getDb();
  const member = db
    .prepare("SELECT id FROM users WHERE id = ? AND club_id = ? AND role = 'staff'")
    .get(targetUserId, auth.clubId);
  if (!member) {
    return res.status(404).json({ error: "Team member not found" });
  }

  db.prepare("DELETE FROM users WHERE id = ?").run(targetUserId);
  return res.json({ ok: true });
});

// POST /organizer/team/:userId/setup-password — staff sets their own password via token
router.post("/organizer/team/setup-password", async (req, res) => {
  const { token, password } = req.body;
  if (!token || !password) {
    return res.status(400).json({ error: "token and password are required" });
  }
  if (String(password).length < 8) {
    return res.status(400).json({ error: "Password must be at least 8 characters" });
  }

  const db = getDb();
  const tokenRow = db
    .prepare(
      "SELECT * FROM password_setup_tokens WHERE token = ? AND expires_at > datetime('now')",
    )
    .get(String(token)) as any;

  if (!tokenRow) {
    return res.status(400).json({ error: "Invalid or expired setup link" });
  }

  const hash = await bcrypt.hash(String(password), 10);
  db.prepare("UPDATE users SET password_hash = ? WHERE id = ?").run(hash, tokenRow.user_id);
  db.prepare("DELETE FROM password_setup_tokens WHERE token = ?").run(String(token));

  return res.json({ ok: true });
});

export default router;
