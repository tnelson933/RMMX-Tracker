// The website's rule that a race only counts toward a series scored the same
// way, and its re-scoring of finished races when the scoring changes
// (api-server/src/lib/seriesScoringMatch.ts, lib/motoPoints.ts, routes/points-tables.ts).
// Keep the two in step.
import { getDb } from "../db";
import { AMA_POINTS } from "./overallOrder";
import { parseJson } from "./cloud-shape";

export const SCORING_STYLE_MISMATCH =
  "This points scoring style does not match the series you have selected. Please update the points scoring style or remove the series this race is tied to.";

export interface ScoringStyle {
  scoringMethod: string;
  pointsScale: number[];
  scoringFormula: string | null;
  mainEventOnly: boolean;
}

/** Do two scoring styles give every finish the same points? (cloud scoringStylesMatch) */
export function scoringStylesMatch(a: ScoringStyle, b: ScoringStyle): boolean {
  const norm = (s: ScoringStyle) => {
    const known = ["highest_points", "lowest_positions", "per_rider", "formula"].includes(s.scoringMethod);
    const method = known ? s.scoringMethod : "highest_points";
    let scale = method === "highest_points" || method === "lowest_positions" ? [...(known ? s.pointsScale ?? [] : AMA_POINTS)] : [];
    if (method === "highest_points") while (scale.length && scale[scale.length - 1] === 0) scale = scale.slice(0, -1);
    return JSON.stringify([method, scale, method === "formula" ? (s.scoringFormula ?? "").replace(/\s+/g, "") : "", !!s.mainEventOnly]);
  };
  return norm(a) === norm(b);
}

const tableId = (v: unknown): number | null => (v == null || v === "" ? null : Number(v));

/** A scoring table's style, or the default AMA scale when there is none. */
export function loadScoringStyle(id: unknown): ScoringStyle {
  const table = tableId(id) != null ? getDb().prepare("SELECT * FROM points_tables WHERE id = ?").get(tableId(id)) as any : null;
  if (!table) return { scoringMethod: "fallback", pointsScale: [], scoringFormula: null, mainEventOnly: false };
  return {
    scoringMethod: String(table.scoring_method),
    pointsScale: parseJson<number[]>(table.points_scale, []) ?? [],
    scoringFormula: table.scoring_formula ?? null,
    mainEventOnly: table.main_event_only === 1,
  };
}

/** Series ids named in a class → series map. */
export function seriesIdsInMap(map: unknown): number[] {
  const ids = new Set<number>();
  for (const list of Object.values((map ?? {}) as Record<string, unknown>)) {
    if (Array.isArray(list)) for (const id of list) if (Number.isFinite(Number(id))) ids.add(Number(id));
  }
  return [...ids];
}

export function eventMismatchesSeries(eventScoringTableId: unknown, seriesIds: number[]): boolean {
  if (seriesIds.length === 0) return false;
  const rows = getDb().prepare(`SELECT id, scoring_table_id FROM series WHERE id IN (${seriesIds.map(() => "?").join(",")})`)
    .all(...seriesIds) as Array<{ id: number; scoring_table_id: number | null }>;
  const eventStyle = loadScoringStyle(eventScoringTableId);
  return rows.some(s => !scoringStylesMatch(eventStyle, loadScoringStyle(s.scoring_table_id)));
}

/** Every series an event counts toward: linked per class, or listing the event. */
export function seriesOfEvent(eventId: number | null, clubId: number, classSeriesMap: unknown): number[] {
  const ids = new Set(seriesIdsInMap(classSeriesMap));
  if (eventId != null) {
    const clubSeries = getDb().prepare("SELECT id, event_ids FROM series WHERE club_id = ?").all(clubId) as Array<{ id: number; event_ids: string | null }>;
    for (const s of clubSeries) {
      if ((parseJson<unknown[]>(s.event_ids, []) ?? []).map(Number).includes(eventId)) ids.add(s.id);
    }
  }
  return [...ids];
}

export function seriesMismatchesEvents(seriesId: number | null, clubId: number, seriesScoringTableId: unknown, listedEventIds: number[]): boolean {
  const clubEvents = getDb().prepare("SELECT id, scoring_table_id, race_class_series_map FROM events WHERE club_id = ?")
    .all(clubId) as Array<{ id: number; scoring_table_id: number | null; race_class_series_map: string | null }>;
  const counted = clubEvents.filter(e => listedEventIds.includes(e.id)
    || (seriesId != null && seriesIdsInMap(parseJson<Record<string, unknown>>(e.race_class_series_map, {})).includes(seriesId)));
  const seriesStyle = loadScoringStyle(seriesScoringTableId);
  return counted.some(e => !scoringStylesMatch(seriesStyle, loadScoringStyle(e.scoring_table_id)));
}

/** Finished, non-practice motos of these events (to score again after a scoring change). */
export function finishedMotoIds(eventIds: number[]): number[] {
  if (eventIds.length === 0) return [];
  const rows = getDb().prepare(
    `SELECT id FROM motos WHERE event_id IN (${eventIds.map(() => "?").join(",")}) AND status = 'completed' AND type != 'practice'`,
  ).all(...eventIds) as Array<{ id: number }>;
  return rows.map(r => r.id);
}
