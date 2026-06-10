import { Router } from "express";
import crypto from "crypto";
import { db } from "@workspace/db";
import { usersTable, passwordSetupTokensTable } from "@workspace/db";
import { eq, and } from "drizzle-orm";
import { sendSetupEmail } from "../lib/email";

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
  return (raw as unknown[])
    .filter((p): p is string => typeof p === "string" && VALID_PERMISSIONS.has(p));
}

const router = Router();

function getAppUrl(): string {
  if (process.env.APP_URL) return process.env.APP_URL;
  const domains = process.env.REPLIT_DOMAINS;
  if (domains) return `https://${domains.split(",")[0]}`;
  return "http://localhost:80";
}

async function requireOrganizerSession(req: any, res: any): Promise<{ userId: number; clubId: number } | null> {
  const sessionUserId = (req.session as any).userId;
  if (!sessionUserId) {
    res.status(401).json({ error: "Not authenticated" });
    return null;
  }
  const [user] = await db.select().from(usersTable).where(eq(usersTable.id, sessionUserId));
  if (!user || user.role !== "club_organizer" || !user.clubId) {
    res.status(403).json({ error: "Forbidden" });
    return null;
  }
  return { userId: user.id, clubId: user.clubId };
}

function formatMember(u: typeof usersTable.$inferSelect) {
  return {
    id: u.id,
    email: u.email,
    name: u.name,
    permissions: u.permissions ?? [],
    status: u.passwordHash ? "active" : "invited",
    createdAt: u.createdAt.toISOString(),
  };
}

// GET /organizer/team — list staff employees for this club
router.get("/organizer/team", async (req, res) => {
  const auth = await requireOrganizerSession(req, res);
  if (!auth) return;

  const members = await db
    .select()
    .from(usersTable)
    .where(and(eq(usersTable.clubId, auth.clubId), eq(usersTable.role, "staff")));

  return res.json(members.map(formatMember));
});

// POST /organizer/team — create employee + send invite
router.post("/organizer/team", async (req, res) => {
  const auth = await requireOrganizerSession(req, res);
  if (!auth) return;

  const { name, email, permissions } = req.body;
  if (!name || !email) {
    return res.status(400).json({ error: "name and email are required" });
  }

  const trimmedEmail = String(email).toLowerCase().trim();
  const [existing] = await db.select().from(usersTable).where(eq(usersTable.email, trimmedEmail));
  if (existing) {
    if (existing.role === "super_admin") {
      return res.status(409).json({ error: "This email belongs to a platform admin — they already have full access and don't need a staff account." });
    }
    if (existing.role === "club_organizer" && existing.clubId === auth.clubId) {
      return res.status(409).json({ error: "This email belongs to your club's organizer account — they already have full access." });
    }
    if (existing.role === "staff" && existing.clubId === auth.clubId) {
      return res.status(409).json({ error: "This person is already a team member for your club." });
    }
    return res.status(409).json({ error: "This email is already associated with another account on the platform." });
  }

  const perms = sanitizePermissions(permissions);

  const [newUser] = await db
    .insert(usersTable)
    .values({
      email: trimmedEmail,
      name: String(name).trim(),
      role: "staff",
      clubId: auth.clubId,
      passwordHash: null,
      permissions: perms,
    })
    .returning();

  const token = crypto.randomBytes(32).toString("hex");
  const expiresAt = new Date(Date.now() + 72 * 60 * 60 * 1000);
  await db.insert(passwordSetupTokensTable).values({ userId: newUser.id, token, expiresAt });

  const emailResult = await sendSetupEmail({
    to: newUser.email,
    name: newUser.name,
    token,
    appUrl: getAppUrl(),
    isNew: true,
  });

  return res.status(201).json({
    ...formatMember(newUser),
    emailSent: emailResult.ok,
    setupUrl: emailResult.ok ? undefined : (emailResult as any).setupUrl,
  });
});

// PATCH /organizer/team/:userId — update name, email, permissions, or resend invite
router.patch("/organizer/team/:userId", async (req, res) => {
  const auth = await requireOrganizerSession(req, res);
  if (!auth) return;

  const userId = Number(req.params.userId);
  const [member] = await db
    .select()
    .from(usersTable)
    .where(and(eq(usersTable.id, userId), eq(usersTable.clubId, auth.clubId), eq(usersTable.role, "staff")));

  if (!member) {
    return res.status(404).json({ error: "Team member not found" });
  }

  const { name, email, permissions, resendInvite } = req.body;

  const updates: Partial<typeof usersTable.$inferInsert> = {};
  if (name !== undefined && String(name).trim()) updates.name = String(name).trim();
  if (email !== undefined) {
    const trimmedEmail = String(email).toLowerCase().trim();
    if (trimmedEmail !== member.email) {
      const [dup] = await db.select().from(usersTable).where(eq(usersTable.email, trimmedEmail));
      if (dup) return res.status(409).json({ error: "Email already in use" });
      updates.email = trimmedEmail;
    }
  }
  if (Array.isArray(permissions)) {
    updates.permissions = sanitizePermissions(permissions);
  }

  const [updated] = await db
    .update(usersTable)
    .set(updates)
    .where(eq(usersTable.id, userId))
    .returning();

  let emailSent: boolean | undefined;
  let setupUrl: string | undefined;

  if (resendInvite) {
    const token = crypto.randomBytes(32).toString("hex");
    const expiresAt = new Date(Date.now() + 72 * 60 * 60 * 1000);
    await db.insert(passwordSetupTokensTable).values({ userId: updated.id, token, expiresAt });
    const emailResult = await sendSetupEmail({
      to: updated.email,
      name: updated.name,
      token,
      appUrl: getAppUrl(),
      isNew: !updated.passwordHash,
    });
    emailSent = emailResult.ok;
    setupUrl = emailResult.ok ? undefined : (emailResult as any).setupUrl;
  }

  return res.json({ ...formatMember(updated), emailSent, setupUrl });
});

// DELETE /organizer/team/:userId — remove employee
router.delete("/organizer/team/:userId", async (req, res) => {
  const auth = await requireOrganizerSession(req, res);
  if (!auth) return;

  const userId = Number(req.params.userId);

  if (userId === auth.userId) {
    return res.status(400).json({ error: "Cannot remove your own account" });
  }

  const [member] = await db
    .select()
    .from(usersTable)
    .where(and(eq(usersTable.id, userId), eq(usersTable.clubId, auth.clubId), eq(usersTable.role, "staff")));

  if (!member) {
    return res.status(404).json({ error: "Team member not found" });
  }

  await db.delete(usersTable).where(eq(usersTable.id, userId));
  return res.json({ ok: true });
});

export default router;
