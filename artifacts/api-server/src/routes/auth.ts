import { Router } from "express";
import crypto from "crypto";
import bcrypt from "bcryptjs";
import { db } from "@workspace/db";
import { usersTable, passwordSetupTokensTable, clubsTable } from "@workspace/db";
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

  const normalizedEmail = String(email).toLowerCase().trim();
  const users = await db.select().from(usersTable).where(eq(usersTable.email, normalizedEmail));
  const user = users[0];

  if (!user) {
    return res.status(401).json({ error: "Incorrect email or password. Please try again." });
  }

  if (!user.passwordHash) {
    return res.status(401).json({
      error: "Account not activated yet. Check your email for a setup link, or use 'First time sign in' below.",
    });
  }

  const valid = await bcrypt.compare(password, user.passwordHash);
  if (!valid) {
    return res.status(401).json({ error: "Incorrect email or password. Please try again." });
  }

  // Check if the club is active (non-super_admin users with a club)
  if (user.clubId && user.role !== "super_admin") {
    const [club] = await db.select({ active: clubsTable.active }).from(clubsTable).where(eq(clubsTable.id, user.clubId));
    if (club && club.active === false) {
      return res.status(403).json({
        error: "CLUB_INACTIVE",
        message: "Your club membership has been deactivated. Please call Rocky Mountain ATV/MC to reactivate your membership.",
      });
    }
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
      tourCompleted: user.tourCompleted,
      permissions: user.permissions ?? [],
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
    tourCompleted: user.tourCompleted,
    permissions: user.permissions ?? [],
    createdAt: user.createdAt.toISOString(),
  });
});

// POST /auth/complete-tour — mark the product tour as done for the current user
router.post("/auth/complete-tour", async (req, res) => {
  const userId = (req.session as any).userId;
  if (!userId) {
    return res.status(401).json({ error: "Not authenticated" });
  }
  await db.update(usersTable).set({ tourCompleted: true }).where(eq(usersTable.id, userId));
  return res.json({ ok: true });
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

// PATCH /auth/me — update own profile (name)
router.patch("/auth/me", async (req, res) => {
  const userId = (req.session as any).userId;
  if (!userId) return res.status(401).json({ error: "Not authenticated" });

  const { name } = req.body;
  if (name !== undefined && (typeof name !== "string" || !name.trim())) {
    return res.status(400).json({ error: "name must be a non-empty string" });
  }

  const updates: Record<string, string> = {};
  if (name !== undefined) updates.name = name.trim();

  const [updated] = await db
    .update(usersTable)
    .set(updates)
    .where(eq(usersTable.id, userId))
    .returning();

  return res.json({
    id: updated.id,
    email: updated.email,
    name: updated.name,
    role: updated.role,
    clubId: updated.clubId,
    tourCompleted: updated.tourCompleted,
    permissions: updated.permissions ?? [],
    createdAt: updated.createdAt.toISOString(),
  });
});

// POST /auth/offline-token — generate or return an offline sync token for the
// authenticated user. The token is stored on the user row and returned once so
// the Offline Mode page can bake it into the downloaded start script.
router.post("/auth/offline-token", async (req, res) => {
  const userId = (req.session as any).userId as number | undefined;
  if (!userId) return res.status(401).json({ error: "Not authenticated" });

  const token = crypto.randomUUID();
  const [updated] = await db
    .update(usersTable)
    .set({ offlineSyncToken: token })
    .where(eq(usersTable.id, userId))
    .returning({ token: usersTable.offlineSyncToken });

  if (!updated) return res.status(500).json({ error: "Failed to generate token" });
  return res.json({ token: updated.token });
});

export default router;
