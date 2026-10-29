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
  checkinsTable,
  motosTable,
  raceResultsTable,
  type TimeCheckTarget,
  type EnduroPenaltyConfig,
} from "@workspace/db";
import { eq, and, asc, ne } from "drizzle-orm";
import { rankEnduroTest } from "../lib/enduroOverall";

/** Placeholder class enduro tests are created with (tests are event-wide). */
export const ENDURO_ALL_CLASSES = "All Classes";

/**
 * Each rider's class at an enduro event: a checked-in entry first, then any
 * check-in row, then a non-void registration (earliest row of each wins). A
 * rider entered in several classes is scored in one of them.
 */
export async function loadEnduroRiderClasses(eventId: number): Promise<Map<number, string>> {
  const [checkins, regs] = await Promise.all([
    db.select({ riderId: checkinsTable.riderId, raceClass: checkinsTable.raceClass, checkedIn: checkinsTable.checkedIn })
      .from(checkinsTable).where(eq(checkinsTable.eventId, eventId)).orderBy(asc(checkinsTable.id)),
    db.select({ riderId: registrationsTable.riderId, raceClass: registrationsTable.raceClass })
      .from(registrationsTable)
      .where(and(eq(registrationsTable.eventId, eventId), ne(registrationsTable.status, "void")))
      .orderBy(asc(registrationsTable.id)),
  ]);
  const out = new Map<number, string>();
  const usable = (cls: string | null | undefined) => !!cls && cls.trim() !== "" && cls.trim() !== ENDURO_ALL_CLASSES;
  for (const c of checkins) if (c.checkedIn && usable(c.raceClass) && !out.has(c.riderId)) out.set(c.riderId, c.raceClass.trim());
  for (const c of checkins) if (usable(c.raceClass) && !out.has(c.riderId)) out.set(c.riderId, c.raceClass.trim());
  for (const r of regs) if (usable(r.raceClass) && !out.has(r.riderId)) out.set(r.riderId, r.raceClass.trim());
  return out;
}

/** One rider's enduro class, falling back to `fallback` (e.g. the stored result class). */
export async function resolveEnduroRiderClass(eventId: number, riderId: number, fallback: string): Promise<string> {
  return (await loadEnduroRiderClasses(eventId)).get(riderId) ?? fallback;
}

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

  const [arrivals, riderClasses] = await Promise.all([
    db
      .select({
        riderId: enduroCheckpointArrivalsTable.riderId,
        timeCheckId: enduroCheckpointArrivalsTable.timeCheckId,
        arrivalTime: enduroCheckpointArrivalsTable.arrivalTime,
      })
      .from(enduroCheckpointArrivalsTable)
      .where(eq(enduroCheckpointArrivalsTable.eventId, eventId)),
    loadEnduroRiderClasses(eventId),
  ]);

  const arrByRider = new Map<number, typeof arrivals>();
  for (const a of arrivals) {
    if (!arrByRider.has(a.riderId)) arrByRider.set(a.riderId, []);
    arrByRider.get(a.riderId)!.push(a);
  }

  const result = new Map<number, { penaltySeconds: number; disqualified: boolean }>();
  for (const [riderId, riderArrivals] of arrByRider) {
    const raceClass = riderClasses.get(riderId) ?? null;
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
 * Re-rank one enduro test: positions within each rider class by completed
 * runs, then total time of those runs (lib/enduroOverall.ts). Time-check
 * penalties belong to the event overall, not to a single test; a time-check
 * DQ still ranks last. Call inside the test's moto lock.
 */
export async function rerankEnduroTest(
  motoId: number,
  penaltyMap?: Map<number, { penaltySeconds: number; disqualified: boolean }>,
): Promise<void> {
  const results = await db.select().from(raceResultsTable).where(eq(raceResultsTable.motoId, motoId));
  if (results.length === 0) return;
  const penalties = penaltyMap ?? await fetchEnduoPenaltyMap(results[0].eventId);
  const positions = rankEnduroTest(results.map((r) => ({
    id: r.id,
    raceClass: r.raceClass,
    runTimesMs: Array.isArray(r.lapTimes) ? (r.lapTimes as number[]) : [],
    dnf: r.dnf,
    dns: r.dns,
    disqualified: penalties.get(r.riderId)?.disqualified ?? false,
  })));
  for (const r of results) {
    const position = positions.get(r.id);
    if (position != null && position !== r.position) {
      await db.update(raceResultsTable).set({ position }).where(eq(raceResultsTable.id, r.id));
    }
  }
}

/**
 * Re-rank every enduro test in an event. Call after a checkpoint arrival is
 * created, updated, or deleted so time-check DQs show immediately. Each test
 * is re-ranked inside its moto lock.
 */
export async function recomputeEnduroPositionsForEvent(eventId: number): Promise<void> {
  const penaltyMap = await fetchEnduoPenaltyMap(eventId);
  const motos = await db
    .select({ id: motosTable.id })
    .from(motosTable)
    .where(and(eq(motosTable.eventId, eventId), eq(motosTable.type, "enduro_test")));
  // Lazy import: timing.ts imports this module.
  const { withMotoLock } = await import("./timing");
  for (const moto of motos) {
    await withMotoLock(moto.id, () => rerankEnduroTest(moto.id, penaltyMap));
  }
}
