import { db } from "@workspace/db";
import {
  eventsTable,
  registrationsTable,
  ridersTable,
  riderAccountsTable,
  riderPushTokensTable,
  rfidAssignmentsTable,
  liabilityWaiverSignaturesTable,
  quickCheckinNotificationsTable,
} from "@workspace/db";
import { and, eq, ne, inArray, isNull, sql, notInArray } from "drizzle-orm";
import { logger } from "./logger";
import { sendPushNotifications, type PushMessage } from "./push";

const CHECK_INTERVAL_MS = 5 * 60 * 1000; // every 5 minutes

// "Today" in Mountain Time — the platform serves Rocky Mountain clubs, so race
// day is anchored to America/Denver rather than UTC (UTC flips over at ~6pm MT).
function todayMountain(): string {
  return new Date().toLocaleDateString("en-CA", { timeZone: "America/Denver" });
}

// Finds quick-checkin events happening today, advances their status to race_day
// if needed, checks each rider's eligibility (RFID/waiver/transponder), and
// sends a push to every eligible rider who hasn't already received a notification
// for this event.  Uses quick_checkin_notifications (event_id, rider_account_id)
// as the per-rider dedup guard — so each rider gets at most ONE notification per
// event even if the event-level flag is ever reset for testing.
export async function notifyQuickCheckinOpen(): Promise<void> {
  const todayStr = todayMountain();

  const events = await db
    .select({
      id: eventsTable.id,
      name: eventsTable.name,
      trackName: eventsTable.trackName,
      status: eventsTable.status,
      timingTechnology: eventsTable.timingTechnology,
      requireWaiver: eventsTable.requireWaiver,
      requireLiabilityWaiver: eventsTable.requireLiabilityWaiver,
    })
    .from(eventsTable)
    .where(
      and(
        eq(eventsTable.quickCheckinEnabled, true),
        sql`${eventsTable.date}::date = ${todayStr}::date`,
        isNull(eventsTable.quickCheckinNotifiedAt),
      )
    );

  if (events.length === 0) return;

  for (const event of events) {
    // Atomically claim the event — only the process that flips notified_at from
    // NULL proceeds, preventing duplicate sends from concurrent notifier instances.
    const claimed = await db
      .update(eventsTable)
      .set({ quickCheckinNotifiedAt: new Date() })
      .where(and(eq(eventsTable.id, event.id), isNull(eventsTable.quickCheckinNotifiedAt)))
      .returning({ id: eventsTable.id });
    if (claimed.length === 0) continue;

    // Advance status so the rider app's quick check-in flow activates.
    if (["draft", "registration_open", "registration_closed"].includes(event.status)) {
      await db.update(eventsTable).set({ status: "race_day" }).where(eq(eventsTable.id, event.id));
    }

    // ── 1. All non-void registrations for this event ────────────────────────
    const regs = await db
      .select({
        registrationId: registrationsTable.id,
        riderId: registrationsTable.riderId,
        raceClass: registrationsTable.raceClass,
        myLapsTransponderNumber: registrationsTable.myLapsTransponderNumber,
        waiverAcknowledgedAt: registrationsTable.waiverAcknowledgedAt,
        riderEmail: ridersTable.email,
        riderMylaps: ridersTable.mylapsTransponderId,
      })
      .from(registrationsTable)
      .innerJoin(ridersTable, eq(registrationsTable.riderId, ridersTable.id))
      .where(
        and(
          eq(registrationsTable.eventId, event.id),
          ne(registrationsTable.status, "void"),
        )
      );

    if (regs.length === 0) {
      logger.info({ eventId: event.id }, "Quick check-in notifier: no registrations, skipping");
      continue;
    }

    // ── 2. RFID assignments for this event ─────────────────────────────────
    const riderIds = [...new Set(regs.map(r => r.riderId))];
    const rfidRows = await db
      .select({ riderId: rfidAssignmentsTable.riderId })
      .from(rfidAssignmentsTable)
      .where(
        and(
          eq(rfidAssignmentsTable.eventId, event.id),
          inArray(rfidAssignmentsTable.riderId, riderIds),
        )
      );
    const rfidRiderIds = new Set(rfidRows.map(r => r.riderId));

    // ── 3. Liability waiver signatures for this event ───────────────────────
    const waiverRows = await db
      .select({
        registrationId: liabilityWaiverSignaturesTable.registrationId,
        signerEmail: liabilityWaiverSignaturesTable.signerEmail,
      })
      .from(liabilityWaiverSignaturesTable)
      .where(eq(liabilityWaiverSignaturesTable.eventId, event.id));
    const waiverByRegId = new Set(
      waiverRows.filter(w => w.registrationId != null).map(w => w.registrationId!)
    );
    const waiverByEmail = new Set(
      waiverRows.map(w => w.signerEmail?.toLowerCase()).filter(Boolean) as string[]
    );

    // ── 4. Determine eligible rider emails ──────────────────────────────────
    const eligibleEmails = new Set<string>();
    for (const r of regs) {
      if (!r.riderEmail) continue;

      // RFID events: rider must have an RFID assignment for this event
      if (event.timingTechnology === "rfid" && !rfidRiderIds.has(r.riderId)) continue;

      // Mylaps events: must have a transponder (registration-level or rider-level)
      if (event.timingTechnology === "mylaps") {
        if (!r.myLapsTransponderNumber && !r.riderMylaps) continue;
      }

      // Simple acknowledgment waiver
      if (event.requireWaiver && !event.requireLiabilityWaiver) {
        if (!r.waiverAcknowledgedAt) continue;
      }

      // Full liability waiver
      if (event.requireLiabilityWaiver) {
        const hasSig =
          waiverByRegId.has(r.registrationId) ||
          waiverByEmail.has(r.riderEmail.toLowerCase());
        if (!hasSig) continue;
      }

      eligibleEmails.add(r.riderEmail.toLowerCase());
    }

    if (eligibleEmails.size === 0) {
      logger.info({ eventId: event.id, eventName: event.name }, "Quick check-in notifier: no eligible riders");
      continue;
    }

    // ── 5. Resolve eligible emails → rider accounts ─────────────────────────
    const emailList = [...eligibleEmails];
    const accounts = await db
      .select({ id: riderAccountsTable.id })
      .from(riderAccountsTable)
      .where(inArray(sql`LOWER(${riderAccountsTable.email})`, emailList));

    if (accounts.length === 0) continue;
    const accountIds = accounts.map(a => a.id);

    // ── 6. Per-rider dedup: skip accounts already notified for this event ───
    //    This guard survives event-level flag resets (e.g. for testing), so
    //    each rider can never receive this event's notification more than once.
    const alreadyNotifiedRows = await db
      .select({ riderAccountId: quickCheckinNotificationsTable.riderAccountId })
      .from(quickCheckinNotificationsTable)
      .where(
        and(
          eq(quickCheckinNotificationsTable.eventId, event.id),
          inArray(quickCheckinNotificationsTable.riderAccountId, accountIds),
        )
      );
    const alreadyNotifiedIds = new Set(alreadyNotifiedRows.map(r => r.riderAccountId));
    const newAccountIds = accountIds.filter(id => !alreadyNotifiedIds.has(id));

    if (newAccountIds.length === 0) {
      logger.info({ eventId: event.id, eventName: event.name }, "Quick check-in notifier: all eligible riders already notified");
      continue;
    }

    // ── 7. Get push tokens for unnotified accounts ──────────────────────────
    const tokens = await db
      .select({ token: riderPushTokensTable.expoPushToken, accountId: riderPushTokensTable.riderAccountId })
      .from(riderPushTokensTable)
      .where(inArray(riderPushTokensTable.riderAccountId, newAccountIds));

    // Deduplicate: one message per push token
    const tokenMap = new Map<string, number>(); // token → accountId
    for (const t of tokens) tokenMap.set(t.token, t.accountId);

    const messages: PushMessage[] = [...tokenMap.keys()].map(token => ({
      to: token,
      title: "🏁 Race Day — Quick Check-In is Open",
      body: `Welcome to ${event.name}${event.trackName ? ` at ${event.trackName}` : ""}! Tap here to complete Quick Check-In and skip the check-in line.`,
      data: { type: "quick_checkin", eventId: event.id },
    }));

    // ── 8. Send and record per-rider notifications ──────────────────────────
    let sentOk = true;
    if (messages.length > 0) {
      sentOk = await sendPushNotifications(messages);
    }

    if (!sentOk) {
      // Transport failure — release the event-level claim so the next tick
      // retries.  The per-rider table has no rows yet, so they'll be retried too.
      await db
        .update(eventsTable)
        .set({ quickCheckinNotifiedAt: null })
        .where(eq(eventsTable.id, event.id));
      logger.warn({ eventId: event.id, eventName: event.name }, "Quick check-in push failed; will retry next tick");
    } else {
      // Record which accounts were successfully notified so they never get
      // a duplicate, even if the event-level flag is reset later.
      if (newAccountIds.length > 0) {
        await db
          .insert(quickCheckinNotificationsTable)
          .values(newAccountIds.map(riderAccountId => ({ eventId: event.id, riderAccountId })))
          .onConflictDoNothing();
      }
      logger.info(
        { eventId: event.id, eventName: event.name, pushCount: messages.length, eligibleRiders: eligibleEmails.size },
        "Quick check-in race-day notification sent"
      );
    }
  }
}

export function startQuickCheckinNotifier(): void {
  const run = () => notifyQuickCheckinOpen().catch(err => logger.error({ err }, "quickCheckinNotifier failed"));
  run(); // run once on startup
  setInterval(run, CHECK_INTERVAL_MS);
}
