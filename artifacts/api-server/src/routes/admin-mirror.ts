/**
 * Mirror: a super admin views and works in RM Roost as one organizer to help
 * them. The session's user switches to the organizer (so every page, query
 * and permission is exactly what that organizer gets) and remembers the super
 * admin in session.mirrorBy; Quit switches back. Starts and stops are logged.
 *
 *   POST /admin/mirror            { email }  → act as that organizer
 *   POST /admin/mirror/stop                  → back to the super admin
 *   GET  /admin/mirror/organizers ?q=        → organizer emails for the picker
 */
import { Router } from "express";
import { db } from "@workspace/db";
import { usersTable, clubsTable } from "@workspace/db";
import { eq, ilike, or, ne, and, asc, isNotNull } from "drizzle-orm";
import { logger } from "../lib/logger";

const router = Router();

type MirrorSession = { userId?: number; mirrorBy?: number; mirrorStartedAt?: string };

async function realSuperAdmin(session: MirrorSession) {
  // While mirroring, the session user is the organizer; the super admin is mirrorBy.
  const adminId = session.mirrorBy ?? session.userId;
  if (!adminId) return null;
  const [admin] = await db
    .select({ id: usersTable.id, email: usersTable.email, role: usersTable.role })
    .from(usersTable)
    .where(eq(usersTable.id, adminId));
  return admin?.role === "super_admin" ? admin : null;
}

router.get("/admin/mirror/organizers", async (req, res) => {
  const session = req.session as unknown as MirrorSession;
  if (!(await realSuperAdmin(session))) return res.status(403).json({ error: "Only RM Roost admins can do this." });
  const q = typeof req.query.q === "string" ? req.query.q.trim() : "";
  const rows = await db
    .select({ email: usersTable.email, name: usersTable.name, role: usersTable.role, clubName: clubsTable.name })
    .from(usersTable)
    .leftJoin(clubsTable, eq(usersTable.clubId, clubsTable.id))
    .where(and(
      ne(usersTable.role, "super_admin"),
      isNotNull(usersTable.clubId),
      q ? or(ilike(usersTable.email, `%${q}%`), ilike(usersTable.name, `%${q}%`), ilike(clubsTable.name, `%${q}%`)) : undefined,
    ))
    .orderBy(asc(clubsTable.name), asc(usersTable.email))
    .limit(25);
  return res.json(rows);
});

router.post("/admin/mirror", async (req, res) => {
  const session = req.session as unknown as MirrorSession;
  if (session.mirrorBy) return res.status(409).json({ error: "You're already viewing another account. Exit that view first." });
  const admin = await realSuperAdmin(session);
  if (!admin) return res.status(403).json({ error: "Only RM Roost admins can do this." });

  const email = typeof req.body?.email === "string" ? req.body.email.trim().toLowerCase() : "";
  if (!email) return res.status(400).json({ error: "Enter the organizer's email address" });
  const [target] = await db
    .select({ id: usersTable.id, email: usersTable.email, name: usersTable.name, role: usersTable.role, clubId: usersTable.clubId })
    .from(usersTable)
    .where(eq(usersTable.email, email));
  if (!target) return res.status(404).json({ error: `There's no organizer account for ${email}` });
  if (target.role === "super_admin") return res.status(400).json({ error: "Super admin accounts can't be mirrored" });
  if (target.clubId == null) return res.status(400).json({ error: "That account isn't assigned to a club" });

  session.mirrorBy = admin.id;
  session.mirrorStartedAt = new Date().toISOString();
  session.userId = target.id;
  logger.info({ superAdminId: admin.id, superAdmin: admin.email, organizerId: target.id, organizer: target.email, clubId: target.clubId }, "Mirror started");
  req.session.save(() => { res.json({ ok: true, user: { id: target.id, email: target.email, name: target.name, clubId: target.clubId } }); });
  return undefined;
});

router.post("/admin/mirror/stop", (req, res) => {
  const session = req.session as unknown as MirrorSession;
  if (!session.mirrorBy) return res.json({ ok: true, mirroring: false });
  const organizerId = session.userId;
  session.userId = session.mirrorBy;
  logger.info({ superAdminId: session.mirrorBy, organizerId, startedAt: session.mirrorStartedAt }, "Mirror ended");
  delete session.mirrorBy;
  delete session.mirrorStartedAt;
  req.session.save(() => { res.json({ ok: true, mirroring: false }); });
  return undefined;
});

/** Mirror details for /auth/me, or null when the session isn't mirroring. */
export async function mirrorInfo(session: MirrorSession, clubId: number | null) {
  if (!session.mirrorBy) return null;
  const [admin] = await db
    .select({ id: usersTable.id, name: usersTable.name, email: usersTable.email })
    .from(usersTable)
    .where(eq(usersTable.id, session.mirrorBy));
  const [club] = clubId != null
    ? await db.select({ name: clubsTable.name }).from(clubsTable).where(eq(clubsTable.id, clubId))
    : [];
  return {
    adminId: admin?.id ?? session.mirrorBy,
    adminName: admin?.name ?? "Super admin",
    adminEmail: admin?.email ?? null,
    clubName: club?.name ?? null,
    startedAt: session.mirrorStartedAt ?? null,
  };
}

export default router;
