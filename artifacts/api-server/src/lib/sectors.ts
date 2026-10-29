/**
 * Course splits and sector times (motocross / supercross).
 *
 * An event's course map has one finish-line reader (it scores laps and
 * placings exactly as before) plus any number of ordered split readers. A
 * split read is stored in split_crossings against the lap the rider is on, and
 * never touches laps or results. Sector times come from the gaps between
 * consecutive course points:
 *
 *   lap start (moto start or previous finish pass) → split 1 → … → split N → finish
 *
 * so a course with N splits has N + 1 sectors. A missed split leaves the two
 * sectors around it blank; the lap time itself is unaffected.
 */
import { db } from "@workspace/db";
import { eventReaderAssignmentsTable, lapCrossingsTable, splitCrossingsTable, motosTable } from "@workspace/db/schema";
import { and, asc, eq, isNull, lt, sql } from "drizzle-orm";

export interface CoursePoint {
  assignmentId: number;
  readerId: number;
  sequence: number;
  label: string;
}

export interface Course {
  finish: { assignmentId: number; readerId: number } | null;
  splits: CoursePoint[];
}

/** The event-wide course (finish + ordered splits). Enduro test gates are not part of it. */
export async function getCourse(eventId: number): Promise<Course> {
  const rows = await db
    .select()
    .from(eventReaderAssignmentsTable)
    .where(and(eq(eventReaderAssignmentsTable.eventId, eventId), isNull(eventReaderAssignmentsTable.motoId)));
  const finish = rows.find(r => r.role === "finish") ?? null;
  const splits = rows
    .filter(r => r.role === "split")
    .sort((a, b) => (a.sequence ?? 0) - (b.sequence ?? 0) || a.id - b.id)
    .map((r, i) => ({ assignmentId: r.id, readerId: r.readerId, sequence: i + 1, label: r.label?.trim() || `Split ${i + 1}` }));
  return { finish: finish ? { assignmentId: finish.id, readerId: finish.readerId } : null, splits };
}

/** "Finish → Halfway", "Halfway → Finish", … — one name per sector. */
export function sectorNames(splits: Array<{ label: string }>): string[] {
  const points = ["Finish", ...splits.map(s => s.label), "Finish"];
  return points.slice(1).map((to, i) => `${points[i]} → ${to}`);
}

export interface SectorInput {
  startedAt: Date | null;
  splitCount: number;
  /** Finish passes for one rider, any order. */
  laps: Array<{ lapNumber: number; crossingTime: Date }>;
  /** Split passes for one rider, any order. */
  splits: Array<{ lapNumber: number; splitSequence: number; crossingTime: Date }>;
}

export interface LapSectors {
  lapNumber: number;
  /** One entry per sector; null where a course point was missed. */
  sectorsMs: Array<number | null>;
  /** False for the lap in progress (finish not reached yet). */
  complete: boolean;
}

/** Sector times per lap for one rider. Pure, so it is shared by tests and the offline server. */
export function computeRiderSectors(input: SectorInput): LapSectors[] {
  const finishByLap = new Map(input.laps.map(l => [l.lapNumber, l.crossingTime.getTime()]));
  const splitAt = new Map(input.splits.map(s => [`${s.lapNumber}:${s.splitSequence}`, s.crossingTime.getTime()]));
  const lastLap = Math.max(0, ...input.laps.map(l => l.lapNumber), ...input.splits.map(s => s.lapNumber));
  const out: LapSectors[] = [];
  for (let lap = 1; lap <= lastLap; lap++) {
    const start = lap === 1 ? input.startedAt?.getTime() ?? null : finishByLap.get(lap - 1) ?? null;
    const points: Array<number | null> = [start];
    for (let s = 1; s <= input.splitCount; s++) points.push(splitAt.get(`${lap}:${s}`) ?? null);
    const finish = finishByLap.get(lap) ?? null;
    points.push(finish);
    const sectorsMs = points.slice(1).map((t, i) => {
      const from = points[i];
      return t != null && from != null && t > from ? t - from : null;
    });
    out.push({ lapNumber: lap, sectorsMs, complete: finish != null });
  }
  return out;
}

/** Best time per sector across a rider's laps (nulls where never timed). */
export function bestSectors(laps: LapSectors[], sectorCount: number): Array<number | null> {
  return Array.from({ length: sectorCount }, (_, i) => {
    const values = laps.map(l => l.sectorsMs[i]).filter((v): v is number => v != null);
    return values.length ? Math.min(...values) : null;
  });
}

