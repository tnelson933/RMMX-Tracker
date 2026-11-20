import { Router } from "express";
import { db, riderAccountsTable, ridersTable, riderFollowsTable } from "@workspace/db";
import { and, eq } from "drizzle-orm";
import { requireRiderAuth } from "./rider-portal";
import { canManageRider } from "../lib/riderAccess";
import { effectiveVisibility } from "../lib/riderResume";
import { createRiderBroadcastTicket, createRiderWatchTicket, riderLiveStatus, riderChannel, RIDER_CAMERA, verifyBroadcastTicket } from "../lib/videoRelay";
import { loadRiderRace, type RiderRaceInfo } from "../lib/riderRace";
import { buildLeaderboard } from "./timing";

/**
 * Rider live video: a rider (or a parent managing the profile) goes live from
 * the rider app's Go Live button; followers get a push (lib/riderLiveAlerts.ts)
 * and can watch from the rider's profile. Rider streams are kept out of every
 * public "Live now" list. Watching follows the profile's privacy: public
 * profiles, the rider's own accounts, and the rider's followers.
 */
const router = Router();

async function currentAccount(req: any) {
  const id = (req.session as any).riderAccountId as number | undefined;
  if (!id) return null;
  const [account] = await db.select({ id: riderAccountsTable.id, email: riderAccountsTable.email })
    .from(riderAccountsTable).where(eq(riderAccountsTable.id, id));
  return account ?? null;
}

async function loadRider(raw: unknown) {
  const riderId = Number(raw);
  if (!Number.isInteger(riderId) || riderId <= 0) return null;
  const [rider] = await db.select({
    id: ridersTable.id, email: ridersTable.email, firstName: ridersTable.firstName, lastName: ridersTable.lastName,
    dateOfBirth: ridersTable.dateOfBirth, profileVisibility: ridersTable.profileVisibility,
  }).from(ridersTable).where(eq(ridersTable.id, riderId));
  return rider ?? null;
}

const NOT_FOUND = "This rider couldn't be found. It may have been deleted. Refresh the page and try again.";
const SIGNED_OUT = "You're signed out. Sign in again, then try once more.";

// POST /rider/live/start { riderId }: a ticket to stream from this phone as the rider.
router.post("/rider/live/start", requireRiderAuth, async (req, res) => {
  const account = await currentAccount(req);
  if (!account) return res.status(401).json({ error: SIGNED_OUT });
  const rider = await loadRider(req.body?.riderId);
  if (!rider) return res.status(404).json({ error: NOT_FOUND });
  if (!(await canManageRider(account, rider))) {
    return res.status(403).json({ error: "You can only go live as a rider on your own account." });
  }
  return res.json({
    riderId: rider.id,
    name: `${rider.firstName} ${rider.lastName}`.trim(),
    ticket: createRiderBroadcastTicket(rider.id),
    status: riderLiveStatus(rider.id),
  });
});

// GET /rider/live/:riderId: is the rider live now, and a ticket to watch if this account may.
router.get("/rider/live/:riderId", requireRiderAuth, async (req, res) => {
  const account = await currentAccount(req);
  if (!account) return res.status(401).json({ error: SIGNED_OUT });
  const rider = await loadRider(req.params.riderId);
  if (!rider) return res.status(404).json({ error: NOT_FOUND });
  const status = riderLiveStatus(rider.id);
  let canWatch = effectiveVisibility(rider, new Date().toISOString().slice(0, 10)) === "public";
  if (!canWatch) {
    const [follow] = await db.select({ id: riderFollowsTable.id }).from(riderFollowsTable)
      .where(and(eq(riderFollowsTable.riderId, rider.id), eq(riderFollowsTable.riderAccountId, account.id)));
    canWatch = !!follow || await canManageRider(account, rider);
  }
  return res.json({
    riderId: rider.id,
    name: `${rider.firstName} ${rider.lastName}`.trim(),
    ...status,
    canWatch,
    watchTicket: canWatch ? createRiderWatchTicket(rider.id) : null,
  });
});

// GET /rider/live/:riderId/race?ticket=…: the rider's class, race and place for
// the overlay on their live video. Takes the stream's own watch or broadcast
// ticket (the in-app pages have no website sign-in). Cached briefly per rider,
// since every viewer polls it.
const raceCache = new Map<number, { at: number; data: RiderRaceInfo | null }>();
const RACE_CACHE_MS = 3_000;

router.get("/rider/live/:riderId/race", async (req, res) => {
  const riderId = Number(req.params.riderId);
  const ticket = String(req.query.ticket ?? "");
  if (!Number.isInteger(riderId) || riderId <= 0) return res.status(404).json({ error: NOT_FOUND });
  const channel = riderChannel(riderId);
  if (!verifyBroadcastTicket(ticket, channel, "watch") && !verifyBroadcastTicket(ticket, channel, RIDER_CAMERA)) {
    return res.status(401).json({ error: "This live video link has expired. Open it again from the rider's profile." });
  }
  const cached = raceCache.get(riderId);
  if (cached && Date.now() - cached.at < RACE_CACHE_MS) return res.json({ race: cached.data });
  const data = await loadRiderRace(riderId, buildLeaderboard);
  raceCache.set(riderId, { at: Date.now(), data });
  if (raceCache.size > 500) raceCache.delete(raceCache.keys().next().value!);
  return res.json({ race: data });
});

export default router;
