import { db, motosTable, raceResultsTable, resultsNotificationsTable } from "@workspace/db";
import { and, eq, ne, sql } from "drizzle-orm";
import { fingerprintsByRider, ridersToNotify } from "./resultsNotifyCore";

export type ResultsNotificationKind = "stats_email" | "follow_push";

/** Each rider's results fingerprint for an event's finished races (practice excluded). */
export async function eventResultFingerprints(eventId: number): Promise<Map<number, string>> {
  const rows = await db.select({
    riderId: raceResultsTable.riderId,
    motoId: raceResultsTable.motoId,
    position: raceResultsTable.position,
    dnf: raceResultsTable.dnf,
    dns: raceResultsTable.dns,
    lapTimes: raceResultsTable.lapTimes,
  }).from(raceResultsTable)
    .innerJoin(motosTable, eq(raceResultsTable.motoId, motosTable.id))
    .where(and(eq(raceResultsTable.eventId, eventId), eq(motosTable.status, "completed"), ne(motosTable.type, "practice")));
  return fingerprintsByRider(rows);
}

/** Fingerprints recorded the last time each rider was notified about this event. */
export async function sentFingerprints(eventId: number, kind: ResultsNotificationKind): Promise<Map<number, string>> {
  const rows = await db.select({ riderId: resultsNotificationsTable.riderId, fingerprint: resultsNotificationsTable.fingerprint })
    .from(resultsNotificationsTable)
    .where(and(eq(resultsNotificationsTable.eventId, eventId), eq(resultsNotificationsTable.kind, kind)));
  return new Map(rows.map(r => [r.riderId, r.fingerprint]));
}

/**
 * Record that this rider is being notified about these results. Returns false
 * when the same results were already recorded (another finalize got there
 * first), so two requests at once can't both send.
 */
export async function claimNotification(eventId: number, riderId: number, kind: ResultsNotificationKind, fingerprint: string): Promise<boolean> {
  const res = await db.execute(sql`
    insert into results_notifications (event_id, rider_id, kind, fingerprint, sent_at)
    values (${eventId}, ${riderId}, ${kind}, ${fingerprint}, now())
    on conflict (event_id, rider_id, kind) do update
      set fingerprint = excluded.fingerprint, sent_at = now()
      where results_notifications.fingerprint is distinct from excluded.fingerprint
    returning id`);
  return res.rows.length > 0;
}

/** Undo a claim whose send failed, so the next finalize tries that rider again. */
export async function releaseNotification(eventId: number, riderId: number, kind: ResultsNotificationKind, previous: string | undefined): Promise<void> {
  if (previous === undefined) {
    await db.delete(resultsNotificationsTable).where(and(
      eq(resultsNotificationsTable.eventId, eventId), eq(resultsNotificationsTable.riderId, riderId), eq(resultsNotificationsTable.kind, kind)));
  } else {
    await db.update(resultsNotificationsTable).set({ fingerprint: previous }).where(and(
      eq(resultsNotificationsTable.eventId, eventId), eq(resultsNotificationsTable.riderId, riderId), eq(resultsNotificationsTable.kind, kind)));
  }
}

/** Who to notify now for this event and kind, with what each rider was last sent. */
export async function pendingResultNotifications(eventId: number, kind: ResultsNotificationKind) {
  const [current, sent] = await Promise.all([eventResultFingerprints(eventId), sentFingerprints(eventId, kind)]);
  return { current, sent, ...ridersToNotify(current, sent) };
}