export interface MotoSectors {
  names: string[];
  byRider: Map<number, { laps: LapSectors[]; best: Array<number | null> }>;
}

/** Sector times for every rider in a moto, or null when the event has no splits. */
export async function computeMotoSectors(motoId: number): Promise<MotoSectors | null> {
  const [moto] = await db.select({ eventId: motosTable.eventId, startedAt: motosTable.startedAt, type: motosTable.type })
    .from(motosTable).where(eq(motosTable.id, motoId));
  if (!moto || moto.type === "enduro_test") return null;
  const course = await getCourse(moto.eventId);
  if (course.splits.length === 0) return null;

  const [laps, splits] = await Promise.all([
    db.select({ riderId: lapCrossingsTable.riderId, lapNumber: lapCrossingsTable.lapNumber, crossingTime: lapCrossingsTable.crossingTime })
      .from(lapCrossingsTable).where(eq(lapCrossingsTable.motoId, motoId)),
    db.select({ riderId: splitCrossingsTable.riderId, lapNumber: splitCrossingsTable.lapNumber, splitSequence: splitCrossingsTable.splitSequence, crossingTime: splitCrossingsTable.crossingTime })
      .from(splitCrossingsTable).where(eq(splitCrossingsTable.motoId, motoId)),
  ]);

  // Motos run before the splits were placed (or with every split reader down)
  // have nothing to show.
  if (splits.length === 0) return null;

  const riderIds = new Set<number>();
  for (const row of [...laps, ...splits]) if (row.riderId != null) riderIds.add(row.riderId);
  const byRider: MotoSectors["byRider"] = new Map();
  const sectorCount = course.splits.length + 1;
  for (const riderId of riderIds) {
    const riderLaps = computeRiderSectors({
      startedAt: moto.startedAt,
      splitCount: course.splits.length,
      laps: laps.filter(l => l.riderId === riderId && l.lapNumber != null).map(l => ({ lapNumber: l.lapNumber!, crossingTime: l.crossingTime })),
      splits: splits.filter(s => s.riderId === riderId),
    });
    byRider.set(riderId, { laps: riderLaps, best: bestSectors(riderLaps.filter(l => l.complete || l.sectorsMs.some(v => v != null)), sectorCount) });
  }
  return { names: sectorNames(course.splits), byRider };
}

/**
 * Record a split pass. The lap is the one the rider is on (finish passes so
 * far + 1). The first read of a split per lap wins, so a burst of reads from
 * one pass is stored once.
 */
export async function recordSplitCrossing(input: {
  eventId: number;
  motoId: number;
  split: CoursePoint;
  readerId: number;
  rfidNumber: string;
  riderId: number | null;
  crossingTime: Date;
}): Promise<{ recorded: boolean; lapNumber: number }> {
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(lapCrossingsTable)
    // The lap in progress when the split was read: the rider's finish passes
    // before it (a split that arrives late still lands on its own lap).
    .where(and(
      eq(lapCrossingsTable.motoId, input.motoId),
      input.riderId
        ? eq(lapCrossingsTable.riderId, input.riderId)
        // Same tag, any letter case (transponder IDs are hex).
        : sql`lower(${lapCrossingsTable.rfidNumber}) = lower(${input.rfidNumber})`,
      lt(lapCrossingsTable.crossingTime, input.crossingTime),
    ));
  const lapNumber = Number(row?.n ?? 0) + 1;
  const inserted = await db
    .insert(splitCrossingsTable)
    .values({
      eventId: input.eventId,
      motoId: input.motoId,
      assignmentId: input.split.assignmentId,
      readerId: input.readerId,
      splitSequence: input.split.sequence,
      label: input.split.label,
      riderId: input.riderId,
      rfidNumber: input.rfidNumber,
      lapNumber,
      crossingTime: input.crossingTime,
    })
    .onConflictDoNothing()
    .returning({ id: splitCrossingsTable.id });
  return { recorded: inserted.length > 0, lapNumber };
}

/** Split order for the reader, if it is a split on this event's course. */
export async function splitForReader(eventId: number, readerId: number): Promise<CoursePoint | null> {
  const course = await getCourse(eventId);
  return course.splits.find(s => s.readerId === readerId) ?? null;
}

/** Splits recorded so far, newest last (for results exports and the rider app). */
export async function listSplitCrossings(motoId: number) {
  return db.select().from(splitCrossingsTable).where(eq(splitCrossingsTable.motoId, motoId))
    .orderBy(asc(splitCrossingsTable.crossingTime), asc(splitCrossingsTable.id));
}
