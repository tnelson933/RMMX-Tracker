// Database wiring for "<Rider> is about to start their race" follower pushes.
// The rules (once per rider per moto, who gets it, the text) are in
// raceStartAlertsCore.ts.
//
// Trigger: when a race finishes, the next scheduled race is up next (the same
// moment the rider's own "You're up next!" push goes out, routes/motos.ts). When
// a race starts and its followers weren't alerted yet (first race of the day, a
// race run out of order), they're alerted then. Both fire from the cloud's
// own moto changes (organizer, race clock) and from desktop syncs
// (routes/desktop-sync.ts), which arrive every few seconds while the laptop is
// online. A laptop that is offline syncs later: anything older than
// RACE_ALERT_FRESH_MS is skipped instead of alerting for a race long gone.

import {
  db, motosTable, eventsTable, ridersTable, checkinsTable, registrationsTable,
  riderFollowsTable, riderPushTokensTable, riderNotificationPrefsTable, riderRaceStartNotificationsTable,
} from "@workspace/db";
import { and, eq, inArray, ne } from "drizzle-orm";
import { logger } from "./logger";
import { sendPushNotifications } from "./push";
import { accountIdsForRiders } from "./riderAccess";
import { followsThatCount } from "./followVisibility";
import { isEventLive } from "./videoRelay";
import {
  alertFollowersForMoto, isFresh, lineupRiderIds, nextUpMotoIds,
  type RaceStartDeps, type RaceStartMotoInfo, type RaceStartOutcome,
} from "./raceStartAlertsCore";

/** Riders in a race: its lineup, else the checked-in (or, without check-in, registered) riders of its classes. */
export async function motoEntrantIds(moto: typeof motosTable.$inferSelect): Promise<number[]> {
  const fromLineup = lineupRiderIds(moto.lineup);
  if (fromLineup.length) return fromLineup;
  const classes = (moto.raceClasses?.length ? moto.raceClasses : [moto.raceClass]).filter(Boolean);
  if (!classes.length) return [];
  const [anyCheckin] = await db.select({ id: checkinsTable.id }).from(checkinsTable)
    .where(and(eq(checkinsTable.eventId, moto.eventId), eq(checkinsTable.checkedIn, true))).limit(1);
  const rows = anyCheckin
    ? await db.select({ riderId: checkinsTable.riderId }).from(checkinsTable)
        .where(and(eq(checkinsTable.eventId, moto.eventId), eq(checkinsTable.checkedIn, true), inArray(checkinsTable.raceClass, classes)))
    : await db.select({ riderId: registrationsTable.riderId }).from(registrationsTable)
        .where(and(eq(registrationsTable.eventId, moto.eventId), ne(registrationsTable.status, "void"), inArray(registrationsTable.raceClass, classes)));
  return [...new Set(rows.map(r => r.riderId))];
}

