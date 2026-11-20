/**
 * Event overall standings per class, as pure functions (no database). The
 * cloud API and the desktop's offline server each load the rows and call
 * these, so both return the same standings for the same data.
 */
import { computeEnduroOverall, type EnduroOverallRow } from "./enduroOverall";

/**
 * The overall-order rules (lib/overallOrder.ts in each server: the copies are
 * kept identical by overallOrder.parity.test.ts), passed in by the caller.
 */
export interface OverallOrderRow {
  total: number;
  finishedAny: boolean;
  lastMotoFinish: number | null;
  /** Raced the class's main event (set when the class ran one). */
  reachedMain?: boolean;
  /** Outcome of each moto the rider has a result in, last first: 0 finished, 1 DNF, 2 DNS. */
  motoStatuses?: number[];
}
export interface OverallOrderRules {
  compareOverall(a: OverallOrderRow, b: OverallOrderRow, lowerIsBetter: boolean): number;
  overallPositions(sorted: OverallOrderRow[], lowerIsBetter: boolean): number[];
  olympicPenalty(kind: "dnf" | "dns", classSize: number): number;
}

export interface EventOverallRider {
  position: number;
  riderId: number;
  riderName: string;
  bibNumber: string | null;
  totalPoints: number;
  motosRaced: number;
  bestPosition: number | null;
  /** Enduro events only: each test's time, penalties and the overall total. */
  enduro?: Omit<EnduroOverallRow, "position" | "riderId" | "raceClass">;
}

export interface EnduroOverallTestInfo {
  motoId: number;
  name: string;
  motoNumber: number;
  requiredRuns: number;
  official: boolean;
}

export interface EventOverall {
  classes: Array<{ raceClass: string; riders: EventOverallRider[] }>;
  hasPoints: boolean;
  lowerIsBetter: boolean;
  /** "enduro": classes are ranked by total time (tests + time-check penalties). */
  format?: "enduro";
  enduroTests?: EnduroOverallTestInfo[];
  /** Enduro: every counted test's results are finalized. */
  official?: boolean;
}

/** One result of a finished race, with the rider's name. */
export interface EventOverallResultRow {
  motoId: number;
  riderId: number;
  raceClass: string | null;
  position: number;
  points: number | null;
  dnf: boolean;
  dns: boolean;
  bibNumber: string | null;
  firstName: string | null;
  lastName: string | null;
}

/**
 * Overall standings per class from an event's finished races (practice
 * excluded). `motoIds` are those races in running order. Points tables:
 * highest total first. Olympic: lowest total, DNF/DNS/missed motos score
 * penalties (from each moto's starters), ties go to the last moto. On equal
 * totals a rider who raced the main event (`mainMotoIds`, Supercross format)
 * ranks ahead of one who didn't, and a DNF ahead of a DNS (overallOrder.ts).
 */
