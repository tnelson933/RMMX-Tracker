import { db } from "@workspace/db";
import { eventsTable, motosTable, pointsTablesTable, raceResultsTable, ridersTable } from "@workspace/db";
import { and, asc, eq, inArray, ne } from "drizzle-orm";
import { buildEnduroEventOverall, buildEventOverall } from "@workspace/api-zod";
import type { EnduroOverallTestInfo, EventOverallRider } from "@workspace/api-zod";
import { compareOverall, isLowerBetter, olympicPenalty, overallPositions } from "./overallOrder";
import { fetchEnduoPenaltyMap, loadEnduroRiderClasses } from "../routes/enduro-scoring";

/** Whether the event's scoring table is Olympic (lowest total wins). */
export async function eventLowerIsBetter(eventId: number): Promise<boolean> {
  const [row] = await db.select({ method: pointsTablesTable.scoringMethod })
    .from(eventsTable)
    .leftJoin(pointsTablesTable, eq(pointsTablesTable.id, eventsTable.scoringTableId))
    .where(eq(eventsTable.id, eventId));
  return isLowerBetter(row?.method);
}

// The standings rules are pure and live in the shared package: the desktop's
// offline server runs the same code on its own rows.
export type { EventOverallRider, EnduroOverallTestInfo };

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

  const { classes, hasPoints } = buildEventOverall(motos.map(m => m.id), rows, lowerIsBetter, { compareOverall, overallPositions, olympicPenalty });
  return { classes, hasPoints, lowerIsBetter };
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
  if (tests.length === 0) return buildEnduroEventOverall(tests, [], new Map(), new Map());

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

  return buildEnduroEventOverall(tests, rows, riderClasses, penalties);
}
