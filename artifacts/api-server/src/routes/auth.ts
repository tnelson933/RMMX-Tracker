import { Router } from "express";
import crypto from "crypto";
import bcrypt from "bcryptjs";
import { db } from "@workspace/db";
import { usersTable, passwordSetupTokensTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { sendSetupEmail } from "../lib/email";

const router = Router();

function getAppUrl(): string {
  if (process.env.APP_URL) return process.env.APP_URL;
  const domains = process.env.REPLIT_DOMAINS;
  if (domains) return `https://${domains.split(",")[0]}`;
  return "http://localhost:80";
}

router.post("/auth/login", async (req, res) => {
  const { email, password, rememberMe } = req.body;
  if (!email || !password) {
    return res.status(400).json({ error: "Email and password required" });
  }

  const users = await db.select().from(usersTable).where(eq(usersTable.email, email));
  const user = users[0];

  if (!user) {
    return res.status(401).json({ error: "Invalid credentials" });
  }

  if (!user.passwordHash) {
    return res.status(401).json({
      error: "Account not activated yet. Check your email for a setup link, or use 'First time sign in' below.",
    });
  }

  const valid = await bcrypt.compare(password, user.passwordHash);
  if (!valid) {
    return res.status(401).json({ error: "Invalid credentials" });
  }

  (req.session as any).userId = user.id;

  if (rememberMe) {
    req.session.cookie.maxAge = 30 * 24 * 60 * 60 * 1000;
  } else {
    req.session.cookie.expires = undefined;
  }

  return res.json({
    user: {
      id: user.id,
      email: user.email,
      name: user.name,
      role: user.role,
      clubId: user.clubId,
      createdAt: user.createdAt.toISOString(),
    },
    token: "session",
  });
});

router.post("/auth/logout", (req, res) => {
  req.session.destroy(() => {});
  res.json({ ok: true });
});

router.get("/auth/me", async (req, res) => {
  const userId = (req.session as any).userId;
  if (!userId) {
    return res.status(401).json({ error: "Not authenticated" });
  }

  const users = await db.select().from(usersTable).where(eq(usersTable.id, userId));
  const user = users[0];
  if (!user) {
    return res.status(401).json({ error: "Not authenticated" });
  }

  return res.json({
    id: user.id,
    email: user.email,
    name: user.name,
    role: user.role,
    clubId: user.clubId,
    createdAt: user.createdAt.toISOString(),
  });
});

// POST /auth/request-setup — send account setup or password reset email
router.post("/auth/request-setup", async (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ error: "Email required" });

  const trimmed = String(email).toLowerCase().trim();
  const [user] = await db.select().from(usersTable).where(eq(usersTable.email, trimmed));

  // Always return 200 to prevent email enumeration
  if (!user) return res.json({ ok: true });

  const token = crypto.randomBytes(32).toString("hex");
  const expiresAt = new Date(Date.now() + 72 * 60 * 60 * 1000); // 72 hours
  await db.insert(passwordSetupTokensTable).values({ userId: user.id, token, expiresAt });

  await sendSetupEmail({
    to: user.email,
    name: user.name,
    token,
    appUrl: getAppUrl(),
    isNew: !user.passwordHash,
  });

  return res.json({ ok: true });
});

// POST /auth/complete-setup — validate token and set password
router.post("/auth/complete-setup", async (req, res) => {
  const { token, password } = req.body;
  if (!token || !password) {
    return res.status(400).json({ error: "Token and password are required" });
  }
  if (String(password).length < 8) {
    return res.status(400).json({ error: "Password must be at least 8 characters" });
  }

  const [record] = await db
    .select()
    .from(passwordSetupTokensTable)
    .where(eq(passwordSetupTokensTable.token, token));

  if (!record || record.usedAt) {
    return res.status(400).json({ error: "This link is invalid or has already been used." });
  }
  if (record.expiresAt < new Date()) {
    return res.status(400).json({ error: "This link has expired. Please request a new one." });
  }

  const hash = await bcrypt.hash(String(password), 12);
  const now = new Date();

  await db.transaction(async (tx) => {
    await tx
      .update(usersTable)
      .set({ passwordHash: hash })
      .where(eq(usersTable.id, record.userId));
    await tx
      .update(passwordSetupTokensTable)
      .set({ usedAt: now })
      .where(eq(passwordSetupTokensTable.id, record.id));
  });

  return res.json({ ok: true });
});

export default router;
