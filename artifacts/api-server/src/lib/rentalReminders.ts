import { db, eventsTable, registrationsTable, riderPushTokensTable, ridersTable } from "@workspace/db";
import { and, eq, inArray, ne, sql } from "drizzle-orm";
import { accountIdsByRider } from "./riderAccess";
import { sendPushNotifications } from "./push";
import { clubBuiltInPrice, eventTrackrPrice } from "./sellItems";

/**
 * Transponder rental return reminders (event Transponder Rentals page and
 * Admin → Rentals). Riders are reached by push notification through the RM
 * Roost app; the outcome for each rental is saved so the pages can show a
 * check mark (sent) or a red X (and why not).
 */

export type ReminderStatus = "sent" | "no_app" | "no_notifications" | "failed";

/** What an unreturned transponder costs the rider: the event's RM TrackR price, else the club's (Admin → Sell Items). */
export async function rentalReplacementCharge(eventId: number): Promise<number | null> {
  const [event] = await db.select({ clubId: eventsTable.clubId, purchaseOptions: eventsTable.purchaseOptions })
    .from(eventsTable).where(eq(eventsTable.id, eventId));
  if (!event) return null;
  return eventTrackrPrice(event.purchaseOptions) ?? await clubBuiltInPrice(event.clubId, "rm_trackr");
}

/** The reminder text riders get. */
export function rentalReminderText(charge: number | null): string {
  const amount = charge != null ? ` $${charge.toFixed(2)}` : " the cost of the transponder";
  return `Don't forget to return your rented transponder. Any transponders not returned within 24 hours will be charged${amount}.`;
}

/** Each rider's push tokens (empty: no app, or notifications off). `hasApp` tells the two apart. */
export async function pushReach(riderIds: number[]): Promise<Map<number, { hasApp: boolean; tokens: string[] }>> {
  const byRider = await accountIdsByRider([...new Set(riderIds)]);
  const allAccounts = [...new Set([...byRider.values()].flat())];
  const tokens = allAccounts.length
    ? await db.select({ accountId: riderPushTokensTable.riderAccountId, token: riderPushTokensTable.expoPushToken })
        .from(riderPushTokensTable).where(inArray(riderPushTokensTable.riderAccountId, allAccounts))
    : [];
  const reach = new Map<number, { hasApp: boolean; tokens: string[] }>();
  for (const [riderId, accounts] of byRider) {
    reach.set(riderId, {
      hasApp: accounts.length > 0,
      tokens: [...new Set(tokens.filter(t => accounts.includes(t.accountId)).map(t => t.token))],
    });
  }
  return reach;
}

/** Plain-language reason for a reminder that wasn't sent. */
export function reminderStatusText(status: ReminderStatus | null): string | null {
  switch (status) {
    case "sent": return "Push notification sent";
    case "no_app": return "Not sent: the rider doesn't have the RM Roost app";
    case "no_notifications": return "Not sent: the rider hasn't turned on notifications in the app";
    case "failed": return "Not sent: the notification service didn't accept it. Try again in a few minutes.";
    default: return null;
  }
}

export interface RentalToRemind {
  registrationId: number;
  riderId: number;
  eventId: number;
  riderName: string;
}

/** Rentals whose transponder is still out (a unit was handed out and not returned), at one event or all of a club's events. */
export async function unreturnedRentals(scope: { eventId: number } | { clubId: number }): Promise<RentalToRemind[]> {
  const rows = await db.select({
    registrationId: registrationsTable.id,
    riderId: registrationsTable.riderId,
    eventId: registrationsTable.eventId,
    firstName: ridersTable.firstName,
    lastName: ridersTable.lastName,
  }).from(registrationsTable)
    .innerJoin(eventsTable, eq(registrationsTable.eventId, eventsTable.id))
    .innerJoin(ridersTable, eq(registrationsTable.riderId, ridersTable.id))
    .where(and(
      "eventId" in scope ? eq(registrationsTable.eventId, scope.eventId) : eq(eventsTable.clubId, scope.clubId),
      eq(registrationsTable.transponderRental, true),
      eq(registrationsTable.transponderReturned, false),
      ne(registrationsTable.status, "void"),
      sql`coalesce(trim(${registrationsTable.myLapsTransponderNumber}), '') <> ''`,
    ));
  return rows.map(r => ({
    registrationId: r.registrationId,
    riderId: r.riderId,
    eventId: r.eventId,
    riderName: [r.firstName, r.lastName].filter(Boolean).join(" ") || "Rider",
  }));
}

export interface ReminderResult extends RentalToRemind {
  status: ReminderStatus;
  message: string;
}

/** Send the return reminder to each rental's rider, save each outcome, and report them. */
export async function sendRentalReminders(rentals: RentalToRemind[]): Promise<ReminderResult[]> {
  if (rentals.length === 0) return [];
  const reach = await pushReach(rentals.map(r => r.riderId));
  const charges = new Map<number, number | null>();
  for (const eventId of new Set(rentals.map(r => r.eventId))) charges.set(eventId, await rentalReplacementCharge(eventId));

  // One message per device; a rider renting at two events still gets one per rental.
  const messages: Array<{ to: string; title: string; body: string; data: Record<string, unknown>; index: number }> = [];
  const statuses: ReminderStatus[] = rentals.map((r, index) => {
    const who = reach.get(r.riderId);
    if (!who?.hasApp) return "no_app";
    if (who.tokens.length === 0) return "no_notifications";
    for (const to of who.tokens) {
      messages.push({ to, title: "Return your rented transponder", body: rentalReminderText(charges.get(r.eventId) ?? null), data: { type: "rental_return", eventId: r.eventId }, index });
    }
    return "sent";
  });
  if (messages.length > 0) {
    const sent = await sendPushNotifications(messages.map(({ index: _i, ...m }) => m));
    // A rider counts as reached when at least one of their devices accepted it.
    const reached = new Set(messages.filter((_, i) => sent.results[i]?.ok).map(m => m.index));
    statuses.forEach((s, i) => { if (s === "sent" && !reached.has(i)) statuses[i] = "failed"; });
  }

  const now = new Date();
  for (const status of new Set(statuses)) {
    const ids = rentals.filter((_, i) => statuses[i] === status).map(r => r.registrationId);
    await db.update(registrationsTable).set({ rentalReminderStatus: status, rentalReminderAt: now })
      .where(inArray(registrationsTable.id, ids));
  }
  return rentals.map((r, i) => ({ ...r, status: statuses[i], message: reminderStatusText(statuses[i])! }));
}

/** Can this rental's rider get a push right now? (For greying out the button.) */
export async function reminderAvailability(riderIds: number[]): Promise<Map<number, ReminderStatus>> {
  const reach = await pushReach(riderIds);
  return new Map([...reach].map(([id, r]) => [id, !r.hasApp ? "no_app" : r.tokens.length === 0 ? "no_notifications" : "sent"]));
}
