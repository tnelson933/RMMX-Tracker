// "<Rider> is racing live" pushes: when a rider goes live from the rider app,
// everyone following that rider (with race alerts on for them) gets a push that
// opens the stream. The rider's own accounts aren't alerted. A rider whose phone
// drops and comes back within the relay's grace period is the same stream; one
// that stops and starts again soon after doesn't alert twice (ALERT_GAP_MS).

import { db, ridersTable, riderFollowsTable, riderPushTokensTable } from "@workspace/db";
import { and, eq, inArray } from "drizzle-orm";
import { logger } from "./logger";
import { sendPushNotifications } from "./push";
import { accountIdsForRiders } from "./riderAccess";
import { followsThatCount } from "./followVisibility";
import { getLiveRiderIds, onCameraStarted, riderLiveStatus, stopRiderStream } from "./videoRelay";
import { loadGoLiveWindow } from "./riderRace";

export const RACE_ENDED_MESSAGE = "The race has ended. Live video is over for now.";
const WINDOW_CHECK_MS = 30_000;

/** Stops any rider stream whose window has closed (race finalized 5+ minutes ago, or no race soon). */
export async function enforceRiderLiveWindows(): Promise<number[]> {
  const stopped: number[] = [];
  for (const riderId of getLiveRiderIds()) {
    try {
      const w = await loadGoLiveWindow(riderId);
      if (!w.allowed && stopRiderStream(riderId, RACE_ENDED_MESSAGE)) stopped.push(riderId);
    } catch (err) {
      logger.warn({ err, riderId }, "Rider live window check failed");
    }
  }
  if (stopped.length) logger.info({ riderIds: stopped }, "Stopped rider streams after their race ended");
  return stopped;
}

export const ALERT_GAP_MS = 20 * 60_000;
const lastAlertAt = new Map<number, number>();

/** Whether a new stream for this rider should alert followers now (and remember that it did). */
export function claimRiderLiveAlert(riderId: number, now = Date.now(), seen = lastAlertAt): boolean {
  const last = seen.get(riderId);
  if (last != null && now - last < ALERT_GAP_MS) return false;
  seen.set(riderId, now);
  return true;
}

export function riderLiveMessage(name: string) {
  const first = name.split(" ")[0] || name;
  return { title: `${name} is racing live`, body: `Watch ${first}'s live video now.` };
}

export async function alertFollowersRiderLive(riderId: number): Promise<number> {
  const [rider] = await db.select({ firstName: ridersTable.firstName, lastName: ridersTable.lastName })
    .from(ridersTable).where(eq(ridersTable.id, riderId));
  if (!rider) return 0;
  // Follows of a private profile alert nobody (its own accounts are skipped below anyway).
  const follows = await followsThatCount(await db.select({ accountId: riderFollowsTable.riderAccountId, riderId: riderFollowsTable.riderId }).from(riderFollowsTable)
    .where(and(eq(riderFollowsTable.riderId, riderId), eq(riderFollowsTable.raceAlerts, true))));
  const own = new Set(await accountIdsForRiders([riderId]));
  const accountIds = [...new Set(follows.map(f => f.accountId))].filter(id => !own.has(id));
  if (!accountIds.length) return 0;
  const tokens = await db.select({ token: riderPushTokensTable.expoPushToken }).from(riderPushTokensTable)
    .where(inArray(riderPushTokensTable.riderAccountId, accountIds));
  if (!tokens.length) return 0;
  const name = `${rider.firstName} ${rider.lastName}`.trim() || "A rider you follow";
  const msg = riderLiveMessage(name);
  const result = await sendPushNotifications([...new Set(tokens.map(t => t.token))].map(to => ({
    to, ...msg, data: { type: "rider-live", riderId },
  })));
  logger.info({ riderId, followers: accountIds.length, sent: result.accepted, failed: result.failed }, "Rider live follower alert");
  return result.accepted;
}

/** Hooks rider streams up to follower alerts and the race-day window. Called once at startup. */
export function startRiderLiveAlerts(): void {
  setInterval(() => { void enforceRiderLiveWindows(); }, WINDOW_CHECK_MS).unref?.();
  onCameraStarted((channel) => {
    if (channel >= 0) return; // an event camera
    const riderId = -channel;
    // Wait a few seconds: a phone that fails to start (no camera access) shouldn't alert anyone.
    setTimeout(() => {
      if (!riderLiveStatus(riderId).live || !claimRiderLiveAlert(riderId)) return;
      alertFollowersRiderLive(riderId).catch(err => logger.error({ err, riderId }, "Rider live follower alert failed"));
    }, 8_000);
  });
}