export const dbRaceStartDeps: RaceStartDeps = {
  async loadMoto(motoId): Promise<RaceStartMotoInfo | null> {
    const [moto] = await db.select().from(motosTable).where(eq(motosTable.id, motoId));
    if (!moto) return null;
    const [event] = await db.select({ name: eventsTable.name, clubId: eventsTable.clubId })
      .from(eventsTable).where(eq(eventsTable.id, moto.eventId));
    const ids = await motoEntrantIds(moto);
    const riders = ids.length
      ? await db.select({ id: ridersTable.id, firstName: ridersTable.firstName, lastName: ridersTable.lastName })
          .from(ridersTable).where(inArray(ridersTable.id, ids))
      : [];
    return {
      motoId, eventId: moto.eventId, clubId: event?.clubId ?? null,
      motoName: moto.name, eventName: event?.name ?? "the race", type: moto.type, status: moto.status,
      entrants: riders.map(r => ({ riderId: r.id, name: `${r.firstName} ${r.lastName}`.trim() || "A rider you follow" })),
    };
  },
  async followers(riderIds) {
    if (!riderIds.length) return [];
    // Follows of private profiles alert nobody but the rider's own managers.
    return followsThatCount(await db.select({ accountId: riderFollowsTable.riderAccountId, riderId: riderFollowsTable.riderId })
      .from(riderFollowsTable)
      .where(and(inArray(riderFollowsTable.riderId, riderIds), eq(riderFollowsTable.raceAlerts, true))));
  },
  async ownAccounts(riderIds) {
    const map = new Map<number, number[]>();
    for (const id of riderIds) map.set(id, await accountIdsForRiders([id]));
    return map;
  },
  async clubOptOuts(clubId, accountIds) {
    if (!accountIds.length) return new Set();
    const rows = await db.select({ accountId: riderNotificationPrefsTable.riderAccountId })
      .from(riderNotificationPrefsTable)
      .where(and(eq(riderNotificationPrefsTable.clubId, clubId), eq(riderNotificationPrefsTable.enabled, false),
        inArray(riderNotificationPrefsTable.riderAccountId, accountIds)));
    return new Set(rows.map(r => r.accountId));
  },
  async tokens(accountIds) {
    if (!accountIds.length) return [];
    return db.select({ accountId: riderPushTokensTable.riderAccountId, token: riderPushTokensTable.expoPushToken })
      .from(riderPushTokensTable).where(inArray(riderPushTokensTable.riderAccountId, accountIds));
  },
  isStreaming: isEventLive,
  async claim(motoId, riderIds) {
    if (!riderIds.length) return [];
    const rows = await db.insert(riderRaceStartNotificationsTable)
      .values(riderIds.map(riderId => ({ motoId, riderId })))
      .onConflictDoNothing()
      .returning({ riderId: riderRaceStartNotificationsTable.riderId });
    return rows.map(r => r.riderId);
  },
  async release(motoId, riderIds) {
    if (!riderIds.length) return;
    await db.delete(riderRaceStartNotificationsTable)
      .where(and(eq(riderRaceStartNotificationsTable.motoId, motoId), inArray(riderRaceStartNotificationsTable.riderId, riderIds)));
  },
  send: sendPushNotifications,
};

/**
 * A race just finished: alert followers of the riders in the race that's up next.
 * `completedAt` guards against a late desktop sync of a race finished long ago.
 */
export async function alertFollowersUpNext(
  eventId: number, completedAt: Date | string | null = new Date(), deps: RaceStartDeps = dbRaceStartDeps,
): Promise<RaceStartOutcome[]> {
  const out: RaceStartOutcome[] = [];
  try {
    if (!isFresh(completedAt, Date.now())) return out;
    const scheduled = await db.select({
      id: motosTable.id, type: motosTable.type, status: motosTable.status, motoNumber: motosTable.motoNumber,
      staggeredWithMotoId: motosTable.staggeredWithMotoId, staggeredGroupId: motosTable.staggeredGroupId,
    }).from(motosTable).where(and(eq(motosTable.eventId, eventId), eq(motosTable.status, "scheduled")));
    for (const motoId of nextUpMotoIds(scheduled)) out.push(await alertFollowersForMoto(motoId, deps));
  } catch (err) {
    logger.error({ err, eventId }, "Race start follower alert (up next) failed");
  }
  return out;
}

/** A race just started: alert any followers who weren't alerted while it was up next. */
export async function alertFollowersMotoStarted(motoId: number, deps: RaceStartDeps = dbRaceStartDeps): Promise<RaceStartOutcome | null> {
  try {
    const [moto] = await db.select({ status: motosTable.status, startedAt: motosTable.startedAt })
      .from(motosTable).where(eq(motosTable.id, motoId));
    if (!moto || moto.status !== "in_progress" || !isFresh(moto.startedAt, Date.now())) return null;
    return await alertFollowersForMoto(motoId, deps);
  } catch (err) {
    logger.error({ err, motoId }, "Race start follower alert (started) failed");
    return null;
  }
}
