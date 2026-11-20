import { Router } from "express";
import { db, riderAccountsTable, riderFollowsTable, ridersTable } from "@workspace/db";
import { eq, inArray } from "drizzle-orm";
import { requireRiderAuth } from "./rider-portal";
import { managedRiderIds } from "../lib/riderAccess";
import { loadCommonCompetitors, loadResultsFeed, loadRidersNear, loadTopRiders } from "../lib/riderCareer";
import { buildRacerProfile, loadProfileRider, publicRiderCards } from "../lib/racerProfileView";
import { filterHistory, historyFilterOptions, pickSuggestions } from "../lib/riderProfilePlus";

/**
 * Racer profile extras: the public share page, a short rider card for live
 * timing, the full results history with filters, and who to follow.
 * `/public/...` routes need no sign-in and only ever show public profiles'
 * personal details; `/rider/...` routes need a rider sign-in.
 */
const router = Router();

const NOT_FOUND = "This rider couldn't be found. It may have been deleted. Refresh the page and try again.";
const SIGNED_OUT = "You're signed out. Sign in again, then try once more.";
const HISTORY_LIMIT = 400;

async function currentAccount(req: any) {
  const id = (req.session as any).riderAccountId as number | undefined;
  if (!id) return null;
  const [account] = await db.select({ id: riderAccountsTable.id, email: riderAccountsTable.email })
    .from(riderAccountsTable).where(eq(riderAccountsTable.id, id));
  return account ?? null;
}

const text = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim().slice(0, 120) : null);

/** A rider's whole results history (finished races), newest first, with the filters it can take. */
async function historyFor(riderId: number, query: Record<string, unknown>) {
  const all = await loadResultsFeed([riderId], HISTORY_LIMIT);
  const filter = { year: text(query.year), raceClass: text(query.class), track: text(query.track) };
  return { filters: historyFilterOptions(all), total: all.length, items: filterHistory(all, filter) };
}

// ── Public (no sign-in): the share page ──────────────────────────────────────

/** The profile anyone with the link can see. Private profiles (under-18 by default) have no public page. */
router.get("/public/riders/:riderId", async (req, res) => {
  const rider = await loadProfileRider(Number(req.params.riderId));
  if (!rider) return res.status(404).json({ error: NOT_FOUND });
  const profile = await buildRacerProfile(rider, false);
  if (!profile || profile.visibility !== "public") return res.status(404).json({ error: "This profile is private or has no results yet." });
  return res.json({ ...profile, following: false });
});

router.get("/public/riders/:riderId/history", async (req, res) => {
  const rider = await loadProfileRider(Number(req.params.riderId));
  if (!rider) return res.status(404).json({ error: NOT_FOUND });
  const profile = await buildRacerProfile(rider, false);
  if (!profile || profile.visibility !== "public") return res.status(404).json({ error: "This profile is private or has no results yet." });
  return res.json(await historyFor(rider.id, req.query as Record<string, unknown>));
});

/**
 * Who is this rider? A short card for live timing and results: name, number,
 * main class, career numbers and series standing (all from public results),
 * plus home state, bike and photo when the profile is public.
 */
router.get("/public/riders/:riderId/card", async (req, res) => {
  const rider = await loadProfileRider(Number(req.params.riderId));
  if (!rider) return res.status(404).json({ error: NOT_FOUND });
  const profile = await buildRacerProfile(rider, false);
  if (!profile) return res.status(404).json({ error: NOT_FOUND });
  return res.json({
    riderId: profile.riderId,
    name: profile.name,
    number: profile.profile.number,
    plateColor: profile.profile.plateColor,
    avatarUrl: profile.profile.avatarUrl,
    state: profile.profile.state,
    bike: profile.profile.bike,
    mainClass: profile.resume.classes[0] ?? null,
    firstYear: profile.resume.firstYear,
    starts: profile.stats.starts,
    wins: profile.stats.wins,
    podiums: profile.stats.podiums,
    avgFinish: profile.stats.avgFinish,
    series: profile.series.slice(0, 2),
    visibility: profile.visibility,
    sharePath: profile.sharePath,
  });
});

// ── Signed-in riders ─────────────────────────────────────────────────────────

/** Full results history with filters (?year=2026&class=250%20A&track=...). Results are public; so is this. */
router.get("/rider/riders/:riderId/history", requireRiderAuth, async (req, res) => {
  const account = await currentAccount(req);
  if (!account) return res.status(401).json({ error: SIGNED_OUT });
  const rider = await loadProfileRider(Number(req.params.riderId));
  if (!rider) return res.status(404).json({ error: NOT_FOUND });
  return res.json(await historyFor(rider.id, req.query as Record<string, unknown>));
});

/**
 * Riders to follow: the ones your riders race against most, riders from your
 * home state, and the riders winning the most lately. Only public profiles;
 * never your own riders or ones you already follow; each rider listed once.
 */
router.get("/rider/riders/suggested", requireRiderAuth, async (req, res) => {
  const account = await currentAccount(req);
  if (!account) return res.status(401).json({ error: SIGNED_OUT });
  const mine = await managedRiderIds(account);
  const followed = (await db.select({ riderId: riderFollowsTable.riderId }).from(riderFollowsTable)
    .where(eq(riderFollowsTable.riderAccountId, account.id))).map(f => f.riderId);
  const homeStates = mine.length
    ? (await db.select({ state: ridersTable.homeState }).from(ridersTable).where(inArray(ridersTable.id, mine))).map(r => r.state ?? "")
    : [];
  const [competitors, nearby, top] = await Promise.all([loadCommonCompetitors(mine), loadRidersNear(homeStates), loadTopRiders()]);

  // Private profiles aren't suggested: check before picking, so a list isn't left short.
  const cards = await publicRiderCards([...new Set([...competitors, ...nearby, ...top].map(c => c.riderId))]);
  const exclude = new Set<number>([...mine, ...followed]);
  const section = (candidates: Array<{ riderId: number; weight: number }>, reason: (weight: number) => string) => {
    const weights = new Map(candidates.map(c => [c.riderId, c.weight]));
    const ids = pickSuggestions(candidates.filter(c => cards.has(c.riderId)), exclude, 8);
    for (const id of ids) exclude.add(id);
    return ids.map(id => ({ ...cards.get(id)!, reason: reason(weights.get(id) ?? 0) }));
  };
  return res.json({
    competitors: section(competitors, n => `Raced your riders ${n} ${n === 1 ? "time" : "times"}`),
    nearby: section(nearby, () => "From your state"),
    top: section(top, n => `${n} ${n === 1 ? "win" : "wins"} in the last year`),
  });
});

export default router;
