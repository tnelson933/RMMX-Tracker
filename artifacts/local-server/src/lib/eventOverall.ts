/**
 * Event overall standings for the offline server. Mirrors the cloud's
 * lib/eventOverall.ts: the same rows are loaded from SQLite and handed to the
 * shared rules in @workspace/api-zod, so both servers return the same standings.
 */
import { buildEnduroEventOverall, buildEventOverall } from "@workspace/api-zod";
import type { EnduroEventResultRow, EventOverall } from "@workspace/api-zod";
import { getDb, parseJson } from "../db";
import { compareOverall, isLowerBetter, olympicPenalty, overallPositions } from "./overallOrder";
import { fetchEnduroPenaltyMap, loadEnduroRiderClasses } from "./enduroScoring";

/** Whether the event's scoring table is Olympic (lowest total wins). */
export function eventLowerIsBetter(eventId: number): boolean {
  const row = getDb().prepare(
    `SELECT pt.scoring_method AS method FROM events e
       LEFT JOIN points_tables pt ON pt.id = e.scoring_table_id
      WHERE e.id = ?`,
  ).get(eventId) as { method: string | null } | undefined;
  return isLowerBetter(row?.method);
}

/** Results of the given races with rider names, in insertion order. */
function loadResults(motoIds: number[]): EnduroEventResultRow[] {
  const rows = getDb().prepare(
    `SELECT rr.moto_id, rr.rider_id, rr.race_class, rr.position, rr.points, rr.lap_times,
            rr.dnf, rr.dns, rr.bib_number, ri.first_name, ri.last_name
       FROM race_results rr
       LEFT JOIN riders ri ON ri.id = rr.rider_id
      WHERE rr.moto_id IN (${motoIds.map(() => "?").join(",")})
      ORDER BY rr.id`,
  ).all(...motoIds) as any[];
  return rows.map((r) => ({
    motoId: r.moto_id,
    riderId: r.rider_id,
    raceClass: r.race_class,
    position: r.position,
    points: r.points ?? null,
    lapTimes: parseJson<unknown>(r.lap_times, null),
    dnf: r.dnf === 1,
    dns: r.dns === 1,
    bibNumber: r.bib_number ?? null,
    firstName: r.first_name ?? null,
    lastName: r.last_name ?? null,
  }));
}

/**
 * Overall standings per class for an event, from its finished races (practice
 * excluded); an enduro event is ranked by total time over its finished tests.
 */
export function computeEventOverall(eventId: number): EventOverall {
  const db = getDb();
  const lowerIsBetter = eventLowerIsBetter(eventId);
  const evt = db.prepare("SELECT race_style FROM events WHERE id = ?").get(eventId) as { race_style: string | null } | undefined;
  const enduro = evt?.race_style === "enduro";
  // Running order as in the cloud (PostgreSQL sorts a missing race number last).
  const motos = db.prepare(
    `SELECT id, name, moto_number, lap_count, results_finalized_at FROM motos
      WHERE event_id = ? AND status = 'completed' AND ${enduro ? "type = 'enduro_test'" : "type != 'practice'"}
      ORDER BY moto_number IS NULL, moto_number, id`,
  ).all(eventId) as Array<{ id: number; name: string; moto_number: number | null; lap_count: number | null; results_finalized_at: string | null }>;

  if (enduro) {
    const tests = motos.map((m) => ({
      id: m.id, name: m.name, motoNumber: m.moto_number, lapCount: m.lap_count, resultsFinalizedAt: m.results_finalized_at,
    }));
    if (tests.length === 0) return { ...buildEnduroEventOverall(tests, [], new Map(), new Map()), lowerIsBetter };
    return {
      ...buildEnduroEventOverall(tests, loadResults(tests.map((t) => t.id)), loadEnduroRiderClasses(eventId), fetchEnduroPenaltyMap(eventId)),
      lowerIsBetter,
    };
  }

  if (motos.length === 0) return { classes: [], hasPoints: false, lowerIsBetter };
  const motoIds = motos.map((m) => m.id);
  const { classes, hasPoints } = buildEventOverall(motoIds, loadResults(motoIds), lowerIsBetter, { compareOverall, overallPositions, olympicPenalty });
  return { classes, hasPoints, lowerIsBetter };
}
