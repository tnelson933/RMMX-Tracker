/**
 * Sprint-enduro scoring for the offline server. Mirrors the cloud's
 * lib/enduroOverall.ts (run pairing, per-test ranking) and
 * routes/enduro-scoring.ts (rider classes, time-check penalties, re-ranking).
 *
 * Each rider runs a test (a moto with type "enduro_test") `lap_count` times; a
 * run is a START read followed by a FINISH read. A rider's test time is the
 * sum of their completed runs.
 */
import { getDb, parseJson, parseJsonArr } from "../db";

/** Placeholder class enduro tests are created with (tests are event-wide). */
export const ENDURO_ALL_CLASSES = "All Classes";

/**
 * An enduro crossing that can't be recorded (rider finished every run, test
 * finished, wrong gate, unknown tag).
 */
export class EnduroCrossingRejected extends Error {}

export type TimeCheckTarget = { raceClass: string; durationMs: number; startTimeOfDay?: string | null };
export type EnduroPenaltyConfig = {
  earlySecPerMin: number;
  lateSecPerMin: number;
  earlyDqMinutes: number | null;
  lateDqMinutes: number | null;
  timezone: string | null;
};

export interface EnduroRun<T> {
  start: T;
  finish: T;
  elapsedMs: number;
}

/**
 * Pair a rider's crossings on one test into runs: START, FINISH, START, ...
 * Pairing follows insertion order (id), not timestamps, because clock skew
 * between an RFID start and a manual finish can make a finish sort before its
 * own start. Elapsed time is clamped at 0.
 */
export function pairEnduroRuns<T extends { id: number; crossingTime: Date | string }>(crossings: T[]): {
  runs: EnduroRun<T>[];
  open: T | null;
  numbered: Array<{ crossing: T; runNumber: number; isFinish: boolean; elapsedMs: number }>;
} {
  const ordered = [...crossings].sort((a, b) => a.id - b.id);
  const runs: EnduroRun<T>[] = [];
  const numbered: Array<{ crossing: T; runNumber: number; isFinish: boolean; elapsedMs: number }> = [];
  for (let i = 0; i < ordered.length; i++) {
    const isFinish = i % 2 === 1;
    const runNumber = Math.floor(i / 2) + 1;
    let elapsedMs = 0;
    if (isFinish) {
      const start = ordered[i - 1];
      elapsedMs = Math.max(0, new Date(ordered[i].crossingTime).getTime() - new Date(start.crossingTime).getTime());
      runs.push({ start, finish: ordered[i], elapsedMs });
    }
    numbered.push({ crossing: ordered[i], runNumber, isFinish, elapsedMs });
  }
  const open = ordered.length % 2 === 1 ? ordered[ordered.length - 1] : null;
  return { runs, open, numbered };
}

const sum = (xs: number[]) => xs.reduce((s, x) => s + x, 0);
const validRuns = (xs: unknown): number[] =>
  (Array.isArray(xs) ? xs : []).map(Number).filter((x) => Number.isFinite(x) && x >= 0);

export interface EnduroTestEntry {
  id: number;
  raceClass: string;
  /** Completed run times (ms). */
  runTimesMs: number[];
  dnf?: boolean;
  dns?: boolean;
  /** Time-check disqualification (event-wide). */
  disqualified?: boolean;
}

function testGroup(e: EnduroTestEntry): number {
  if (e.disqualified) return 4;
  if (e.dns) return 3;
  if (e.dnf) return 2;
  return validRuns(e.runTimesMs).length === 0 ? 1 : 0;
}

/**
 * Positions on one test, computed within each class. Ranked by completed runs
 * (more first), then total time of those runs. Riders with no completed run,
 * then DNF, DNS and time-check DQ follow. Only truly equal riders (same runs
 * and same total) share a position. Returns id → position.
 */
