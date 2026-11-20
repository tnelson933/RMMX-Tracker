import { db, eventsTable, seriesTable } from "@workspace/db";
import { eq, inArray } from "drizzle-orm";
import { loadSeriesScoring } from "./scoringTables";
import { scoringStylesMatch } from "./motoPoints";

/**
 * A race can only count toward a series scored the same way: series totals
 * add the points each race stored under its own event's table, so a mismatch
 * (an Olympic event in a points series) would rank the series wrongly.
 */
export const SCORING_STYLE_MISMATCH =
  "This points scoring style does not match the series you have selected. Please update the points scoring style or remove the series this race is tied to.";

const tableId = (v: unknown): number | null => (v == null || v === "" ? null : Number(v));

/** Series ids named in a class → series map. */
export function seriesIdsInMap(map: unknown): number[] {
  const ids = new Set<number>();
  for (const list of Object.values((map ?? {}) as Record<string, unknown>)) {
    if (Array.isArray(list)) for (const id of list) if (Number.isFinite(Number(id))) ids.add(Number(id));
  }
  return [...ids];
}

/** Does an event with this scoring table disagree with any of these series? */
export async function eventMismatchesSeries(eventScoringTableId: unknown, seriesIds: number[]): Promise<boolean> {
  if (seriesIds.length === 0) return false;
  const series = await db.select({ id: seriesTable.id, scoringTableId: seriesTable.scoringTableId })
    .from(seriesTable).where(inArray(seriesTable.id, seriesIds));
  if (series.length === 0) return false;
  const eventStyle = await loadSeriesScoring(tableId(eventScoringTableId));
  for (const s of series) {
    if (!scoringStylesMatch(eventStyle, await loadSeriesScoring(s.scoringTableId))) return true;
  }
  return false;
}

/** Every series an event counts toward: linked per class, or listing the event. */
export async function seriesOfEvent(eventId: number | null, clubId: number, classSeriesMap: unknown): Promise<number[]> {
  const ids = new Set(seriesIdsInMap(classSeriesMap));
  if (eventId != null) {
    const clubSeries = await db.select({ id: seriesTable.id, eventIds: seriesTable.eventIds })
      .from(seriesTable).where(eq(seriesTable.clubId, clubId));
    for (const s of clubSeries) if (((s.eventIds as number[]) ?? []).map(Number).includes(eventId)) ids.add(s.id);
  }
  return [...ids];
}

/** Does a series with this scoring table disagree with any event that counts toward it? */
export async function seriesMismatchesEvents(
  seriesId: number | null, clubId: number, seriesScoringTableId: unknown, listedEventIds: number[],
): Promise<boolean> {
  const clubEvents = await db.select({ id: eventsTable.id, scoringTableId: eventsTable.scoringTableId, map: eventsTable.raceClassSeriesMap })
    .from(eventsTable).where(eq(eventsTable.clubId, clubId));
  const counted = clubEvents.filter(e => listedEventIds.includes(e.id)
    || (seriesId != null && seriesIdsInMap(e.map).includes(seriesId)));
  if (counted.length === 0) return false;
  const seriesStyle = await loadSeriesScoring(tableId(seriesScoringTableId));
  const cache = new Map<number | null, boolean>();
  for (const e of counted) {
    const key = e.scoringTableId ?? null;
    if (!cache.has(key)) cache.set(key, scoringStylesMatch(seriesStyle, await loadSeriesScoring(key)));
    if (!cache.get(key)) return true;
  }
  return false;
}
