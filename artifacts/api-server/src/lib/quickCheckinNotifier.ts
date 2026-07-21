import {
  db,
  eventsTable,
  registrationsTable,
  ridersTable,
  riderAccountsTable,
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

// Race-day morning push for quick check-in.
//
// Every poll cycle, if it's past SEND_HOUR in Mountain Time, find events with
// quick check-in enabled whose (start) date is today, and send ONE push per
// eligible rider account that hasn't been notified for that event yet
// (deduped durably via the quick_checkin_notifications table).
//
// This complements the local arrival alert in the rider app (fires when the
// app is foregrounded within 1 mile of the track) — the morning push works
// even when the app is closed.

const POLL_INTERVAL_MS = 5 * 60 * 1000;
const SEND_HOUR = 7; // don't push before 7:00 AM Mountain Time
const SEND_HOUR_END = 18; // don't start pushing after 6:00 PM (race is winding down)

function mountainNow(): { dateStr: string; hour: number } {
  const now = new Date();
  const dateStr = now.toLocaleDateString("en-CA", { timeZone: "America/Denver" });
  const hour = Number(
    new Intl.DateTimeFormat("en-US", { timeZone: "America/Denver", hour: "numeric", hour12: false }).format(now),
  );
  return { dateStr, hour };
}

export async function runQuickCheckinNotifierOnce(): Promise<void> {
  const { dateStr: todayStr, hour } = mountainNow();
  if (hour < SEND_HOUR || hour >= SEND_HOUR_END) return;

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
    })
    .from(eventsTable)
    .where(
      and(
        eq(eventsTable.quickCheckinEnabled, true),
        sql`SUBSTRING(${eventsTable.date}::text, 1, 10) = ${todayStr}`,
        ne(eventsTable.status, "completed"),
      ),
    );

  for (const event of events) {
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
};

async function notifyForEvent(event: EventRow): Promise<void> {
  // Non-void registrations with rider emails
  const regs = await db
    .select({
      registrationId: registrationsTable.id,
      riderId: registrationsTable.riderId,
      raceClass: registrationsTable.raceClass,
      myLapsTransponderNumber: registrationsTable.myLapsTransponderNumber,
      waiverAcknowledgedAt: registrationsTable.waiverAcknowledgedAt,
      email: ridersTable.email,
      riderTransponder: ridersTable.mylapsTransponderId,
    })
    .from(registrationsTable)
    .innerJoin(ridersTable, eq(registrationsTable.riderId, ridersTable.id))
    .where(
      and(
        eq(registrationsTable.eventId, event.id),
        ne(registrationsTable.status, "void"),
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
  const waiverByRegId = new Set<number>();
  const waiverByEmail = new Set<string>();
  if (event.requireLiabilityWaiver) {
    const waiverRows = await db
      .select({ registrationId: liabilityWaiverSignaturesTable.registrationId, signerEmail: liabilityWaiverSignaturesTable.signerEmail })
      .from(liabilityWaiverSignaturesTable)
      .where(eq(liabilityWaiverSignaturesTable.eventId, event.id));
    for (const w of waiverRows) {
      if (w.registrationId) waiverByRegId.add(w.registrationId);
      if (w.signerEmail) waiverByEmail.add(w.signerEmail.toLowerCase());
    }
  }

  // Emails of riders with at least one eligible, unchecked-in registration
  const eligibleEmails = new Set<string>();
  for (const r of regs) {
    const email = r.email?.toLowerCase();
    if (!email) continue;
    if (checkedInSet.has(`${r.riderId}:${r.raceClass ?? "Unknown"}`)) continue;
    if (event.timingTechnology === "rfid" && !rfidSet.has(r.riderId)) continue;
    if (event.timingTechnology === "mylaps" && !r.myLapsTransponderNumber && !r.riderTransponder) continue;
    if (event.requireWaiver && !event.requireLiabilityWaiver && !r.waiverAcknowledgedAt) continue;
    if (event.requireLiabilityWaiver && !waiverByRegId.has(r.registrationId) && !waiverByEmail.has(email)) continue;
    eligibleEmails.add(email);
  }
  if (eligibleEmails.size === 0) return;

  // Rider accounts for those emails
  const accounts = await db
    .select({ id: riderAccountsTable.id, email: riderAccountsTable.email })
    .from(riderAccountsTable)
    .where(inArray(sql`LOWER(${riderAccountsTable.email})`, [...eligibleEmails]));
  if (accounts.length === 0) return;
  let accountIds = accounts.map(a => a.id);

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
        body: `Quick Check-In is open for ${event.name.trim()}. Tap to check in from your phone and skip the line.`,
        data: { type: "quick_checkin", eventId: event.id },
      });
    }
  }

  const ok = await sendPushNotifications(messages);
  if (!ok) {
    // Transport-level failure — release the claims so a later cycle retries
    logger.warn({ eventId: event.id }, "Quick check-in morning push: transport failure, will retry");
    await db
      .delete(quickCheckinNotificationsTable)
      .where(
        and(
          eq(quickCheckinNotificationsTable.eventId, event.id),
          inArray(quickCheckinNotificationsTable.riderAccountId, notifiableAccounts),
        ),
      );
    return;
  }

  logger.info(
    { eventId: event.id, accounts: notifiableAccounts.length, devices: messages.length },
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
