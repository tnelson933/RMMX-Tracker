/**
 * Sector times in practice. A practice at a Track Library track snapshots the
 * track's course (practice_sessions.course). A read from one of its split
 * readers is stored against the rider's lap in progress and never counts as a
 * lap; sectors come from the same calculation as races (lib/sectors.ts).
 *
 * Practice laps: a rider's first pass starts lap 1; pass k + 1 ends lap k.
 */
import { db } from "@workspace/db";
import {
  practiceCrossingsTable, practiceSplitCrossingsTable,
  type PracticeCourse, type PracticeSession,
} from "@workspace/db/schema";
import { and, desc, eq, lt, sql } from "drizzle-orm";
import { bestSectors, computeRiderSectors, sectorNames, type LapSectors } from "./sectors";

export function practiceSplitFor(course: PracticeCourse | null | undefined, readerId: number) {
  return course?.splits.find(s => s.readerId === readerId) ?? null;
}

/**
 * Record a split read for a running practice. Returns null when the reader
 * isn't a split on this practice's course. A rider who hasn't crossed the
 * finish line yet has no lap in progress, so the read is ignored.
 */
export async function recordPracticeSplit(input: {
  session: PracticeSession;
  readerId: number;
  rfidNumber: string;
  crossingTime: Date;
}): Promise<{ recorded: boolean; lapNumber: number; label: string } | null> {
  const split = practiceSplitFor(input.session.course, input.readerId);
  if (!split) return null;
  const tag = input.rfidNumber.trim();
  const sameTag = sql`lower(${practiceCrossingsTable.rfidNumber}) = lower(${tag})`;
  const [row] = await db.select({ n: sql<number>`count(*)::int` }).from(practiceCrossingsTable)
    .where(and(eq(practiceCrossingsTable.sessionId, input.session.id), sameTag, lt(practiceCrossingsTable.crossingTime, input.crossingTime)));
  const lapNumber = Number(row?.n ?? 0);
  if (lapNumber < 1) return { recorded: false, lapNumber: 0, label: split.label };
  const [last] = await db.select({ riderId: practiceCrossingsTable.riderId, rfidNumber: practiceCrossingsTable.rfidNumber })
    .from(practiceCrossingsTable)
    .where(and(eq(practiceCrossingsTable.sessionId, input.session.id), sameTag))
    .orderBy(desc(practiceCrossingsTable.crossingTime)).limit(1);
  const inserted = await db.insert(practiceSplitCrossingsTable).values({
    sessionId: input.session.id,
    readerId: input.readerId,
    splitSequence: split.sequence,
    label: split.label,
    riderId: last?.riderId ?? null,
    // Stored like the rider's passes so the board matches them up.
    rfidNumber: last?.rfidNumber ?? tag,
    lapNumber,
    crossingTime: input.crossingTime,
  }).onConflictDoNothing().returning({ id: practiceSplitCrossingsTable.id });
  return { recorded: inserted.length > 0, lapNumber, label: split.label };
}

export interface PracticeRiderSectors {
  /** Timed laps in order (lapNumber 1 = the lap after the first pass). */
  laps: LapSectors[];
  best: Array<number | null>;
}

/** Sector names and each tag's sectors, or null when the course has no splits. */
export function practiceSectors(
  course: PracticeCourse | null | undefined,
  passes: Array<{ rfidNumber: string; crossingTime: Date }>,
  splits: Array<{ rfidNumber: string; lapNumber: number; splitSequence: number; crossingTime: Date }>,
): { names: string[]; byTag: Map<string, PracticeRiderSectors> } | null {
  if (!course || course.splits.length === 0) return null;
  const splitCount = course.splits.length;
  const byTag = new Map<string, PracticeRiderSectors>();
  const tags = new Set(passes.map(p => p.rfidNumber.toLowerCase()));
  for (const tag of tags) {
    const mine = passes.filter(p => p.rfidNumber.toLowerCase() === tag)
      .sort((a, b) => a.crossingTime.getTime() - b.crossingTime.getTime());
    const laps = computeRiderSectors({
      startedAt: mine[0]?.crossingTime ?? null,
      splitCount,
      laps: mine.slice(1).map((p, i) => ({ lapNumber: i + 1, crossingTime: p.crossingTime })),
      splits: splits.filter(s => s.rfidNumber.toLowerCase() === tag),
    });
    byTag.set(tag, { laps, best: bestSectors(laps, splitCount + 1) });
  }
  return { names: sectorNames(course.splits), byTag };
}

export async function listPracticeSplits(sessionId: number) {
  return db.select().from(practiceSplitCrossingsTable).where(eq(practiceSplitCrossingsTable.sessionId, sessionId));
}