export function rankEnduroTest(entries: EnduroTestEntry[]): Map<number, number> {
  const out = new Map<number, number>();
  const byClass = new Map<string, EnduroTestEntry[]>();
  for (const e of entries) {
    const cls = (e.raceClass ?? "").trim();
    if (!byClass.has(cls)) byClass.set(cls, []);
    byClass.get(cls)!.push(e);
  }
  for (const list of byClass.values()) {
    const keyed = list.map((e) => {
      const runs = validRuns(e.runTimesMs);
      return { e, group: testGroup(e), runs: runs.length, total: sum(runs) };
    });
    keyed.sort((a, b) =>
      a.group - b.group
      || (a.group === 0 ? b.runs - a.runs || a.total - b.total : 0)
      || a.e.id - b.e.id);
    let prev: (typeof keyed)[number] | null = null;
    let prevPos = 0;
    keyed.forEach((k, i) => {
      const tied = prev != null && k.group === 0 && prev.group === 0 && k.runs === prev.runs && k.total === prev.total;
      const pos = tied ? prevPos : i + 1;
      out.set(k.e.id, pos);
      prev = k;
      prevPos = pos;
    });
  }
  return out;
}

// ── Time-check penalties ─────────────────────────────────────────────────────

function parseTimeMinutes(s: string | null | undefined): number | null {
  if (!s) return null;
  const m = s.match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  return parseInt(m[1], 10) * 60 + parseInt(m[2], 10);
}

function extractTimeOfDayMins(d: Date, tz: string | null | undefined): number {
  if (tz) {
    try {
      const parts = new Intl.DateTimeFormat("en-US", {
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        hour12: false,
        timeZone: tz,
      }).formatToParts(d);
      const get = (type: string) => parseInt(parts.find((p) => p.type === type)?.value ?? "0", 10);
      const h = get("hour") % 24;
      return h * 60 + get("minute") + get("second") / 60;
    } catch {
      // Fall through to local time if the timezone string is invalid.
    }
  }
  return d.getHours() * 60 + d.getMinutes() + d.getSeconds() / 60;
}

export function computeEnduroPenalty(
  arrivalTime: Date,
  target: TimeCheckTarget,
  config: EnduroPenaltyConfig,
): { penaltySeconds: number; disqualified: boolean; diffMinutes: number } {
  const startMins = parseTimeMinutes(target.startTimeOfDay);
  if (startMins == null) return { penaltySeconds: 0, disqualified: false, diffMinutes: 0 };
  const expectedMins = startMins + target.durationMs / 60_000;
  const actualMins = extractTimeOfDayMins(arrivalTime, config.timezone);
  const diffMinutes = actualMins - expectedMins;
  if (diffMinutes > 0) {
    if (config.lateDqMinutes != null && diffMinutes > config.lateDqMinutes) return { penaltySeconds: 0, disqualified: true, diffMinutes };
    return { penaltySeconds: Math.floor(diffMinutes) * config.lateSecPerMin, disqualified: false, diffMinutes };
  } else if (diffMinutes < 0) {
    const minsEarly = -diffMinutes;
    if (config.earlyDqMinutes != null && minsEarly > config.earlyDqMinutes) return { penaltySeconds: 0, disqualified: true, diffMinutes };
    return { penaltySeconds: Math.floor(minsEarly) * config.earlySecPerMin, disqualified: false, diffMinutes };
  }
  return { penaltySeconds: 0, disqualified: false, diffMinutes: 0 };
}

/**
 * Each rider's class at an enduro event: a checked-in entry first, then any
 * check-in row, then a non-void registration (earliest row of each wins).
 */
export function loadEnduroRiderClasses(eventId: number): Map<number, string> {
  const db = getDb();
  const checkins = db
    .prepare("SELECT rider_id, race_class, checked_in FROM checkins WHERE event_id = ? ORDER BY id")
    .all(eventId) as Array<{ rider_id: number; race_class: string | null; checked_in: number }>;
  const regs = db
    .prepare("SELECT rider_id, race_class FROM registrations WHERE event_id = ? AND status != 'void' ORDER BY id")
    .all(eventId) as Array<{ rider_id: number; race_class: string | null }>;
  const out = new Map<number, string>();
  const usable = (cls: string | null | undefined): cls is string =>
    !!cls && cls.trim() !== "" && cls.trim() !== ENDURO_ALL_CLASSES;
  for (const c of checkins) if (c.checked_in === 1 && usable(c.race_class) && !out.has(c.rider_id)) out.set(c.rider_id, c.race_class.trim());
  for (const c of checkins) if (usable(c.race_class) && !out.has(c.rider_id)) out.set(c.rider_id, c.race_class.trim());
  for (const r of regs) if (usable(r.race_class) && !out.has(r.rider_id)) out.set(r.rider_id, r.race_class.trim());
  return out;
}

