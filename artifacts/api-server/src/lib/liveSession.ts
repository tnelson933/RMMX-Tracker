import { db } from "@workspace/db";
import { eventsTable, motosTable, practiceSessionsTable } from "@workspace/db/schema";
import { and, desc, eq } from "drizzle-orm";

/**
 * Which session a club's reader crossings belong to right now.
 *
 * A moto left "in progress" (never finished, e.g. after testing) used to catch
 * every read forever, so a practice started later never saw any. A moto only
 * counts as live when it started within MOTO_LIVE_WINDOW_MS and no practice was
 * started after it.
 */

export const MOTO_LIVE_WINDOW_MS = 12 * 60 * 60_000;

type Moto = typeof motosTable.$inferSelect;
type Practice = typeof practiceSessionsTable.$inferSelect;

/** Pure rule, exported for tests. */
export function motoIsLive(
  moto: { startedAt: Date | string | null },
  practice: { startedAt: Date | string | null; createdAt: Date | string } | null,
  now = Date.now(),
): boolean {
  if (!moto.startedAt) return false;
  const started = new Date(moto.startedAt).getTime();
  if (now - started > MOTO_LIVE_WINDOW_MS) return false;
  if (practice) {
    const practiceStarted = new Date(practice.startedAt ?? practice.createdAt).getTime();
    if (practiceStarted > started) return false;
  }
  return true;
}

export async function activePracticeForClub(clubId: number): Promise<Practice | null> {
  const [practice] = await db
    .select()
    .from(practiceSessionsTable)
    .where(and(eq(practiceSessionsTable.clubId, clubId), eq(practiceSessionsTable.status, "active")))
    .orderBy(desc(practiceSessionsTable.id))
    .limit(1);
  return practice ?? null;
}

/** The club's live moto, or null when none is live (see motoIsLive). */
export async function liveMotoForClub(clubId: number): Promise<Moto | null> {
  const [row] = await db
    .select({ moto: motosTable })
    .from(motosTable)
    .innerJoin(eventsTable, eq(motosTable.eventId, eventsTable.id))
    .where(and(eq(eventsTable.clubId, clubId), eq(motosTable.status, "in_progress")))
    .orderBy(desc(motosTable.startedAt))
    .limit(1);
  if (!row) return null;
  return motoIsLive(row.moto, await activePracticeForClub(clubId)) ? row.moto : null;
}
