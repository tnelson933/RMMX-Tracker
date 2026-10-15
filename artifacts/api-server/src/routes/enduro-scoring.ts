/**
 * Shared enduro penalty computation and position recomputation helpers.
 * Imported by timing.ts, enduro-time-checks.ts, and reader-ingest.ts.
 */
import { db } from "@workspace/db";
import {
  eventsTable,
  enduroTimeChecksTable,
  enduroCheckpointArrivalsTable,
  registrationsTable,
  motosTable,
  raceResultsTable,
  type TimeCheckTarget,
  type EnduroPenaltyConfig,
} from "@workspace/db";
import { eq, and, asc } from "drizzle-orm";

function parseTimeMinutes(s: string | null | undefined): number | null {
  if (!s) return null;
  const m = s.match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  return parseInt(m[1], 10) * 60 + parseInt(m[2], 10);
}

/** Extract hours/minutes/seconds from a Date in the given IANA timezone. */
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
      const get = (type: string) => parseInt(parts.find(p => p.type === type)?.value ?? "0", 10);
      // hour12:false can return "24" for midnight in some environments
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
 * Fetch and compute time-check penalty totals for every rider in an event.
 * Returns a Map<riderId, { penaltySeconds, disqualified }>.
 * Returns an empty map if no penalty config is set on the event.
 */
export async function fetchEnduoPenaltyMap(
  eventId: number,
): Promise<Map<number, { penaltySeconds: number; disqualified: boolean }>> {
  const [ev] = await db
    .select({ enduroPenaltyConfig: eventsTable.enduroPenaltyConfig })
    .from(eventsTable)
    .where(eq(eventsTable.id, eventId));
  const config = ev?.enduroPenaltyConfig as EnduroPenaltyConfig | null | undefined;
  if (!config) return new Map();

  const checks = await db
    .select()
    .from(enduroTimeChecksTable)
    .where(eq(enduroTimeChecksTable.eventId, eventId))
    .orderBy(asc(enduroTimeChecksTable.checkNumber));
  if (checks.length === 0) return new Map();

  const arrivals = await db
    .select({
      riderId: enduroCheckpointArrivalsTable.riderId,
      timeCheckId: enduroCheckpointArrivalsTable.timeCheckId,
      arrivalTime: enduroCheckpointArrivalsTable.arrivalTime,
      raceClass: registrationsTable.raceClass,
    })
    .from(enduroCheckpointArrivalsTable)
    .leftJoin(
      registrationsTable,
      and(
        eq(registrationsTable.riderId, enduroCheckpointArrivalsTable.riderId),
        eq(registrationsTable.eventId, eventId),
      ),
    )
    .where(eq(enduroCheckpointArrivalsTable.eventId, eventId));

  const arrByRider = new Map<number, typeof arrivals>();
  for (const a of arrivals) {
    if (!arrByRider.has(a.riderId)) arrByRider.set(a.riderId, []);
    arrByRider.get(a.riderId)!.push(a);
  }

  const result = new Map<number, { penaltySeconds: number; disqualified: boolean }>();
  for (const [riderId, riderArrivals] of arrByRider) {
    const raceClass = riderArrivals[0]?.raceClass ?? null;
    let totalPenaltySeconds = 0;
    let disqualified = false;
    for (const check of checks) {
      const targets = Array.isArray(check.targets) ? (check.targets as TimeCheckTarget[]) : [];
      const target = targets.find((t) => t.raceClass === raceClass);
      if (!target?.startTimeOfDay) continue;
      const arrival = riderArrivals.find((a) => a.timeCheckId === check.id);
      if (!arrival) continue;
      const pen = computeEnduroPenalty(arrival.arrivalTime, target, config);
      totalPenaltySeconds += pen.penaltySeconds;
      if (pen.disqualified) disqualified = true;
    }
    result.set(riderId, { penaltySeconds: totalPenaltySeconds, disqualified });
  }
  return result;
}

/**
 * Recompute penalty-adjusted positions for all enduro_test motos in an event.
 * Call this after any checkpoint arrival is created, updated, or deleted so that
 * leaderboard positions immediately reflect time-check penalties and DQ status.
 *
 * Position sort: non-DQ riders sorted by (bestPassMs + penaltySeconds*1000) asc,
 * riders with no completed passes above DQ riders, DQ riders last.
 */
export async function recomputeEnduroPositionsForEvent(eventId: number): Promise<void> {
  const penaltyMap = await fetchEnduoPenaltyMap(eventId);

  const motos = await db
    .select({ id: motosTable.id })
    .from(motosTable)
    .where(and(eq(motosTable.eventId, eventId), eq(motosTable.type, "enduro_test")));

  for (const moto of motos) {
    const results = await db
      .select()
      .from(raceResultsTable)
      .where(eq(raceResultsTable.motoId, moto.id));

    const sorted = results
      .map((r) => {
        const laps = Array.isArray(r.lapTimes) ? (r.lapTimes as number[]) : [];
        const bestMs = laps.length > 0 ? Math.min(...laps) : null;
        const pen = penaltyMap.get(r.riderId) ?? { penaltySeconds: 0, disqualified: false };
        return { id: r.id, bestMs, pen };
      })
      .sort((a, b) => {
        if (a.pen.disqualified !== b.pen.disqualified) return a.pen.disqualified ? 1 : -1;
        if (a.bestMs == null && b.bestMs == null) return 0;
        if (a.bestMs == null) return 1;
        if (b.bestMs == null) return -1;
        return (a.bestMs + a.pen.penaltySeconds * 1_000) - (b.bestMs + b.pen.penaltySeconds * 1_000);
      });

    for (let i = 0; i < sorted.length; i++) {
      await db
        .update(raceResultsTable)
        .set({ position: i + 1 })
        .where(eq(raceResultsTable.id, sorted[i].id));
    }
  }
}
