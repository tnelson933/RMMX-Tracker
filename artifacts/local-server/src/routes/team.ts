import { Router } from "express";
import { getDb } from "../db";
import { cloudReachable } from "../lib/cloud-proxy";

/**
 * Team (staff) management belongs to the cloud: invitations are emailed, and
 * accounts, passwords and permissions are the website's. Nothing is saved on
 * this computer, where it would differ from the website and never reach it.
 * Adding, changing or removing a team member is passed to the cloud (it answers
 * "needs an internet connection" when offline); the list is shown from the last
 * sync when there is no internet.
 */
const router = Router();

function requireOrganizer(req: any, res: any): { userId: number; clubId: number } | null {
  const userId = (req.session as any)?.userId;
  if (!userId) {
    res.status(401).json({ error: "You're signed out. Sign in again, then try once more." });
    return null;
  }
  const db = getDb();
  const user = db
    .prepare("SELECT id, club_id, role FROM users WHERE id = ?")
    .get(userId) as any;
  if (!user || !["organizer", "club_organizer"].includes(user.role) || !user.club_id) {
    res.status(403).json({ error: "Your account doesn't have access to this. If it should, ask your club's owner to check your role on the Team page." });
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

// GET /organizer/team — the cloud's list when online, else the copy from the last sync.
router.get("/organizer/team", async (req, res, next) => {
  const auth = requireOrganizer(req, res);
  if (!auth) return;
  if (await cloudReachable()) return next();

  const members = getDb()
    .prepare("SELECT * FROM users WHERE club_id = ? AND role = 'staff' ORDER BY created_at ASC")
    .all(auth.clubId) as any[];
  return res.json(members.map(formatMember));
});

// Invite, change, remove: only the club's organizer, and only through the cloud
// (the pass-through mounted after the local routes).
for (const method of ["post", "patch", "delete"] as const) {
  router[method](["/organizer/team", "/organizer/team/:userId"], (req, res, next) => {
    if (!requireOrganizer(req, res)) return;
    return next();
  });
}

export default router;
