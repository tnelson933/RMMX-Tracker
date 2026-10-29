import { eventToday, eventTimeZone, todayInZone, hourInZone } from "@workspace/api-zod";
import {
  db,
  eventsTable,
  registrationsTable,
  ridersTable,
  riderPushTokensTable,
  rfidAssignmentsTable,
  checkinsTable,
  liabilityWaiverSignaturesTable,
  riderNotificationPrefsTable,
  quickCheckinNotificationsTable,
} from "@workspace/db";
import { and, eq, inArray, ne, sql } from "drizzle-orm";
import { logger } from "./logger";
import { sendPushNotifications, type PushMessage } from "./push";
import { accountIdsForRiders } from "./riderAccess";
import { quickCheckinIneligibleReason, quickCheckinRequirements } from "./quickCheckinRequirements";

// Race-day morning push for quick check-in.
//
// Every poll cycle, for events whose local time (at the track) is between
// SEND_HOUR and SEND_HOUR_END, find events with
// quick check-in enabled whose (start) date is today, and send ONE push per
// eligible rider account that hasn't been notified for that event yet
// (deduped durably via the quick_checkin_notifications table).
//
// This complements the local arrival alert in the rider app (fires when the
// app is foregrounded within 1 mile of the track) — the morning push works
// even when the app is closed.

const POLL_INTERVAL_MS = 5 * 60 * 1000;
const SEND_HOUR = 7; // don't push before 7:00 AM at the track
const SEND_HOUR_END = 18; // don't start pushing after 6:00 PM (race is winding down)

export async function runQuickCheckinNotifierOnce(): Promise<void> {
  // Candidate dates span every US zone; each event's own local date and hour decide below.
  const now = new Date();
  const candidateDates = [-1, 0, 1].map(d => new Date(now.getTime() + d * 86_400_000).toISOString().substring(0, 10));

  // Events with quick check-in enabled starting today. Status may lag behind
  // (registration still "open" on race morning), so filter on date + flag, not status.
  const events = await db
    .select({
      id: eventsTable.id,
      name: eventsTable.name,
      clubId: eventsTable.clubId,
      trackName: eventsTable.trackName,
      timingTechnology: eventsTable.timingTechnology,
      requireWaiver: eventsTable.requireWaiver,
      requireLiabilityWaiver: eventsTable.requireLiabilityWaiver,
      requireTransponder: eventsTable.requireTransponder,
      quickCheckinRequirements: eventsTable.quickCheckinRequirements,
      date: eventsTable.date,
      state: eventsTable.state,
      trackLat: eventsTable.trackLat,
      trackLng: eventsTable.trackLng,
    })
    .from(eventsTable)
    .where(
      and(
        eq(eventsTable.quickCheckinEnabled, true),
        inArray(sql<string>`SUBSTRING(${eventsTable.date}::text, 1, 10)`, candidateDates),
        ne(eventsTable.status, "completed"),
      ),
    );

  for (const event of events) {
    const zone = eventTimeZone(event);
    if (String(event.date).substring(0, 10) !== todayInZone(zone, now)) continue;
    const hour = hourInZone(zone, now);
    if (hour < SEND_HOUR || hour >= SEND_HOUR_END) continue;
    try {
      await notifyForEvent(event);
    } catch (err) {
      logger.error({ err, eventId: event.id }, "Quick check-in morning push failed for event");
    }
  }
}

type EventRow = {
  id: number;
  name: string;
  clubId: number | null;
  trackName: string | null;
  timingTechnology: string | null;
  requireWaiver: boolean | null;
  requireLiabilityWaiver: boolean | null;
  requireTransponder: boolean | null;
  quickCheckinRequirements: unknown;
};

