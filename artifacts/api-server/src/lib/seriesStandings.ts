import { db } from "@workspace/db";
import { eventsTable, motosTable, raceResultsTable, ridersTable, seriesTable } from "@workspace/db";
import { and, eq, inArray, ne } from "drizzle-orm";
import { loadSeriesScoring } from "./scoringTables";
import { buildSeriesStandings, orderSeriesRounds, type SeriesStandingRow } from "./seriesStandingsCore";

type Series = typeof seriesTable.$inferSelect;

/**
 * Which events and classes count toward a series. Used by every series
 * calculation (standings pages and the stored series_points) so they agree.
 *
 * An event counts when it is in `series.eventIds` or one of its classes is
 * linked to the series in `raceClassSeriesMap`. When any class of an event is
 * linked, only linked classes count; otherwise (older events) every class does.
 */
export async function seriesScope(series: Series): Promise<{
  eventIds: number[];
  eligibleClasses: Map<number, Set<string> | null>;
}> {
  const listed = [...new Set(((series.eventIds as number[]) ?? []).map(Number).filter(Number.isFinite))];
  const clubEvents = await db.select({ id: eventsTable.id, map: eventsTable.raceClassSeriesMap, date: eventsTable.date })
    .from(eventsTable).where(eq(eventsTable.clubId, series.clubId));

  const eligibleClasses = new Map<number, Set<string> | null>();
  const linkedOnly: number[] = [];
  for (const evt of clubEvents) {
    const map = (evt.map ?? {}) as Record<string, number[]>;
    const classes = new Set<string>();
    for (const [cls, ids] of Object.entries(map)) {
      if (Array.isArray(ids) && ids.map(Number).includes(series.id)) classes.add(cls.trim());
    }
    if (classes.size > 0) {
      eligibleClasses.set(evt.id, classes);
      if (!listed.includes(evt.id)) linkedOnly.push(evt.id);
    } else if (listed.includes(evt.id)) {
      eligibleClasses.set(evt.id, null);
    }
  }
  // Events from another club never count, even if listed. Rounds run in date
  // order, however they were added to the series.
  const counted = new Set([...listed.filter(id => eligibleClasses.has(id)), ...linkedOnly]);
  const eventIds = orderSeriesRounds(clubEvents.filter(e => counted.has(e.id)));
  return { eventIds, eligibleClasses };
}

export { motoCounts } from "./seriesStandingsCore";
export type { SeriesStandingRow } from "./seriesStandingsCore";

/**
 * Series standings per class from the points stored on each result. Finished
 * races are public; `official` says whether a class's races are all finalized.
 * The rules are pure and live in lib/seriesStandingsCore.ts.
 */
export async function computeSeriesStandings(series: Series): Promise<{ standings: SeriesStandingRow[]; eventIds: number[] }> {
  const { eventIds, eligibleClasses } = await seriesScope(series);
  if (eventIds.length === 0) return { standings: [], eventIds };

  const events = await db.select({ id: eventsTable.id, name: eventsTable.name })
    .from(eventsTable).where(inArray(eventsTable.id, eventIds));

  const motos = await db.select().from(motosTable)
    .where(and(
      inArray(motosTable.eventId, eventIds),
      eq(motosTable.status, "completed"),
      ne(motosTable.type, "practice"),
    ));
  if (motos.length === 0) return { standings: [], eventIds };

  const results = await db.select({
    motoId: raceResultsTable.motoId,
    riderId: raceResultsTable.riderId,
    firstName: ridersTable.firstName,
    lastName: ridersTable.lastName,
    position: raceResultsTable.position,
    points: raceResultsTable.points,
    dnf: raceResultsTable.dnf,
    dns: raceResultsTable.dns,
    raceClass: raceResultsTable.raceClass,
  }).from(raceResultsTable)
    .leftJoin(ridersTable, eq(raceResultsTable.riderId, ridersTable.id))
    .where(inArray(raceResultsTable.motoId, motos.map(m => m.id)));

  // Points: the stored value (it includes club auto-DNF), or scored with the
  // series' table when none was stored. Same rule as the stored series totals.
  const scoring = await loadSeriesScoring(series.scoringTableId);
  const standings = buildSeriesStandings({
    eventIds,
    eventNames: new Map(events.map(e => [e.id, e.name])),
    eligibleClasses,
    motos,
    results,
    scoring,
  });
  return { standings, eventIds };
}
