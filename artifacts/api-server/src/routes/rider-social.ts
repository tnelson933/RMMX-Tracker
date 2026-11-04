import { Router } from "express";
import { db, riderAccountsTable, ridersTable, riderFollowsTable, riderProfileManagersTable, riderMaintenanceTable } from "@workspace/db";
import { and, asc, count, eq, inArray } from "drizzle-orm";
import { requireRiderAuth } from "./rider-portal";
import { canManageRider, managedRiderIds, ownsRider } from "../lib/riderAccess";
import { loadCareerStats, loadRacerResume, loadResultsFeed, searchPublicRiders } from "../lib/riderCareer";
import { effectiveVisibility } from "../lib/riderResume";

/**
 * Rider career stats, profile managers (multiple accounts per rider) and following.
 * All routes need a rider login (web session or mobile bearer token).
 */
const router = Router();

async function currentAccount(req: any) {
  const id = (req.session as any).riderAccountId as number | undefined;
  if (!id) return null;
  const [account] = await db.select({ id: riderAccountsTable.id, email: riderAccountsTable.email })
    .from(riderAccountsTable).where(eq(riderAccountsTable.id, id));
  return account ?? null;
}

async function loadRider(riderId: number) {
  if (!Number.isInteger(riderId) || riderId <= 0) return null;
  const [rider] = await db.select({ id: ridersTable.id, email: ridersTable.email, firstName: ridersTable.firstName, lastName: ridersTable.lastName })
    .from(ridersTable).where(eq(ridersTable.id, riderId));
  return rider ?? null;
}

// ── #4 Career stats (own and managed profiles: completed motos) ─────────────

/**
 * Everything one rider card on the Profile tab / My Profiles needs, in one call:
 * plate, main class, followers, average finish, recent published results (for
 * the sparkline) and maintenance items (for "next due"). Managers only.
 */
router.get("/rider/profiles/:riderId/card", requireRiderAuth, async (req, res) => {
  const account = await currentAccount(req);
  if (!account) return res.status(401).json({ error: "You're signed out. Sign in again, then try once more." });
  const rider = await loadRider(Number(req.params.riderId));
  if (!rider) return res.status(404).json({ error: "This rider couldn't be found. It may have been deleted. Refresh the page and try again." });
  if (!(await canManageRider(account, rider))) return res.status(403).json({ error: "This rider profile isn't on your account. Sign in with the account that owns it, or ask the owner to add you as a manager." });
  const [[extra], { stats, resume }, recent, [followers], maintenance] = await Promise.all([
    db.select({ plateColor: ridersTable.plateColor }).from(ridersTable).where(eq(ridersTable.id, rider.id)),
    // Completed motos only, so a race still running doesn't count (matches the racer profile).
    loadRacerResume(rider.id, true),
    loadResultsFeed([rider.id], 6),
    db.select({ n: count() }).from(riderFollowsTable).where(eq(riderFollowsTable.riderId, rider.id)),
    db.select({ itemName: riderMaintenanceTable.itemName, intervalDays: riderMaintenanceTable.intervalDays, lastServicedAt: riderMaintenanceTable.lastServicedAt })
      .from(riderMaintenanceTable).where(eq(riderMaintenanceTable.riderId, rider.id))
      .orderBy(asc(riderMaintenanceTable.sortOrder), asc(riderMaintenanceTable.id)),
  ]);
  return res.json({
    riderId: rider.id,
    plateColor: extra?.plateColor ?? null,
    className: resume.classes[0] ?? null,
    followerCount: Number(followers?.n ?? 0),
    avgFinish: stats.avgFinish,
    recent,
    maintenance,
  });
});

router.get("/rider/profiles/:riderId/stats", requireRiderAuth, async (req, res) => {
  const account = await currentAccount(req);
  if (!account) return res.status(401).json({ error: "You're signed out. Sign in again, then try once more." });
  const rider = await loadRider(Number(req.params.riderId));
  if (!rider) return res.status(404).json({ error: "This rider couldn't be found. It may have been deleted. Refresh the page and try again." });
  if (!(await canManageRider(account, rider))) return res.status(403).json({ error: "This rider profile isn't on your account. Sign in with the account that owns it, or ask the owner to add you as a manager." });
  return res.json({ riderId: rider.id, name: `${rider.firstName} ${rider.lastName}`.trim(), stats: await loadCareerStats(rider.id, true) });
});

