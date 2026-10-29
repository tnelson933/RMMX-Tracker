import { db } from "@workspace/db";
import { eventsTable, motosTable, pointsTablesTable, raceResultsTable, ridersTable } from "@workspace/db";
import { and, asc, eq, inArray, ne } from "drizzle-orm";
import { compareOverall, isLowerBetter, olympicPenalty, overallPositions, type OverallRow } from "./overallOrder";

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
}> {
  const lowerIsBetter = await eventLowerIsBetter(eventId);
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
