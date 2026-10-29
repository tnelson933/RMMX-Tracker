import { Router } from "express";
import { db, riderAccountsTable, ridersTable, riderFollowsTable, riderProfileManagersTable } from "@workspace/db";
import { and, eq, inArray } from "drizzle-orm";
import { requireRiderAuth } from "./rider-portal";
import { canManageRider, managedRiderIds, ownsRider } from "../lib/riderAccess";
import { loadCareerStats, loadResultsFeed, searchPublicRiders } from "../lib/riderCareer";

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

// ── #4 Career stats (own and managed profiles: all results) ─────────────────
router.get("/rider/profiles/:riderId/stats", requireRiderAuth, async (req, res) => {
  const account = await currentAccount(req);
  if (!account) return res.status(401).json({ error: "Not authenticated" });
  const rider = await loadRider(Number(req.params.riderId));
  if (!rider) return res.status(404).json({ error: "Rider not found" });
  if (!(await canManageRider(account, rider))) return res.status(403).json({ error: "Access denied" });
  return res.json({ riderId: rider.id, name: `${rider.firstName} ${rider.lastName}`.trim(), stats: await loadCareerStats(rider.id, false) });
});

// ── #6 Profile managers ─────────────────────────────────────────────────────
router.get("/rider/profiles/:riderId/managers", requireRiderAuth, async (req, res) => {
  const account = await currentAccount(req);
  if (!account) return res.status(401).json({ error: "Not authenticated" });
  const rider = await loadRider(Number(req.params.riderId));
  if (!rider) return res.status(404).json({ error: "Rider not found" });
  if (!(await canManageRider(account, rider))) return res.status(403).json({ error: "Access denied" });
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
  if (!account) return res.status(401).json({ error: "Not authenticated" });
  const rider = await loadRider(Number(req.params.riderId));
  if (!rider) return res.status(404).json({ error: "Rider not found" });
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
  if (!account) return res.status(401).json({ error: "Not authenticated" });
  const rider = await loadRider(Number(req.params.riderId));
  if (!rider) return res.status(404).json({ error: "Rider not found" });
  const [row] = await db.select().from(riderProfileManagersTable)
    .where(and(eq(riderProfileManagersTable.id, Number(req.params.managerId)), eq(riderProfileManagersTable.riderId, rider.id)));
  if (!row) return res.status(404).json({ error: "Manager not found" });
  const isSelf = row.riderAccountId === account.id || row.invitedEmail === account.email.trim().toLowerCase();
  if (!ownsRider(account, rider) && !isSelf) return res.status(403).json({ error: "Access denied" });
  await db.delete(riderProfileManagersTable).where(eq(riderProfileManagersTable.id, row.id));
  return res.json({ ok: true });
});

// ── #5 Following ────────────────────────────────────────────────────────────
router.get("/rider/riders/search", requireRiderAuth, async (req, res) => {
  const account = await currentAccount(req);
  if (!account) return res.status(401).json({ error: "Not authenticated" });
  const q = String(req.query.q ?? "").trim();
  if (q.length < 2) return res.json({ riders: [] });
  const riders = await searchPublicRiders(q.slice(0, 60));
  const followed = riders.length
    ? new Set((await db.select({ riderId: riderFollowsTable.riderId }).from(riderFollowsTable)
        .where(and(eq(riderFollowsTable.riderAccountId, account.id), inArray(riderFollowsTable.riderId, riders.map(r => r.id))))).map(f => f.riderId))
    : new Set<number>();
  return res.json({ riders: riders.map(r => ({ ...r, following: followed.has(r.id) })) });
});

/** Public view of any rider: results of finished races (unofficial until finalized). */
router.get("/rider/riders/:riderId/public", requireRiderAuth, async (req, res) => {
  const account = await currentAccount(req);
  if (!account) return res.status(401).json({ error: "Not authenticated" });
  const rider = await loadRider(Number(req.params.riderId));
  if (!rider) return res.status(404).json({ error: "Rider not found" });
  const [stats, recent, follow] = await Promise.all([
    loadCareerStats(rider.id, true),
    loadResultsFeed([rider.id], 10),
    db.select({ id: riderFollowsTable.id }).from(riderFollowsTable)
      .where(and(eq(riderFollowsTable.riderAccountId, account.id), eq(riderFollowsTable.riderId, rider.id))),
  ]);
  if (stats.starts === 0 && recent.length === 0 && !(await canManageRider(account, rider))) {
    return res.status(404).json({ error: "Rider not found" });
  }
  return res.json({ riderId: rider.id, name: `${rider.firstName} ${rider.lastName}`.trim(), following: follow.length > 0, stats, recent });
});

router.get("/rider/follows", requireRiderAuth, async (req, res) => {
  const account = await currentAccount(req);
  if (!account) return res.status(401).json({ error: "Not authenticated" });
  const rows = await db.select({ riderId: riderFollowsTable.riderId, firstName: ridersTable.firstName, lastName: ridersTable.lastName, since: riderFollowsTable.createdAt })
    .from(riderFollowsTable).innerJoin(ridersTable, eq(ridersTable.id, riderFollowsTable.riderId))
    .where(eq(riderFollowsTable.riderAccountId, account.id));
  return res.json({ following: rows.map(r => ({ riderId: r.riderId, name: `${r.firstName} ${r.lastName}`.trim(), since: r.since.toISOString() })) });
});

router.post("/rider/follows/:riderId", requireRiderAuth, async (req, res) => {
  const account = await currentAccount(req);
  if (!account) return res.status(401).json({ error: "Not authenticated" });
  const rider = await loadRider(Number(req.params.riderId));
  if (!rider) return res.status(404).json({ error: "Rider not found" });
  await db.insert(riderFollowsTable).values({ riderAccountId: account.id, riderId: rider.id }).onConflictDoNothing();
  return res.status(201).json({ ok: true, following: true });
});

router.delete("/rider/follows/:riderId", requireRiderAuth, async (req, res) => {
  const account = await currentAccount(req);
  if (!account) return res.status(401).json({ error: "Not authenticated" });
  await db.delete(riderFollowsTable)
    .where(and(eq(riderFollowsTable.riderAccountId, account.id), eq(riderFollowsTable.riderId, Number(req.params.riderId))));
  return res.json({ ok: true, following: false });
});

/** Home feed: finished-race results for followed riders and your own/managed profiles. */
router.get("/rider/feed", requireRiderAuth, async (req, res) => {
  const account = await currentAccount(req);
  if (!account) return res.status(401).json({ error: "Not authenticated" });
  const mine = await managedRiderIds(account);
  const followed = (await db.select({ riderId: riderFollowsTable.riderId }).from(riderFollowsTable)
    .where(eq(riderFollowsTable.riderAccountId, account.id))).map(f => f.riderId);
  const items = await loadResultsFeed([...new Set([...mine, ...followed])], 30);
  const mineSet = new Set(mine);
  return res.json({ items: items.map(i => ({ ...i, isMine: mineSet.has(i.riderId) })) });
});

export default router;