// ── #6 Profile managers ─────────────────────────────────────────────────────
router.get("/rider/profiles/:riderId/managers", requireRiderAuth, async (req, res) => {
  const account = await currentAccount(req);
  if (!account) return res.status(401).json({ error: "You're signed out. Sign in again, then try once more." });
  const rider = await loadRider(Number(req.params.riderId));
  if (!rider) return res.status(404).json({ error: "This rider couldn't be found. It may have been deleted. Refresh the page and try again." });
  if (!(await canManageRider(account, rider))) return res.status(403).json({ error: "This rider profile isn't on your account. Sign in with the account that owns it, or ask the owner to add you as a manager." });
  const rows = await db.select().from(riderProfileManagersTable).where(eq(riderProfileManagersTable.riderId, rider.id));
  return res.json({
    isOwner: ownsRider(account, rider),
    managers: rows.map(m => ({
      id: m.id, email: m.invitedEmail, joined: m.riderAccountId != null,
      isYou: m.riderAccountId === account.id || m.invitedEmail === account.email.trim().toLowerCase(),
      addedAt: m.createdAt.toISOString(),
    })),
  });
});

router.post("/rider/profiles/:riderId/managers", requireRiderAuth, async (req, res) => {
  const account = await currentAccount(req);
  if (!account) return res.status(401).json({ error: "You're signed out. Sign in again, then try once more." });
  const rider = await loadRider(Number(req.params.riderId));
  if (!rider) return res.status(404).json({ error: "This rider couldn't be found. It may have been deleted. Refresh the page and try again." });
  if (!ownsRider(account, rider)) return res.status(403).json({ error: "Only the profile owner can add managers" });
  const email = String(req.body?.email ?? "").trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ error: "Enter a valid email address" });
  if (email === account.email.trim().toLowerCase()) return res.status(400).json({ error: "You already manage this profile" });
  const existing = await db.select({ id: riderProfileManagersTable.id }).from(riderProfileManagersTable)
    .where(and(eq(riderProfileManagersTable.riderId, rider.id), eq(riderProfileManagersTable.invitedEmail, email)));
  if (existing.length) return res.status(409).json({ error: "That person is already a manager" });
  const [invitee] = await db.select({ id: riderAccountsTable.id }).from(riderAccountsTable).where(eq(riderAccountsTable.email, email));
  const [row] = await db.insert(riderProfileManagersTable)
    .values({ riderId: rider.id, invitedEmail: email, riderAccountId: invitee?.id ?? null, invitedByAccountId: account.id })
    .returning();
  return res.status(201).json({ id: row.id, email: row.invitedEmail, joined: row.riderAccountId != null });
});

router.delete("/rider/profiles/:riderId/managers/:managerId", requireRiderAuth, async (req, res) => {
  const account = await currentAccount(req);
  if (!account) return res.status(401).json({ error: "You're signed out. Sign in again, then try once more." });
  const rider = await loadRider(Number(req.params.riderId));
  if (!rider) return res.status(404).json({ error: "This rider couldn't be found. It may have been deleted. Refresh the page and try again." });
  const [row] = await db.select().from(riderProfileManagersTable)
    .where(and(eq(riderProfileManagersTable.id, Number(req.params.managerId)), eq(riderProfileManagersTable.riderId, rider.id)));
  if (!row) return res.status(404).json({ error: "This manager couldn't be found. It may have been deleted. Refresh the page and try again." });
  const isSelf = row.riderAccountId === account.id || row.invitedEmail === account.email.trim().toLowerCase();
  if (!ownsRider(account, rider) && !isSelf) return res.status(403).json({ error: "This rider profile isn't on your account. Sign in with the account that owns it, or ask the owner to add you as a manager." });
  await db.delete(riderProfileManagersTable).where(eq(riderProfileManagersTable.id, row.id));
  return res.json({ ok: true });
});

// ── #5 Following ────────────────────────────────────────────────────────────
router.get("/rider/riders/search", requireRiderAuth, async (req, res) => {
  const account = await currentAccount(req);
  if (!account) return res.status(401).json({ error: "You're signed out. Sign in again, then try once more." });
  const q = String(req.query.q ?? "").trim();
  if (q.length < 2) return res.json({ riders: [] });
  const riders = await searchPublicRiders(q.slice(0, 60));
  const followed = riders.length
    ? new Set((await db.select({ riderId: riderFollowsTable.riderId }).from(riderFollowsTable)
        .where(and(eq(riderFollowsTable.riderAccountId, account.id), inArray(riderFollowsTable.riderId, riders.map(r => r.id))))).map(f => f.riderId))
    : new Set<number>();
  return res.json({ riders: riders.map(r => ({ ...r, following: followed.has(r.id) })) });
});

/**
 * Racer profile: results of finished races (unofficial until finalized), a résumé
 * built from them, and the rider's profile details. Bio and home state show only
 * on public profiles or to the rider's own managers; under-18 riders are private
 * by default (lib/riderResume.ts effectiveVisibility).
 */
