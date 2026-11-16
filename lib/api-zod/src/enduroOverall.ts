/**
 * Sprint-enduro scoring, as pure functions (no database).
 *
 * An event has several special tests (motos with type "enduro_test"). Each
 * rider runs every test `lapCount` times; a run is a START read followed by a
 * FINISH read. A rider's test time is the SUM of their completed runs, and the
 * event overall per class is the sum of every test time plus time-check
 * penalties, lowest first. Riders who did not complete every run of every test
 * rank after those who did (more completed runs first, then lower time).
 */

/** A start read with no finish after this long is not treated as a finish by hardware reads. */
export const ENDURO_MAX_RUN_MS = 30 * 60_000;

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

// ── One test ───────────────────────────────────────────────────────────────

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

// ── Event overall ──────────────────────────────────────────────────────────

export interface EnduroOverallTest {
  motoId: number;
  motoNumber: number;
  name?: string;
  /** Runs each rider must complete on this test (the test's lapCount, at least 1). */
  requiredRuns: number;
}

export interface EnduroOverallResultInput {
  motoId: number;
  riderId: number;
  runTimesMs: number[];
  dnf?: boolean;
  dns?: boolean;
}

export interface EnduroOverallRiderInput {
  riderId: number;
  raceClass: string;
  penaltySeconds?: number;
  disqualified?: boolean;
}

export interface EnduroOverallTestCell {
  motoId: number;
  /** Sum of completed runs; null when DNF/DNS or no run completed. */
  timeMs: number | null;
  runs: number;
  requiredRuns: number;
  dnf: boolean;
  dns: boolean;
  /** Every run of this test completed (and not DNF/DNS). */
  complete: boolean;
}

export type EnduroOverallStatus = "classified" | "incomplete" | "no_time" | "dq";

export interface EnduroOverallRow {
  position: number;
  riderId: number;
  raceClass: string;
  tests: EnduroOverallTestCell[];
  testTimeMs: number;
  penaltyMs: number;
  totalMs: number;
  completedRuns: number;
  requiredRuns: number;
  disqualified: boolean;
  status: EnduroOverallStatus;
}

const STATUS_ORDER: Record<EnduroOverallStatus, number> = { classified: 0, incomplete: 1, no_time: 2, dq: 3 };

/**
 * Compare two riders of the same class; negative when `a` ranks ahead.
 * Ties on runs and total go to the better time in the latest test (highest
 * motoNumber) that both completed; 0 means truly equal.
 */
export function compareEnduroOverall(a: EnduroOverallRow, b: EnduroOverallRow, tests: EnduroOverallTest[]): number {
  const g = STATUS_ORDER[a.status] - STATUS_ORDER[b.status];
  if (g !== 0) return g;
  if (a.status === "dq" || a.status === "no_time") return 0;
  if (a.completedRuns !== b.completedRuns) return b.completedRuns - a.completedRuns;
  if (a.totalMs !== b.totalMs) return a.totalMs - b.totalMs;
  const latestFirst = [...tests].sort((x, y) => y.motoNumber - x.motoNumber || y.motoId - x.motoId);
  for (const t of latestFirst) {
    const ca = a.tests.find((c) => c.motoId === t.motoId);
    const cb = b.tests.find((c) => c.motoId === t.motoId);
    if (ca?.complete && cb?.complete && ca.timeMs != null && cb.timeMs != null) {
      return ca.timeMs - cb.timeMs;
    }
  }
  return 0;
}

/**
 * Per-class event overall. Only riders with at least one result appear. A
 * DNF/DNS test result counts no runs and no time for that test.
 */
export function computeEnduroOverall(
  tests: EnduroOverallTest[],
  results: EnduroOverallResultInput[],
  riders: EnduroOverallRiderInput[],
): Array<{ raceClass: string; riders: EnduroOverallRow[] }> {
  const orderedTests = [...tests].sort((a, b) => a.motoNumber - b.motoNumber || a.motoId - b.motoId);
  const requiredRuns = sum(orderedTests.map((t) => Math.max(1, t.requiredRuns)));
  const riderInfo = new Map(riders.map((r) => [r.riderId, r]));
  const testIds = new Set(orderedTests.map((t) => t.motoId));

  const byRider = new Map<number, EnduroOverallResultInput[]>();
  for (const r of results) {
    if (!testIds.has(r.motoId)) continue;
    if (!byRider.has(r.riderId)) byRider.set(r.riderId, []);
    byRider.get(r.riderId)!.push(r);
  }

  const rows: EnduroOverallRow[] = [];
  for (const [riderId, mine] of byRider) {
    const info = riderInfo.get(riderId);
    const cells: EnduroOverallTestCell[] = orderedTests.map((t) => {
      const req = Math.max(1, t.requiredRuns);
      const r = mine.find((x) => x.motoId === t.motoId);
      const dnf = !!r?.dnf;
      const dns = !!r?.dns;
      // Never count more runs than the test allows.
      const runs = dnf || dns || !r ? [] : validRuns(r.runTimesMs).slice(0, req);
      return {
        motoId: t.motoId,
        timeMs: runs.length > 0 ? sum(runs) : null,
        runs: runs.length,
        requiredRuns: req,
        dnf,
        dns,
        complete: runs.length >= req,
      };
    });
    const completedRuns = sum(cells.map((c) => c.runs));
    const testTimeMs = sum(cells.map((c) => c.timeMs ?? 0));
    const penaltyMs = Math.max(0, Math.round((info?.penaltySeconds ?? 0) * 1000));
    const disqualified = !!info?.disqualified;
    const status: EnduroOverallStatus = disqualified ? "dq"
      : completedRuns === 0 ? "no_time"
      : completedRuns >= requiredRuns ? "classified"
      : "incomplete";
    rows.push({
      position: 0,
      riderId,
      raceClass: (info?.raceClass ?? "Unknown").trim() || "Unknown",
      tests: cells,
      testTimeMs,
      penaltyMs,
      totalMs: testTimeMs + penaltyMs,
      completedRuns,
      requiredRuns,
      disqualified,
      status,
    });
  }

  const byClass = new Map<string, EnduroOverallRow[]>();
  for (const row of rows) {
    if (!byClass.has(row.raceClass)) byClass.set(row.raceClass, []);
    byClass.get(row.raceClass)!.push(row);
  }

  return [...byClass.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([raceClass, list]) => {
      list.sort((a, b) => compareEnduroOverall(a, b, orderedTests) || a.riderId - b.riderId);
      list.forEach((row, i) => {
        const prev = list[i - 1];
        const unranked = row.status === "dq" || row.status === "no_time";
        row.position = i > 0 && !unranked && compareEnduroOverall(prev, row, orderedTests) === 0
          ? prev.position
          : i + 1;
      });
      return { raceClass, riders: list };
    });
}