/** One rider's enduro class, falling back to `fallback` (e.g. the stored result class). */
export function resolveEnduroRiderClass(eventId: number, riderId: number, fallback: string): string {
  return loadEnduroRiderClasses(eventId).get(riderId) ?? fallback;
}

/** Time-check penalty totals per rider. Empty when the event has no penalty config. */
export function fetchEnduroPenaltyMap(eventId: number): Map<number, { penaltySeconds: number; disqualified: boolean }> {
  const db = getDb();
  const ev = db.prepare("SELECT enduro_penalty_config FROM events WHERE id = ?").get(eventId) as
    | { enduro_penalty_config: string | null }
    | undefined;
  const config = parseJson<EnduroPenaltyConfig | null>(ev?.enduro_penalty_config, null);
  if (!config) return new Map();
  const checks = db
    .prepare("SELECT * FROM enduro_time_checks WHERE event_id = ? ORDER BY check_number ASC")
    .all(eventId) as any[];
  if (checks.length === 0) return new Map();
  const arrivals = db
    .prepare("SELECT rider_id, time_check_id, arrival_time FROM enduro_checkpoint_arrivals WHERE event_id = ?")
    .all(eventId) as Array<{ rider_id: number; time_check_id: number; arrival_time: string }>;
  const riderClasses = loadEnduroRiderClasses(eventId);

  const byRider = new Map<number, typeof arrivals>();
  for (const a of arrivals) {
    if (!byRider.has(a.rider_id)) byRider.set(a.rider_id, []);
    byRider.get(a.rider_id)!.push(a);
  }
  const result = new Map<number, { penaltySeconds: number; disqualified: boolean }>();
  for (const [riderId, riderArrivals] of byRider) {
    const raceClass = riderClasses.get(riderId) ?? null;
    let penaltySeconds = 0;
    let disqualified = false;
    for (const check of checks) {
      const target = parseJsonArr<TimeCheckTarget>(check.targets).find((t) => t.raceClass === raceClass);
      if (!target?.startTimeOfDay) continue;
      const arrival = riderArrivals.find((a) => a.time_check_id === check.id);
      if (!arrival) continue;
      const pen = computeEnduroPenalty(new Date(arrival.arrival_time), target, config);
      penaltySeconds += pen.penaltySeconds;
      if (pen.disqualified) disqualified = true;
    }
    result.set(riderId, { penaltySeconds, disqualified });
  }
  return result;
}

/**
 * Re-rank one enduro test: positions within each rider class by completed
 * runs, then total time of those runs. A time-check DQ ranks last.
 */
export function rerankEnduroTest(
  motoId: number,
  penaltyMap?: Map<number, { penaltySeconds: number; disqualified: boolean }>,
): void {
  const db = getDb();
  const results = db.prepare("SELECT * FROM race_results WHERE moto_id = ?").all(motoId) as any[];
  if (results.length === 0) return;
  const penalties = penaltyMap ?? fetchEnduroPenaltyMap(results[0].event_id);
  const positions = rankEnduroTest(results.map((r) => ({
    id: r.id,
    raceClass: r.race_class ?? "",
    runTimesMs: parseJsonArr<number>(r.lap_times),
    dnf: r.dnf === 1,
    dns: r.dns === 1,
    disqualified: penalties.get(r.rider_id)?.disqualified ?? false,
  })));
  const update = db.prepare("UPDATE race_results SET position = ? WHERE id = ?");
  for (const r of results) {
    const position = positions.get(r.id);
    if (position != null && position !== r.position) update.run(position, r.id);
  }
}

/**
 * Re-rank every enduro test in an event. Call after a checkpoint arrival is
 * created, updated, or deleted so time-check DQs show immediately.
 */
export function recomputeEnduroPositionsForEvent(eventId: number): void {
  const db = getDb();
  const motos = db.prepare("SELECT id FROM motos WHERE event_id = ? AND type = 'enduro_test'").all(eventId) as Array<{ id: number }>;
  if (motos.length === 0) return;
  const penaltyMap = fetchEnduroPenaltyMap(eventId);
  db.transaction(() => {
    for (const moto of motos) rerankEnduroTest(moto.id, penaltyMap);
  })();
}