async function notifyForEvent(event: EventRow): Promise<void> {
  const requirements = quickCheckinRequirements(event.quickCheckinRequirements);
  // Registrations (class entries): paid ones, unless the event doesn't require payment
  const regs = await db
    .select({
      registrationId: registrationsTable.id,
      riderId: registrationsTable.riderId,
      raceClass: registrationsTable.raceClass,
      myLapsTransponderNumber: registrationsTable.myLapsTransponderNumber,
      waiverAcknowledgedAt: registrationsTable.waiverAcknowledgedAt,
      status: registrationsTable.status,
      transponderRental: registrationsTable.transponderRental,
      rmTrackrPurchased: registrationsTable.rmTrackrPurchased,
      rmTrackrFulfilledAt: registrationsTable.rmTrackrFulfilledAt,
      rfidStickerPurchased: registrationsTable.rfidStickerPurchased,
      riderTransponder: ridersTable.mylapsTransponderId,
    })
    .from(registrationsTable)
    .innerJoin(ridersTable, eq(registrationsTable.riderId, ridersTable.id))
    .where(
      and(
        eq(registrationsTable.eventId, event.id),
        // unpaid registrations check in at the gate when payment is required
        requirements.paid ? eq(registrationsTable.status, "confirmed") : ne(registrationsTable.status, "void"),
      ),
    );
  if (regs.length === 0) return;

  const riderIds = [...new Set(regs.map(r => r.riderId))];

  // Already checked-in riders (keyed per event+rider+class, matching the route)
  const checkins = await db
    .select({ riderId: checkinsTable.riderId, raceClass: checkinsTable.raceClass })
    .from(checkinsTable)
    .where(and(eq(checkinsTable.eventId, event.id), eq(checkinsTable.checkedIn, true)));
  const checkedInSet = new Set(checkins.map(c => `${c.riderId}:${c.raceClass ?? "Unknown"}`));

  // RFID assignments (only needed for RFID events)
  const rfidSet = new Set<number>();
  if (event.timingTechnology === "rfid") {
    const rfidRows = await db
      .select({ riderId: rfidAssignmentsTable.riderId })
      .from(rfidAssignmentsTable)
      .where(and(eq(rfidAssignmentsTable.eventId, event.id), inArray(rfidAssignmentsTable.riderId, riderIds)));
    for (const r of rfidRows) rfidSet.add(r.riderId);
  }

  // Waiver signatures (only needed when the event requires the full waiver)
  // A signature counts for a rider when it's linked to any of their registrations
  // for the event (same rule as the check-in route).
  const waiverRiderIds = new Set<number>();
  if (event.requireLiabilityWaiver) {
    const waiverRows = await db
      .select({ registrationId: liabilityWaiverSignaturesTable.registrationId })
      .from(liabilityWaiverSignaturesTable)
      .where(eq(liabilityWaiverSignaturesTable.eventId, event.id));
    const signedRegIds = new Set(waiverRows.map(w => w.registrationId).filter((id): id is number => id != null));
    for (const r of regs) if (signedRegIds.has(r.registrationId)) waiverRiderIds.add(r.riderId);
  }

  // Riders with at least one eligible, unchecked-in registration (entries are per class)
  const eligibleRiderIds = new Set<number>();
  for (const r of regs) {
    if (checkedInSet.has(`${r.riderId}:${r.raceClass ?? "Unknown"}`)) continue;
    const hasRfid = rfidSet.has(r.riderId);
    const reason = quickCheckinIneligibleReason(requirements, {
      registrationConfirmed: r.status === "confirmed",
      timingTechnology: event.timingTechnology,
      hasRfid,
      hasTransponder: !!r.myLapsTransponderNumber || !!r.riderTransponder,
      waiverRequired: !!(event.requireWaiver || event.requireLiabilityWaiver),
      waiverSigned: event.requireLiabilityWaiver ? waiverRiderIds.has(r.riderId) : !!r.waiverAcknowledgedAt,
      needsPickup: (!!r.transponderRental && !r.myLapsTransponderNumber?.trim())
        || (!!r.rmTrackrPurchased && !r.rmTrackrFulfilledAt)
        || (!!r.rfidStickerPurchased && !hasRfid),
    });
    if (reason) continue;
    eligibleRiderIds.add(r.riderId);
  }
  if (eligibleRiderIds.size === 0) return;

  // Owner accounts and invited profile managers of those riders
  let accountIds = await accountIdsForRiders([...eligibleRiderIds]);
  if (accountIds.length === 0) return;

  // Respect club-level notification opt-outs
  if (event.clubId != null) {
    const optOuts = await db
      .select({ riderAccountId: riderNotificationPrefsTable.riderAccountId })
      .from(riderNotificationPrefsTable)
      .where(
        and(
          eq(riderNotificationPrefsTable.clubId, event.clubId),
          eq(riderNotificationPrefsTable.enabled, false),
          inArray(riderNotificationPrefsTable.riderAccountId, accountIds),
        ),
      );
    const optedOut = new Set(optOuts.map(o => o.riderAccountId));
    accountIds = accountIds.filter(id => !optedOut.has(id));
  }
  if (accountIds.length === 0) return;

  // Only consider accounts that actually have a device to push to — riders who
  // install the app later today can still get the push on a later cycle.
  const tokens = await db
    .select({ riderAccountId: riderPushTokensTable.riderAccountId, expoPushToken: riderPushTokensTable.expoPushToken })
    .from(riderPushTokensTable)
    .where(inArray(riderPushTokensTable.riderAccountId, accountIds));

  const tokensByAccount = new Map<number, string[]>();
  for (const t of tokens) {
    const list = tokensByAccount.get(t.riderAccountId) ?? [];
    list.push(t.expoPushToken);
    tokensByAccount.set(t.riderAccountId, list);
  }
  const withDevices = accountIds.filter(id => (tokensByAccount.get(id) ?? []).length > 0);
  if (withDevices.length === 0) return;

  // Atomically claim dedup rows BEFORE sending — ON CONFLICT DO NOTHING with
  // RETURNING means only one worker/cycle wins each (event, account) pair,
  // preventing duplicate pushes from overlapping cycles or multiple instances.
  const claimed = await db
    .insert(quickCheckinNotificationsTable)
    .values(withDevices.map(riderAccountId => ({ eventId: event.id, riderAccountId })))
    .onConflictDoNothing()
    .returning({ riderAccountId: quickCheckinNotificationsTable.riderAccountId });
  const notifiableAccounts = claimed.map(c => c.riderAccountId);
  if (notifiableAccounts.length === 0) return;

  const messages: PushMessage[] = [];
  for (const accountId of notifiableAccounts) {
    for (const token of tokensByAccount.get(accountId)!) {
      messages.push({
        to: token,
        title: `🏁 Race day at ${event.trackName ?? event.name}`,
        body: `Skip the check-in line at ${event.name.trim()}: open RM Roost when you get to the track and tap Check In.`,
        data: { type: "quick_checkin", eventId: event.id },
      });
    }
  }

  const result = await sendPushNotifications(messages);

  // An account counts as notified when at least one of its devices accepted the
  // push. Release the claim only for accounts with no accepted device and a
  // retryable failure, so a later cycle retries just those accounts.
  const okTokens = new Set<string>();
  const retryTokens = new Set<string>();
  for (const r of result.results) {
    if (r.ok) okTokens.add(r.to);
    else if (r.retryable) retryTokens.add(r.to);
  }
  const toRelease = notifiableAccounts.filter(id => {
    const toks = tokensByAccount.get(id) ?? [];
    return !toks.some(t => okTokens.has(t)) && toks.some(t => retryTokens.has(t));
  });
  if (toRelease.length > 0) {
    logger.warn(
      { eventId: event.id, released: toRelease.length, accepted: result.accepted, failed: result.failed },
      "Quick check-in morning push: some sends failed, will retry those accounts",
    );
    await db
      .delete(quickCheckinNotificationsTable)
      .where(
        and(
          eq(quickCheckinNotificationsTable.eventId, event.id),
          inArray(quickCheckinNotificationsTable.riderAccountId, toRelease),
        ),
      );
  }
  if (result.accepted === 0) return;

  logger.info(
    { eventId: event.id, accounts: notifiableAccounts.length - toRelease.length, devices: result.accepted },
    "Quick check-in morning push sent",
  );
}

let cycleRunning = false;

export function startQuickCheckinNotifier(): void {
  const tick = async () => {
    if (cycleRunning) return;
    cycleRunning = true;
    try {
      await runQuickCheckinNotifierOnce();
    } catch (err) {
      logger.error({ err }, "Quick check-in notifier cycle failed");
    } finally {
      cycleRunning = false;
      setTimeout(tick, POLL_INTERVAL_MS);
    }
  };
  void tick();
  logger.info("Quick check-in morning push notifier started");
}
