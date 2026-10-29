import { db } from "@workspace/db";
import { eventsTable, motosTable, pointsTablesTable, raceResultsTable, ridersTable } from "@workspace/db";
import { and, asc, eq, inArray, ne } from "drizzle-orm";
import { compareOverall, isLowerBetter, olympicPenalty, overallPositions, type OverallRow } from "./overallOrder";
import { computeEnduroOverall, type EnduroOverallRow } from "./enduroOverall";
import { fetchEnduoPenaltyMap, loadEnduroRiderClasses } from "../routes/enduro-scoring";

/** Whether the event's scoring table is Olympic (lowest total wins). */
export async function eventLowerIsBetter(eventId: number): Promise<boolean> {
  const [row] = await db.select({ method: pointsTablesTable.scoringMethod })
    .from(eventsTable)
    .leftJoin(pointsTablesTable, eq(pointsTablesTable.id, eventsTable.scoringTableId))
    .where(eq(eventsTable.id, eventId));
  return isLowerBetter(row?.method);
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

/**
 * Overall standings per class for an event, from its finished races
 * (practice excluded). Points tables: highest total first. Olympic: lowest
 * total, DNF/DNS/missed motos score penalties, ties go to the last moto.
 */
export async function computeEventOverall(eventId: number): Promise<{
  classes: Array<{ raceClass: string; riders: EventOverallRider[] }>;
  hasPoints: boolean;
  lowerIsBetter: boolean;
  /** "enduro": classes are ranked by total time (tests + time-check penalties). */
  format?: "enduro";
  enduroTests?: EnduroOverallTestInfo[];
  /** Enduro: every counted test's results are finalized. */
  official?: boolean;
}> {
  const lowerIsBetter = await eventLowerIsBetter(eventId);
  const [evt] = await db.select({ raceStyle: eventsTable.raceStyle }).from(eventsTable).where(eq(eventsTable.id, eventId));
  if (evt?.raceStyle === "enduro") return { ...(await computeEnduroEventOverall(eventId)), lowerIsBetter };
  const motos = await db.select().from(motosTable)
    .where(and(eq(motosTable.eventId, eventId), eq(motosTable.status, "completed"), ne(motosTable.type, "practice")))
    .orderBy(asc(motosTable.motoNumber), asc(motosTable.id));
  if (motos.length === 0) return { classes: [], hasPoints: false, lowerIsBetter };

  const rows = await db.select({
    motoId: raceResultsTable.motoId,
    riderId: raceResultsTable.riderId,
    raceClass: raceResultsTable.raceClass,
    position: raceResultsTable.position,
    points: raceResultsTable.points,
    dnf: raceResultsTable.dnf,
    dns: raceResultsTable.dns,
    bibNumber: raceResultsTable.bibNumber,
    firstName: ridersTable.firstName,
    lastName: ridersTable.lastName,
  }).from(raceResultsTable)
    .leftJoin(ridersTable, eq(raceResultsTable.riderId, ridersTable.id))
    .where(inArray(raceResultsTable.motoId, motos.map(m => m.id)));

  const classSize = new Map<number, number>();
  for (const r of rows) classSize.set(r.motoId, (classSize.get(r.motoId) ?? 0) + 1);
  const hasPoints = lowerIsBetter || rows.some(r => (r.points ?? 0) > 0);

  const classes = new Map<string, typeof rows>();
  for (const r of rows) {
    const cls = (r.raceClass ?? "Unknown").trim();
    if (!classes.has(cls)) classes.set(cls, []);
    classes.get(cls)!.push(r);
  }

  const out: Array<{ raceClass: string; riders: EventOverallRider[] }> = [];
  for (const [raceClass, classRows] of [...classes.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const classMotoIds = motos.map(m => m.id).filter(id => classRows.some(r => r.motoId === id));
    const riders = new Map<number, typeof classRows>();
    for (const r of classRows) {
      if (!riders.has(r.riderId)) riders.set(r.riderId, []);
      riders.get(r.riderId)!.push(r);
    }
    const entries = [...riders.entries()].map(([riderId, mine]) => {
      let total = 0;
      let lastMotoFinish: number | null = null;
      for (const motoId of classMotoIds) {
        const r = mine.find(x => x.motoId === motoId);
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
      const order: OverallRow = { total, finishedAny: finishes.length > 0, lastMotoFinish };
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
  return { classes: out, hasPoints, lowerIsBetter };
}

/**
 * Enduro event overall per class from finished tests: sum of every test's
 * completed runs plus time-check penalties, lowest first (lib/enduroOverall.ts).
 * Riders are placed in their registered/checked-in class (tests themselves are
 * created for "All Classes"). totalPoints is the event points stored on the
 * rider's results (one award per event; see scoreEnduroEventPoints).
 */
export async function computeEnduroEventOverall(eventId: number): Promise<{
  classes: Array<{ raceClass: string; riders: EventOverallRider[] }>;
  hasPoints: boolean;
  format: "enduro";
  enduroTests: EnduroOverallTestInfo[];
  official: boolean;
}> {
  const tests = await db.select().from(motosTable)
    .where(and(eq(motosTable.eventId, eventId), eq(motosTable.status, "completed"), eq(motosTable.type, "enduro_test")))
    .orderBy(asc(motosTable.motoNumber), asc(motosTable.id));
  const enduroTests: EnduroOverallTestInfo[] = tests.map((t) => ({
    motoId: t.id,
    name: t.name,
    motoNumber: t.motoNumber ?? 0,
    requiredRuns: Math.max(1, t.lapCount ?? 1),
    official: t.resultsFinalizedAt != null,
  }));
  if (tests.length === 0) return { classes: [], hasPoints: false, format: "enduro", enduroTests, official: false };

  const [rows, riderClasses, penalties] = await Promise.all([
    db.select({
      motoId: raceResultsTable.motoId,
      riderId: raceResultsTable.riderId,
      raceClass: raceResultsTable.raceClass,
      position: raceResultsTable.position,
      points: raceResultsTable.points,
      lapTimes: raceResultsTable.lapTimes,
      dnf: raceResultsTable.dnf,
      dns: raceResultsTable.dns,
      bibNumber: raceResultsTable.bibNumber,
      firstName: ridersTable.firstName,
      lastName: ridersTable.lastName,
    }).from(raceResultsTable)
      .leftJoin(ridersTable, eq(raceResultsTable.riderId, ridersTable.id))
      .where(inArray(raceResultsTable.motoId, tests.map((t) => t.id))),
    loadEnduroRiderClasses(eventId),
    fetchEnduoPenaltyMap(eventId),
  ]);

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
