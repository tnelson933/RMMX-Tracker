import { Router } from "express";
import crypto from "crypto";
import { db } from "@workspace/db";
import { usersTable, clubsTable, passwordSetupTokensTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { sendSetupEmail } from "../lib/email";

const router = Router();

function getAppUrl(): string {
  if (process.env.APP_URL) return process.env.APP_URL;
  const domains = process.env.REPLIT_DOMAINS;
  if (domains) return `https://${domains.split(",")[0]}`;
  return "http://localhost:80";
}

async function requireSuperAdmin(req: any, res: any): Promise<boolean> {
  const sessionUserId = (req.session as any).userId;
  if (!sessionUserId) {
    res.status(401).json({ error: "Not authenticated" });
    return false;
  }
  const [user] = await db.select().from(usersTable).where(eq(usersTable.id, sessionUserId));
  if (!user || user.role !== "super_admin") {
    res.status(403).json({ error: "Forbidden" });
    return false;
  }
  return true;
}

router.get("/users", async (req, res) => {
  if (!(await requireSuperAdmin(req, res))) return;

  const rows = await db
    .select({
      id: usersTable.id,
      email: usersTable.email,
      name: usersTable.name,
      role: usersTable.role,
      clubId: usersTable.clubId,
      clubName: clubsTable.name,
      passwordHash: usersTable.passwordHash,
      createdAt: usersTable.createdAt,
    })
    .from(usersTable)
    .leftJoin(clubsTable, eq(usersTable.clubId, clubsTable.id));

  return res.json(
    rows.map((u) => ({
      id: u.id,
      email: u.email,
      name: u.name,
      role: u.role,
      clubId: u.clubId ?? null,
      clubName: u.clubName ?? null,
      hasPassword: !!u.passwordHash,
      createdAt: u.createdAt.toISOString(),
    }))
  );
});

router.post("/users", async (req, res) => {
  if (!(await requireSuperAdmin(req, res))) return;

  const { email, name, role, clubId } = req.body;
  if (!email || !name || !role) {
    return res.status(400).json({ error: "email, name, and role are required" });
  }

  const trimmedEmail = String(email).toLowerCase().trim();
  const existing = await db
    .select()
    .from(usersTable)
    .where(eq(usersTable.email, trimmedEmail));
  if (existing[0]) {
    return res.status(409).json({ error: "An account with this email already exists" });
  }

  const [newUser] = await db
    .insert(usersTable)
    .values({
      email: trimmedEmail,
      name: String(name),
      role: String(role),
      clubId: clubId ? Number(clubId) : null,
      passwordHash: null,
    })
    .returning();

  const token = crypto.randomBytes(32).toString("hex");
  const expiresAt = new Date(Date.now() + 72 * 60 * 60 * 1000);
  await db.insert(passwordSetupTokensTable).values({ userId: newUser.id, token, expiresAt });

  await sendSetupEmail({ to: newUser.email, name: newUser.name, token, appUrl: getAppUrl(), isNew: true });

  return res.status(201).json({
    id: newUser.id,
    email: newUser.email,
    name: newUser.name,
    role: newUser.role,
    clubId: newUser.clubId ?? null,
    clubName: null,
    hasPassword: false,
    createdAt: newUser.createdAt.toISOString(),
  });
});

router.delete("/users/:userId", async (req, res) => {
  if (!(await requireSuperAdmin(req, res))) return;

  const sessionUserId = (req.session as any).userId;
  const userId = Number(req.params.userId);
  if (userId === sessionUserId) {
    return res.status(400).json({ error: "Cannot delete your own account" });
  }

  await db.delete(usersTable).where(eq(usersTable.id, userId));
  return res.json({ ok: true });
});

router.post("/users/:userId/resend-invite", async (req, res) => {
  if (!(await requireSuperAdmin(req, res))) return;

  const userId = Number(req.params.userId);
  const [user] = await db.select().from(usersTable).where(eq(usersTable.id, userId));
  if (!user) return res.status(404).json({ error: "User not found" });

  const token = crypto.randomBytes(32).toString("hex");
  const expiresAt = new Date(Date.now() + 72 * 60 * 60 * 1000);
  await db.insert(passwordSetupTokensTable).values({ userId: user.id, token, expiresAt });

  await sendSetupEmail({ to: user.email, name: user.name, token, appUrl: getAppUrl(), isNew: !user.passwordHash });

  return res.json({ ok: true });
});

export default router;