router.get("/rider/riders/:riderId/public", requireRiderAuth, async (req, res) => {
  const account = await currentAccount(req);
  if (!account) return res.status(401).json({ error: "You're signed out. Sign in again, then try once more." });
  const riderId = Number(req.params.riderId);
  if (!Number.isInteger(riderId) || riderId <= 0) return res.status(404).json({ error: "This rider couldn't be found. It may have been deleted. Refresh the page and try again." });
  const [rider] = await db.select({
    id: ridersTable.id, email: ridersTable.email, firstName: ridersTable.firstName, lastName: ridersTable.lastName,
    bibNumber: ridersTable.bibNumber, homeState: ridersTable.homeState, dateOfBirth: ridersTable.dateOfBirth,
    bio: ridersTable.bio, plateColor: ridersTable.plateColor, profileVisibility: ridersTable.profileVisibility,
  }).from(ridersTable).where(eq(ridersTable.id, riderId));
  if (!rider) return res.status(404).json({ error: "This rider couldn't be found. It may have been deleted. Refresh the page and try again." });
  const [{ stats, resume }, recent, follow, [followers], isManager] = await Promise.all([
    loadRacerResume(rider.id, true),
    loadResultsFeed([rider.id], 10),
    db.select({ id: riderFollowsTable.id }).from(riderFollowsTable)
      .where(and(eq(riderFollowsTable.riderAccountId, account.id), eq(riderFollowsTable.riderId, rider.id))),
    db.select({ n: count() }).from(riderFollowsTable).where(eq(riderFollowsTable.riderId, rider.id)),
    canManageRider(account, rider),
  ]);
  if (stats.starts === 0 && recent.length === 0 && !isManager) {
    return res.status(404).json({ error: "This rider couldn't be found. It may have been deleted. Refresh the page and try again." });
  }
  const visibility = effectiveVisibility(rider, new Date().toISOString().slice(0, 10));
  const showPersonal = visibility === "public" || isManager;
  return res.json({
    riderId: rider.id,
    name: `${rider.firstName} ${rider.lastName}`.trim(),
    following: follow.length > 0,
    followerCount: Number(followers?.n ?? 0),
    stats,
    recent,
    resume,
    profile: {
      number: rider.bibNumber ?? null,
      plateColor: rider.plateColor ?? null,
      state: showPersonal ? rider.homeState ?? null : null,
      bio: showPersonal ? rider.bio ?? null : null,
    },
    visibility,
    isManager,
  });
});

router.get("/rider/follows", requireRiderAuth, async (req, res) => {
  const account = await currentAccount(req);
  if (!account) return res.status(401).json({ error: "You're signed out. Sign in again, then try once more." });
  const rows = await db.select({ riderId: riderFollowsTable.riderId, firstName: ridersTable.firstName, lastName: ridersTable.lastName, since: riderFollowsTable.createdAt })
    .from(riderFollowsTable).innerJoin(ridersTable, eq(ridersTable.id, riderFollowsTable.riderId))
    .where(eq(riderFollowsTable.riderAccountId, account.id));
  return res.json({ following: rows.map(r => ({ riderId: r.riderId, name: `${r.firstName} ${r.lastName}`.trim(), since: r.since.toISOString() })) });
});

router.post("/rider/follows/:riderId", requireRiderAuth, async (req, res) => {
  const account = await currentAccount(req);
  if (!account) return res.status(401).json({ error: "You're signed out. Sign in again, then try once more." });
  const rider = await loadRider(Number(req.params.riderId));
  if (!rider) return res.status(404).json({ error: "This rider couldn't be found. It may have been deleted. Refresh the page and try again." });
  await db.insert(riderFollowsTable).values({ riderAccountId: account.id, riderId: rider.id }).onConflictDoNothing();
  return res.status(201).json({ ok: true, following: true });
});

router.delete("/rider/follows/:riderId", requireRiderAuth, async (req, res) => {
  const account = await currentAccount(req);
  if (!account) return res.status(401).json({ error: "You're signed out. Sign in again, then try once more." });
  await db.delete(riderFollowsTable)
    .where(and(eq(riderFollowsTable.riderAccountId, account.id), eq(riderFollowsTable.riderId, Number(req.params.riderId))));
  return res.json({ ok: true, following: false });
});

/** Home feed: finished-race results for followed riders and your own/managed profiles. */
router.get("/rider/feed", requireRiderAuth, async (req, res) => {
  const account = await currentAccount(req);
  if (!account) return res.status(401).json({ error: "You're signed out. Sign in again, then try once more." });
  const mine = await managedRiderIds(account);
  const followed = (await db.select({ riderId: riderFollowsTable.riderId }).from(riderFollowsTable)
    .where(eq(riderFollowsTable.riderAccountId, account.id))).map(f => f.riderId);
  const items = await loadResultsFeed([...new Set([...mine, ...followed])], 30);
  const mineSet = new Set(mine);
  return res.json({ items: items.map(i => ({ ...i, isMine: mineSet.has(i.riderId) })) });
});

export default router;