export function buildEventOverall(
  motoIds: number[],
  rows: EventOverallResultRow[],
  lowerIsBetter: boolean,
  rules: OverallOrderRules,
  mainMotoIds: number[] = [],
): { classes: Array<{ raceClass: string; riders: EventOverallRider[] }>; hasPoints: boolean } {
  const { compareOverall, overallPositions, olympicPenalty } = rules;
  // Olympic DNF/DNS penalties count each moto's starters (riders who aren't DNS).
  const classSize = new Map<number, number>();
  for (const r of rows) if (!r.dns) classSize.set(r.motoId, (classSize.get(r.motoId) ?? 0) + 1);
  const mains = new Set(mainMotoIds);
  const hasPoints = lowerIsBetter || rows.some(r => (r.points ?? 0) > 0);

  const classes = new Map<string, EventOverallResultRow[]>();
  for (const r of rows) {
    const cls = (r.raceClass ?? "Unknown").trim();
    if (!classes.has(cls)) classes.set(cls, []);
    classes.get(cls)!.push(r);
  }

  const out: Array<{ raceClass: string; riders: EventOverallRider[] }> = [];
  for (const [raceClass, classRows] of [...classes.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const classMotoIds = motoIds.filter(id => classRows.some(r => r.motoId === id));
    const classRanMain = classMotoIds.some(id => mains.has(id));
    const riders = new Map<number, EventOverallResultRow[]>();
    for (const r of classRows) {
      if (!riders.has(r.riderId)) riders.set(r.riderId, []);
      riders.get(r.riderId)!.push(r);
    }
    const entries = [...riders.entries()].map(([riderId, mine]) => {
      let total = 0;
      let lastMotoFinish: number | null = null;
      const motoStatuses: number[] = [];
      for (const motoId of classMotoIds) {
        const r = mine.find(x => x.motoId === motoId);
        if (r) motoStatuses.unshift(r.dns ? 2 : r.dnf ? 1 : 0);
        const finished = r && !r.dnf && !r.dns ? r.position : null;
        if (lowerIsBetter) {
          total += !r ? olympicPenalty("dns", classSize.get(motoId) ?? 0)
            : r.dns ? olympicPenalty("dns", classSize.get(motoId) ?? 0)
            : r.dnf ? olympicPenalty("dnf", classSize.get(motoId) ?? 0)
            : r.points ?? r.position;
        } else if (r && !r.dnf && !r.dns) {
          total += r.points ?? 0;
        }
        lastMotoFinish = finished ?? null;
      }
      const finishes = mine.filter(r => !r.dnf && !r.dns).map(r => r.position);
      const order: OverallOrderRow = {
        total, finishedAny: finishes.length > 0, lastMotoFinish, motoStatuses,
        ...(classRanMain ? { reachedMain: mine.some(r => mains.has(r.motoId)) } : {}),
      };
      return {
        order,
        bestPosition: finishes.length ? Math.min(...finishes) : null,
        rider: {
          position: 0,
          riderId,
          riderName: [mine[0].firstName, mine[0].lastName].filter(Boolean).join(" ") || `Rider #${riderId}`,
          bibNumber: mine[0].bibNumber ?? null,
          totalPoints: total,
          motosRaced: mine.filter(r => !r.dns).length,
          bestPosition: finishes.length ? Math.min(...finishes) : null,
        },
      };
    });
    // Points tables with no points yet: order by best finish.
    entries.sort((a, b) => (hasPoints ? compareOverall(a.order, b.order, lowerIsBetter) : 0)
      || (a.bestPosition ?? 999) - (b.bestPosition ?? 999));
    const positions = hasPoints ? overallPositions(entries.map(e => e.order), lowerIsBetter) : entries.map((_, i) => i + 1);
    out.push({ raceClass, riders: entries.map((e, i) => ({ ...e.rider, position: positions[i] })) });
  }
  return { classes: out, hasPoints };
}

/** A finished enduro test (a moto with type "enduro_test"), in running order. */
export interface EnduroEventTest {
  id: number;
  name: string;
  motoNumber: number | null;
  lapCount: number | null;
  /** Set once the test's results are finalized. */
  resultsFinalizedAt: unknown;
}

/** One result on an enduro test; `lapTimes` holds the completed run times (ms). */
export interface EnduroEventResultRow extends EventOverallResultRow {
  raceClass: string;
  lapTimes: unknown;
}

/**
 * Enduro event overall per class from finished tests: sum of every test's
 * completed runs plus time-check penalties, lowest first (enduroOverall.ts).
 * Riders are placed in their registered/checked-in class (`riderClasses`;
 * tests themselves are created for "All Classes"). totalPoints is the event
 * points stored on the rider's results (one award per event).
 */
export function buildEnduroEventOverall(
  tests: EnduroEventTest[],
  rows: EnduroEventResultRow[],
  riderClasses: Map<number, string>,
  penalties: Map<number, { penaltySeconds: number; disqualified: boolean }>,
): {
  classes: Array<{ raceClass: string; riders: EventOverallRider[] }>;
  hasPoints: boolean;
  format: "enduro";
  enduroTests: EnduroOverallTestInfo[];
  official: boolean;
} {
  const enduroTests: EnduroOverallTestInfo[] = tests.map((t) => ({
    motoId: t.id,
    name: t.name,
    motoNumber: t.motoNumber ?? 0,
    requiredRuns: Math.max(1, t.lapCount ?? 1),
    official: t.resultsFinalizedAt != null,
  }));
  if (tests.length === 0) return { classes: [], hasPoints: false, format: "enduro", enduroTests, official: false };

  const riderIds = [...new Set(rows.map((r) => r.riderId))];
  const overall = computeEnduroOverall(
    enduroTests,
    rows.map((r) => ({
      motoId: r.motoId,
      riderId: r.riderId,
      runTimesMs: Array.isArray(r.lapTimes) ? (r.lapTimes as number[]) : [],
      dnf: r.dnf,
      dns: r.dns,
    })),
    riderIds.map((riderId) => ({
      riderId,
      raceClass: riderClasses.get(riderId) ?? rows.find((r) => r.riderId === riderId)!.raceClass,
      penaltySeconds: penalties.get(riderId)?.penaltySeconds ?? 0,
      disqualified: penalties.get(riderId)?.disqualified ?? false,
    })),
  );

  const classes = overall.map(({ raceClass, riders }) => ({
    raceClass,
    riders: riders.map((row): EventOverallRider => {
      const mine = rows.filter((r) => r.riderId === row.riderId);
      const finishes = mine.filter((r) => !r.dnf && !r.dns && (r.lapTimes as unknown[] | null)?.length).map((r) => r.position);
      const { position, riderId, raceClass: _cls, ...enduro } = row;
      return {
        position,
        riderId,
        riderName: [mine[0]?.firstName, mine[0]?.lastName].filter(Boolean).join(" ") || `Rider #${riderId}`,
        bibNumber: mine.find((r) => r.bibNumber)?.bibNumber ?? null,
        totalPoints: mine.reduce((sum, r) => sum + (r.points ?? 0), 0),
        motosRaced: row.tests.filter((t) => t.runs > 0).length,
        bestPosition: finishes.length ? Math.min(...finishes) : null,
        enduro,
      };
    }),
  }));
  return {
    classes,
    hasPoints: rows.some((r) => (r.points ?? 0) > 0),
    format: "enduro",
    enduroTests,
    official: enduroTests.every((t) => t.official),
  };
}
