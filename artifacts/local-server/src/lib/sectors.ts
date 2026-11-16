/**
 * Course splits and sector times, as the cloud computes them
 * (api-server lib/sectors.ts and lib/practiceSplits.ts).
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
 *
 * The offline database has no readers table: a reader is the cloud's numeric
 * reader id, which is what event_reader_assignments.reader_id holds.
 */
import { getDb, parseJson } from "../db";

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
export function getCourse(eventId: number): Course {
  const rows = getDb()
    .prepare("SELECT * FROM event_reader_assignments WHERE event_id = ? AND moto_id IS NULL")
    .all(eventId) as any[];
  const finish = rows.find(r => r.role === "finish") ?? null;
  const splits = rows
    .filter(r => r.role === "split")
    .sort((a, b) => (a.sequence ?? 0) - (b.sequence ?? 0) || a.id - b.id)
    .map((r, i) => ({ assignmentId: r.id, readerId: r.reader_id, sequence: i + 1, label: String(r.label ?? "").trim() || `Split ${i + 1}` }));
  return { finish: finish ? { assignmentId: finish.id, readerId: finish.reader_id } : null, splits };
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

/** Sector times per lap for one rider. */
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

/** One pass of a course point: point 1..N are the splits, N + 1 is the finish. */
export interface TimingPoint {
  lap: number;
  point: number;
  /** Wall-clock time of the pass (ms since epoch). */
  atMs: number;
}

/** A rider's passes of every course point, in course order. */
export function riderTimingPoints(input: Pick<SectorInput, "splitCount" | "laps" | "splits">): TimingPoint[] {
  const points: TimingPoint[] = [
    ...input.splits.map(s => ({ lap: s.lapNumber, point: s.splitSequence, atMs: s.crossingTime.getTime() })),
    ...input.laps.map(l => ({ lap: l.lapNumber, point: input.splitCount + 1, atMs: l.crossingTime.getTime() })),
  ];
  return points.sort((a, b) => a.lap - b.lap || a.point - b.point);
}

export interface SplitGap {
  lap: number;
  /** 1..N for the splits, N + 1 for the finish. */
  point: number;
  /** Behind the race leader at this same point and lap (null if the leader's pass there wasn't read). */
  gapToLeaderMs: number | null;
  /** Behind the rider one place ahead, at the same point and lap. */
  gapToAheadMs: number | null;
}

/**
 * Where each rider was last timed on the course and how far behind the leader
 * and the rider ahead they were there. `order` is the running order (leader first).
 */
export function latestSplitGaps(order: number[], pointsByRider: Map<number, TimingPoint[]>): Map<number, SplitGap> {
  const at = (riderId: number | undefined, lap: number, point: number) =>
    riderId == null ? undefined : pointsByRider.get(riderId)?.find(p => p.lap === lap && p.point === point)?.atMs;
  const out = new Map<number, SplitGap>();
  order.forEach((riderId, i) => {
    const latest = pointsByRider.get(riderId)?.at(-1);
    if (!latest) return;
    const leader = at(order[0], latest.lap, latest.point);
    const ahead = i > 0 ? at(order[i - 1], latest.lap, latest.point) : undefined;
    out.set(riderId, {
      lap: latest.lap,
      point: latest.point,
      gapToLeaderMs: i === 0 ? 0 : leader != null ? latest.atMs - leader : null,
      gapToAheadMs: i === 0 ? null : ahead != null ? latest.atMs - ahead : null,
    });
  });
  return out;
}

/** Fastest time in each sector across every rider and lap (the race's best). */
export function fieldBestSectors(riders: Iterable<{ laps: LapSectors[] }>, sectorCount: number): Array<number | null> {
  const all = [...riders].flatMap(r => r.laps);
  return bestSectors(all, sectorCount);
}

export interface MotoSectors {
  names: string[];
  /** Point names in course order: the splits, then "Finish". */
  pointNames: string[];
  byRider: Map<number, { laps: LapSectors[]; best: Array<number | null>; points: TimingPoint[] }>;
  fieldBest: Array<number | null>;
}

/** Sector times for every rider in a moto, or null when the event has no splits. */
export function computeMotoSectors(motoId: number): MotoSectors | null {
  const db = getDb();
  const moto = db.prepare("SELECT event_id, started_at, type FROM motos WHERE id = ?").get(motoId) as any;
  if (!moto || moto.type === "enduro_test") return null;
  const course = getCourse(moto.event_id);
  if (course.splits.length === 0) return null;

  const laps = (db.prepare("SELECT rider_id, lap_number, crossing_time FROM lap_crossings WHERE moto_id = ?").all(motoId) as any[])
    .map(l => ({ riderId: l.rider_id as number | null, lapNumber: l.lap_number as number | null, crossingTime: new Date(l.crossing_time) }));
  const splits = (db.prepare("SELECT rider_id, lap_number, split_sequence, crossing_time FROM split_crossings WHERE moto_id = ?").all(motoId) as any[])
    .map(s => ({ riderId: s.rider_id as number | null, lapNumber: s.lap_number as number, splitSequence: s.split_sequence as number, crossingTime: new Date(s.crossing_time) }));

  // Motos run before the splits were placed (or with every split reader down)
  // have nothing to show.
  if (splits.length === 0) return null;

  const riderIds = new Set<number>();
  for (const row of [...laps, ...splits]) if (row.riderId != null) riderIds.add(row.riderId);
  const byRider: MotoSectors["byRider"] = new Map();
  const sectorCount = course.splits.length + 1;
  const startedAt = moto.started_at ? new Date(moto.started_at) : null;
  for (const riderId of riderIds) {
    const riderLapRows = laps.filter(l => l.riderId === riderId && l.lapNumber != null).map(l => ({ lapNumber: l.lapNumber!, crossingTime: l.crossingTime }));
    const riderSplits = splits.filter(s => s.riderId === riderId);
    const riderLaps = computeRiderSectors({ startedAt, splitCount: course.splits.length, laps: riderLapRows, splits: riderSplits });
    byRider.set(riderId, {
      laps: riderLaps,
      best: bestSectors(riderLaps.filter(l => l.complete || l.sectorsMs.some(v => v != null)), sectorCount),
      points: riderTimingPoints({ splitCount: course.splits.length, laps: riderLapRows, splits: riderSplits }),
    });
  }
  return {
    names: sectorNames(course.splits),
    pointNames: [...course.splits.map(s => s.label), "Finish"],
    byRider,
    fieldBest: fieldBestSectors(byRider.values(), sectorCount),
  };
}

/**
 * Record a split pass. The lap is the one the rider is on (finish passes
 * before the split + 1, so a split that arrives late still lands on its own
 * lap). The first read of a split per lap wins, so a burst of reads from one
 * pass is stored once.
 */
export function recordSplitCrossing(input: {
  eventId: number;
  motoId: number;
  split: CoursePoint;
  readerId: number;
  rfidNumber: string;
  riderId: number | null;
  crossingTime: Date;
}): { recorded: boolean; lapNumber: number } {
  const db = getDb();
  const passes = (input.riderId
    ? db.prepare("SELECT crossing_time FROM lap_crossings WHERE moto_id = ? AND rider_id = ?").all(input.motoId, input.riderId)
    // Same tag, any letter case (transponder IDs are hex).
    : db.prepare("SELECT crossing_time FROM lap_crossings WHERE moto_id = ? AND rfid_number = ? COLLATE NOCASE").all(input.motoId, input.rfidNumber)) as Array<{ crossing_time: string }>;
  const at = input.crossingTime.getTime();
  const lapNumber = passes.filter(p => new Date(p.crossing_time).getTime() < at).length + 1;
  const inserted = db.prepare(
    `INSERT INTO split_crossings
       (event_id, moto_id, assignment_id, reader_id, split_sequence, label, rider_id, rfid_number, lap_number, crossing_time)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (moto_id, rfid_number, split_sequence, lap_number) DO NOTHING`,
  ).run(
    input.eventId, input.motoId, input.split.assignmentId, input.readerId, input.split.sequence, input.split.label,
    input.riderId, input.rfidNumber, lapNumber, input.crossingTime.toISOString(),
  );
  return { recorded: inserted.changes > 0, lapNumber };
}

/** Split order for the reader, if it is a split on this event's course. */
export function splitForReader(eventId: number, readerId: number): CoursePoint | null {
  return getCourse(eventId).splits.find(s => s.readerId === readerId) ?? null;
}

/** True when the reader is a split on any course: its reads must never become laps. */
export function isSplitReader(readerId: number): boolean {
  return !!getDb().prepare("SELECT 1 FROM event_reader_assignments WHERE reader_id = ? AND role = 'split' LIMIT 1").get(readerId);
}

/**
 * After a rider's finish pass is deleted, refile their split reads under the
 * new lap numbering (lap = finish passes before the split + 1). Two reads of
 * one split that now land on the same lap keep the earlier one. Run inside the
 * transaction that deleted the pass.
 */
export function refileSplitsAfterLapDelete(motoId: number, riderId: number | null, rfidNumber: string): void {
  const db = getDb();
  const remaining = (riderId
    ? db.prepare("SELECT crossing_time FROM lap_crossings WHERE moto_id = ? AND rider_id = ?").all(motoId, riderId)
    : db.prepare("SELECT crossing_time FROM lap_crossings WHERE moto_id = ? AND rfid_number = ?").all(motoId, rfidNumber)) as Array<{ crossing_time: string }>;
  const passTimes = remaining.map(c => new Date(c.crossing_time).getTime());
  const splits = (db
    .prepare("SELECT id, split_sequence, crossing_time FROM split_crossings WHERE moto_id = ? AND rfid_number = ?")
    .all(motoId, rfidNumber) as Array<{ id: number; split_sequence: number; crossing_time: string }>)
    .sort((a, b) => new Date(a.crossing_time).getTime() - new Date(b.crossing_time).getTime() || a.id - b.id);
  const kept = new Map<string, { id: number; lapNumber: number }>();
  const remove = db.prepare("DELETE FROM split_crossings WHERE id = ?");
  for (const split of splits) {
    const at = new Date(split.crossing_time).getTime();
    const lapNumber = passTimes.filter(t => t < at).length + 1;
    const key = `${split.split_sequence}:${lapNumber}`;
    if (kept.has(key)) remove.run(split.id);
    else kept.set(key, { id: split.id, lapNumber });
  }
  // Two steps so a renumbered row never collides with one not yet moved.
  const setLap = db.prepare("UPDATE split_crossings SET lap_number = ? WHERE id = ?");
  for (const { id } of kept.values()) setLap.run(-id, id);
  for (const { id, lapNumber } of kept.values()) setLap.run(lapNumber, id);
}

// ── Practice ──────────────────────────────────────────────────────────────────

/** The track's course when the practice started (practice_sessions.course). */
export interface PracticeCourse {
  finishReaderId: number | null;
  splits: Array<{ readerId: number; sequence: number; label: string }>;
}

/** The stored course of a practice session row (null when it has none). */
export function practiceCourseOf(session: { course?: string | null } | null | undefined): PracticeCourse | null {
  const course = parseJson<PracticeCourse | null>(session?.course ?? null, null);
  return course && Array.isArray(course.splits) ? course : null;
}

export function practiceSplitFor(course: PracticeCourse | null | undefined, readerId: number) {
  return course?.splits.find(s => s.readerId === readerId) ?? null;
}

/**
 * Record a split read for a running practice. Returns null when the reader
 * isn't a split on this practice's course. A rider who hasn't crossed the
 * finish line yet has no lap in progress, so the read is ignored.
 */
export function recordPracticeSplit(input: {
  session: { id: number; course?: string | null };
  readerId: number;
  rfidNumber: string;
  crossingTime: Date;
}): { recorded: boolean; lapNumber: number; label: string } | null {
  const split = practiceSplitFor(practiceCourseOf(input.session), input.readerId);
  if (!split) return null;
  const db = getDb();
  const tag = input.rfidNumber.trim();
  const passes = (db
    .prepare("SELECT rider_id, rfid_number, crossing_time FROM practice_crossings WHERE session_id = ? AND rfid_number = ? COLLATE NOCASE")
    .all(input.session.id, tag) as Array<{ rider_id: number | null; rfid_number: string; crossing_time: string }>)
    .map(p => ({ ...p, at: new Date(p.crossing_time).getTime() }));
  const at = input.crossingTime.getTime();
  const lapNumber = passes.filter(p => p.at < at).length;
  if (lapNumber < 1) return { recorded: false, lapNumber: 0, label: split.label };
  const last = passes.reduce((newest, p) => (p.at > newest.at ? p : newest), passes[0]);
  const inserted = db.prepare(
    `INSERT INTO practice_split_crossings
       (session_id, reader_id, split_sequence, label, rider_id, rfid_number, lap_number, crossing_time)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (session_id, rfid_number, split_sequence, lap_number) DO NOTHING`,
  ).run(
    input.session.id, input.readerId, split.sequence, split.label, last?.rider_id ?? null,
    // Stored like the rider's passes so the board matches them up.
    last?.rfid_number ?? tag, lapNumber, input.crossingTime.toISOString(),
  );
  return { recorded: inserted.changes > 0, lapNumber, label: split.label };
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

/** Split reads of a practice session, in the shape practiceSectors takes. */
export function listPracticeSplits(sessionId: number) {
  return (getDb()
    .prepare("SELECT rfid_number, lap_number, split_sequence, crossing_time FROM practice_split_crossings WHERE session_id = ?")
    .all(sessionId) as any[])
    .map(s => ({ rfidNumber: String(s.rfid_number), lapNumber: s.lap_number as number, splitSequence: s.split_sequence as number, crossingTime: new Date(s.crossing_time) }));
}
