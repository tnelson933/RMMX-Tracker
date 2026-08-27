import { Router } from "express";
import { db } from "@workspace/db";
import {
  lapCrossingsTable,
  motosTable,
  raceResultsTable,
  rfidAssignmentsTable,
  ridersTable,
  checkinsTable,
  eventsTable,
  usersTable,
  practiceSessionsTable,
  registrationsTable,
} from "@workspace/db";
import { fetchEnduoPenaltyMap } from "./enduro-scoring";
import { eq, and, asc, desc, isNotNull, isNull, or, gt, lt, sql, inArray, ilike } from "drizzle-orm";
import type { Response } from "express";
import { textToSpeech } from "@workspace/integrations-openai-ai-server/audio";
import { processPracticeCrossing } from "./practice";
import { recordTagSeen } from "../lib/recentTags";
import {
  canonicalizeCrossingTimestamp,
  deriveClockSkewRepair,
  isTrustedDirectActiveTimingSource,
  isImplausiblyFutureCrossing,
  parseTrustworthyReceivedAt,
} from "../lib/crossingTimestamp";
import {
  advanceAnnouncerLifecycle,
  createAnnouncerLifecycleState,
  hydrateAnnouncerLifecycle,
  type AnnouncerLifecycleState,
} from "../lib/announcerLifecycle";

const router = Router();

function ingestCrossingTime(value: unknown, source: string): Date {
  const receivedAt = new Date();
  return canonicalizeCrossingTimestamp(value ?? receivedAt, receivedAt, { source });
}

function ingestDirectActiveCrossingTime(value: unknown, body: Record<string, unknown>, source: string): Date {
  const serverReceivedAt = new Date();
  const originalReceipt = parseTrustworthyReceivedAt(
    body.receivedAtUtc ?? body.receivedAt,
    serverReceivedAt,
  );
  const receivedAt = originalReceipt ?? serverReceivedAt;
  return canonicalizeCrossingTimestamp(value ?? receivedAt, receivedAt, {
    source,
    deviceTimezone: body.deviceTimezone,
    timeSource: body.timeSource ?? body.source,
  }, originalReceipt !== null && isTrustedDirectActiveTimingSource(body.source, body.timeSource));
}

function getStaffClubId(res: any): number | null {
  const v = res.locals?.staffClubId;
  return typeof v === "number" ? v : null;
}

async function checkMotoClubAccess(motoId: number, staffCId: number | null): Promise<boolean> {
  if (staffCId === null) return true;
  const [moto] = await db.select({ eventId: motosTable.eventId }).from(motosTable).where(eq(motosTable.id, motoId));
  if (!moto) return false;
  const [event] = await db.select({ clubId: eventsTable.clubId }).from(eventsTable).where(eq(eventsTable.id, moto.eventId));
  return !!event && event.clubId === staffCId;
}

async function checkEventClubAccess(eventId: number, staffCId: number | null): Promise<boolean> {
  if (staffCId === null) return true;
  const [event] = await db.select({ clubId: eventsTable.clubId }).from(eventsTable).where(eq(eventsTable.id, eventId));
  return !!event && event.clubId === staffCId;
}

// ── SSE registry: motoId → connected Response objects ─────────────────────────
const sseClients = new Map<number, Set<Response>>();

type AnnouncerEvent = {
  id: string;
  sequence: number;
  kind: "start" | "lap" | "finish";
  lap: number;
  createdAt: string;
  audioUrl: string;
  label: string;
};

type AnnouncerState = {
  sequence: number;
  lifecycle: AnnouncerLifecycleState;
  currentEvent: AnnouncerEvent | null;
  pending: Promise<void>;
  retrySnapshot: LeaderboardSnapshot | null;
};

const announcerStates = new Map<number, AnnouncerState>();
const announcerAudio = new Map<string, { buffer: Buffer; createdAt: number }>();
const ANNOUNCER_CLIP_WINDOW_MS = 20_000;

function getAnnouncerState(motoId: number): AnnouncerState {
  let state = announcerStates.get(motoId);
  if (!state) {
    state = {
      sequence: 0,
      lifecycle: createAnnouncerLifecycleState(),
      currentEvent: null,
      pending: Promise.resolve(),
      retrySnapshot: null,
    };
    announcerStates.set(motoId, state);
  }
  return state;
}

function activeAnnouncement(state: AnnouncerState): AnnouncerEvent | null {
  if (!state.currentEvent) return null;
  const ageMs = Date.now() - new Date(state.currentEvent.createdAt).getTime();
  return ageMs <= ANNOUNCER_CLIP_WINDOW_MS ? state.currentEvent : null;
}

function sseSubscribe(motoId: number, res: Response) {
  if (!sseClients.has(motoId)) sseClients.set(motoId, new Set());
  sseClients.get(motoId)!.add(res);
}

function sseUnsubscribe(motoId: number, res: Response) {
  sseClients.get(motoId)?.delete(res);
}

export function sseBroadcast(motoId: number, data: object) {
  const clients = sseClients.get(motoId);
  if (!clients?.size) return;
  const payload = `data: ${JSON.stringify(data)}\n\n`;
  for (const client of [...clients]) {
    try {
      (client as any).write(payload);
    } catch {
      clients.delete(client);
    }
  }
}

function broadcastAnnouncement(motoId: number, announcement: AnnouncerEvent) {
  const clients = announcerClients.get(motoId);
  if (!clients?.size) return;
  const payload = `data: ${JSON.stringify({ type: "announcement", announcement })}\n\n`;
  for (const client of [...clients]) {
    try {
      (client as any).write(payload);
    } catch {
      clients.delete(client);
    }
  }
}

const announcerClients = new Map<number, Set<Response>>();

function announcerSubscribe(motoId: number, res: Response) {
  if (!announcerClients.has(motoId)) announcerClients.set(motoId, new Set());
  announcerClients.get(motoId)!.add(res);
}

function announcerUnsubscribe(motoId: number, res: Response) {
  announcerClients.get(motoId)?.delete(res);
}

// ── RMonitor SSE registry: eventId → bridge connections ───────────────────────
// Each entry is a bridge running rfid_bridge.py with --rmonitor enabled.
// Messages are RMonitor protocol lines (\r\n terminated) wrapped as JSON arrays.
const rmonitorClients = new Map<number, Set<Response>>();

function rmonitorSubscribe(eventId: number, res: Response) {
  if (!rmonitorClients.has(eventId)) rmonitorClients.set(eventId, new Set());
  rmonitorClients.get(eventId)!.add(res);
}

function rmonitorUnsubscribe(eventId: number, res: Response) {
  rmonitorClients.get(eventId)?.delete(res);
}

function rmonitorBroadcast(eventId: number, lines: string[]) {
  const clients = rmonitorClients.get(eventId);
  if (!clients?.size) return;
  const payload = `data: ${JSON.stringify({ lines })}\n\n`;
  for (const client of [...clients]) {
    try {
      (client as any).write(payload);
    } catch {
      clients.delete(client);
    }
  }
}

export function rmonitorClientCount(eventId: number): number {
  return rmonitorClients.get(eventId)?.size ?? 0;
}

// ── RMonitor message builders ──────────────────────────────────────────────────
// All times in "M:SS.cc" (centiseconds) — the active transponder timing format.
// Lines do NOT include the trailing \r\n — the bridge adds that when sending TCP.

function rmonitorEscape(s: string): string {
  return s.replace(/"/g, "'");
}

function buildRMonitorLines(
  snapshot: NonNullable<Awaited<ReturnType<typeof buildLeaderboard>>>,
  crossing?: { riderId: number | null; bibNumber?: string | null; lapTimeMs: number; lapNumber: number }
): string[] {
  const lines: string[] = [];

  // $B — session info
  lines.push(`$B,"1","${rmonitorEscape(snapshot.motoName)}"`);

  // $A — one competitor record per known rider
  for (const e of snapshot.leaderboard) {
    const reg = e.bibNumber ?? String(e.riderId ?? "?");
    const name = rmonitorEscape(e.riderName ?? "");
    const [first = "", ...rest] = name.split(" ");
    const last = rest.join(" ");
    lines.push(`$A,"${reg}","${reg}",0,"${first}","${last}","USA",1`);
  }

  // $F — new crossing (the lap that just happened)
  if (crossing) {
    const entry = snapshot.leaderboard.find((e) => e.riderId === crossing.riderId);
    const reg = crossing.bibNumber ?? (entry?.bibNumber ?? String(crossing.riderId ?? "?"));
    const lapStr = formatLapTime(crossing.lapTimeMs);
    const totalMs = entry?.totalMs ?? crossing.lapTimeMs;
    lines.push(`$F,"${reg}","${reg}","${lapStr}","${formatLapTime(totalMs)}",${crossing.lapNumber}`);
  }

  // $G — full leaderboard positions
  for (const e of snapshot.leaderboard) {
    const reg = e.bibNumber ?? String(e.riderId ?? "?");
    lines.push(
      `$G,${e.position},"${reg}","${reg}","${e.bestLap ?? ""}","${e.lastLap ?? ""}","${e.totalTime ?? ""}",${e.laps}`
    );
  }

  return lines;
}

// ── Utility: format milliseconds → "M:SS.mm" ──────────────────────────────────
export function formatLapTime(ms: number): string {
  if (ms <= 0) return "0:00.00";
  const minutes = Math.floor(ms / 60000);
  const seconds = Math.floor((ms % 60000) / 1000);
  const centis = Math.floor((ms % 1000) / 10);
  return `${minutes}:${String(seconds).padStart(2, "0")}.${String(centis).padStart(2, "0")}`;
}

// ── Utility: parse "M:SS.f" or "M:SS.ff" time string → ms ────────────────────
function parseTimeToMs(t: string): number {
  try {
    const [minPart, rest] = t.split(":");
    const [secPart, fracPart] = rest.split(".");
    const mins = parseInt(minPart, 10);
    const secs = parseInt(secPart, 10);
    // Pad fraction to 3 digits (tenths → ms, centiseconds → ms, etc.)
    const frac = fracPart ? parseInt(fracPart.padEnd(3, "0").slice(0, 3), 10) : 0;
    return (mins * 60 + secs) * 1000 + frac;
  } catch {
    return 0;
  }
}

// ── Normalize a lapTime entry to milliseconds (handles both legacy objects and numbers) ──
function normalizeLapMs(val: unknown): number {
  if (typeof val === "number") return val;
  if (val && typeof val === "object" && "time" in val) {
    return parseTimeToMs((val as { time: string }).time);
  }
  return 0;
}

function buildPositionMaps(
  crossings: Array<{ riderId: number | null; lapNumber: number | null }>,
  eligibleRiderIds: Set<number>,
): Map<number, Map<number, number>> {
  const positionsByLap = new Map<number, Map<number, number>>();

  for (const crossing of crossings) {
    if (
      crossing.riderId == null
      || !eligibleRiderIds.has(crossing.riderId)
      || crossing.lapNumber == null
      || crossing.lapNumber < 1
    ) continue;
    const lapPositions = positionsByLap.get(crossing.lapNumber) ?? new Map<number, number>();
    // A corrected/replayed crossing should not create a second position for the
    // same rider in one lap. The first crossing remains the order at the line.
    if (!lapPositions.has(crossing.riderId)) {
      lapPositions.set(crossing.riderId, lapPositions.size + 1);
    }
    positionsByLap.set(crossing.lapNumber, lapPositions);
  }

  return positionsByLap;
}

async function buildRaceAnalytics(
  motoId: number,
  leaderboard: Array<{
    position: number | null;
    riderId: number;
    riderName: string;
    bibNumber: string | null;
    laps: number;
    dnf: boolean;
    dns: boolean;
  }>,
) {
  const activeEntries = leaderboard.filter(entry => !entry.dnf && !entry.dns);
  const activeRiderIds = new Set(activeEntries.map(entry => entry.riderId));
  const fieldCompletedLaps = activeEntries.length > 0
    ? Math.min(...activeEntries.map(entry => entry.laps))
    : 0;
  const requestedLapNumbers = [...new Set([
    1,
    fieldCompletedLaps > 1 ? fieldCompletedLaps - 1 : null,
    fieldCompletedLaps > 0 ? fieldCompletedLaps : null,
  ].filter((lap): lap is number => lap != null))];

  const [crossings, fastestLapRows] = await Promise.all([
    requestedLapNumbers.length > 0
      ? db
        .select({
          riderId: lapCrossingsTable.riderId,
          lapNumber: lapCrossingsTable.lapNumber,
        })
        .from(lapCrossingsTable)
        .where(and(
          eq(lapCrossingsTable.motoId, motoId),
          inArray(lapCrossingsTable.lapNumber, requestedLapNumbers),
        ))
        .orderBy(asc(lapCrossingsTable.crossingTime), asc(lapCrossingsTable.id))
      : Promise.resolve([]),
    db
      .select({
        riderId: lapCrossingsTable.riderId,
        bestLapMs: sql<number | null>`min(${lapCrossingsTable.lapTimeMs})`,
      })
      .from(lapCrossingsTable)
      .where(and(
        eq(lapCrossingsTable.motoId, motoId),
        isNotNull(lapCrossingsTable.riderId),
        gt(lapCrossingsTable.lapTimeMs, 0),
      ))
      .groupBy(lapCrossingsTable.riderId),
  ]);

  const positionsByLap = buildPositionMaps(crossings, activeRiderIds);
  const isCompleteFieldLap = (positions: Map<number, number> | undefined) =>
    !!positions
    && activeRiderIds.size > 0
    && activeRiderIds.size === positions.size
    && [...activeRiderIds].every(riderId => positions.has(riderId));
  const firstLapCandidate = positionsByLap.get(1);
  const firstLapPositions = isCompleteFieldLap(firstLapCandidate) ? firstLapCandidate! : null;
  const latestLapCandidate = fieldCompletedLaps > 0 ? positionsByLap.get(fieldCompletedLaps) : undefined;
  // "Last full lap" means every active rider has a unique crossing in that lap.
  // This protects the callout from inconsistent result rows or a partial field.
  const lastCompletedLap = isCompleteFieldLap(latestLapCandidate) ? fieldCompletedLaps : null;
  const previousLapPositions = lastCompletedLap && lastCompletedLap > 1
    ? positionsByLap.get(lastCompletedLap - 1) ?? null
    : null;
  const latestLapPositions = lastCompletedLap ? latestLapCandidate ?? null : null;
  const currentPositions = new Map(
    leaderboard
      .filter(entry => !entry.dnf && !entry.dns && entry.position != null)
      .map(entry => [entry.riderId, entry.position as number]),
  );
  const entryByRiderId = new Map(leaderboard.map(entry => [entry.riderId, entry]));

  const describeRider = (riderId: number) => {
    const entry = entryByRiderId.get(riderId);
    return entry ? {
      riderId: entry.riderId,
      riderName: entry.riderName,
      bibNumber: entry.bibNumber,
    } : null;
  };

  let movingUp: {
    riderId: number;
    riderName: string;
    bibNumber: string | null;
    positionsGained: number;
    fromPosition: number;
    toPosition: number;
    lapNumber: number;
  } | null = null;
  if (
    previousLapPositions
    && latestLapPositions
    && lastCompletedLap
    && isCompleteFieldLap(previousLapPositions)
  ) {
    for (const [riderId, fromPosition] of previousLapPositions) {
      const toPosition = latestLapPositions.get(riderId);
      const rider = describeRider(riderId);
      if (!rider || toPosition == null) continue;
      const positionsGained = fromPosition - toPosition;
      if (positionsGained > (movingUp?.positionsGained ?? 0)) {
        movingUp = { ...rider, positionsGained, fromPosition, toPosition, lapNumber: lastCompletedLap };
      }
    }
  }

  let mostPasses: {
    riderId: number;
    riderName: string;
    bibNumber: string | null;
    positionsGained: number;
    startPosition: number;
    currentPosition: number;
  } | null = null;
  let fallingBack: {
    riderId: number;
    riderName: string;
    bibNumber: string | null;
    positionsLost: number;
    startPosition: number;
    currentPosition: number;
  } | null = null;
  if (firstLapPositions) {
    for (const [riderId, startPosition] of firstLapPositions) {
      const currentPosition = currentPositions.get(riderId);
      const rider = describeRider(riderId);
      if (!rider || currentPosition == null) continue;
      const positionDelta = startPosition - currentPosition;
      if (positionDelta > (mostPasses?.positionsGained ?? 0)) {
        mostPasses = { ...rider, positionsGained: positionDelta, startPosition, currentPosition };
      }
      const positionsLost = currentPosition - startPosition;
      if (positionsLost > (fallingBack?.positionsLost ?? 0)) {
        fallingBack = { ...rider, positionsLost, startPosition, currentPosition };
      }
    }
  }

  const bestLapByRiderId = new Map(
    fastestLapRows
      .filter(row => row.riderId != null && row.bestLapMs != null && row.bestLapMs > 0)
      .map(row => [row.riderId as number, Number(row.bestLapMs)]),
  );
  const fastestLaps = leaderboard
    .filter(entry => !entry.dnf && !entry.dns)
    .sort((a, b) => {
      const aBest = bestLapByRiderId.get(a.riderId) ?? null;
      const bBest = bestLapByRiderId.get(b.riderId) ?? null;
      if (aBest == null && bBest == null) return (a.position ?? 9999) - (b.position ?? 9999);
      if (aBest == null) return 1;
      if (bBest == null) return -1;
      return aBest - bBest;
    })
    .map(entry => {
      const bestLapMs = bestLapByRiderId.get(entry.riderId) ?? null;
      return {
        riderId: entry.riderId,
        riderName: entry.riderName,
        bibNumber: entry.bibNumber,
        bestLapMs,
        bestLap: bestLapMs != null ? formatLapTime(bestLapMs) : null,
      };
    });
  const timedFastestLaps = fastestLaps.filter(entry => entry.bestLapMs != null);
  const fastest = timedFastestLaps[0] ?? null;
  const nextFastest = timedFastestLaps[1] ?? null;

  return {
    lastCompletedLap,
    movingUp,
    mostPasses,
    fallingBack,
    fastestLap: fastest ? {
      ...fastest,
      marginMs: nextFastest ? (nextFastest.bestLapMs as number) - (fastest.bestLapMs as number) : null,
      margin: nextFastest ? formatLapTime((nextFastest.bestLapMs as number) - (fastest.bestLapMs as number)) : null,
      nextRiderName: nextFastest?.riderName ?? null,
    } : null,
    fastestLaps,
  };
}

// ── Leaderboard snapshot from current race_results ─────────────────────────────
export async function buildLeaderboard(motoId: number) {
  const [moto] = await db.select().from(motosTable).where(eq(motosTable.id, motoId));
  if (!moto) return null;

  // Repair the distinctive failure mode produced by a reader clock running in
  // the future. lapNumber plus insertion id is the logical order; absolute
  // crossing_time cannot be trusted in this case. Delayed (past) uploads are
  // deliberately left untouched.
  if (moto.startedAt) {
    const crossings = await db
      .select()
      .from(lapCrossingsTable)
      .where(eq(lapCrossingsTable.motoId, motoId))
      .orderBy(asc(lapCrossingsTable.lapNumber), asc(lapCrossingsTable.id));
    const byRider = new Map<number, typeof crossings>();
    for (const crossing of crossings) {
      if (crossing.riderId == null) continue;
      const group = byRider.get(crossing.riderId) ?? [];
      group.push(crossing);
      byRider.set(crossing.riderId, group);
    }
    for (const [riderId, riderCrossings] of byRider) {
      const repaired = deriveClockSkewRepair(moto.startedAt, riderCrossings);
      if (!repaired?.length) continue;
      await db.transaction(async tx => {
        for (const crossing of repaired) {
          await tx.update(lapCrossingsTable)
            .set({ crossingTime: crossing.crossingTime, lapTimeMs: crossing.lapTimeMs })
            .where(eq(lapCrossingsTable.id, crossing.id));
        }
        const lapTimes = repaired.map(c => c.lapTimeMs);
        const totalMs = lapTimes.reduce((sum, value) => sum + value, 0);
        await tx.update(raceResultsTable)
          .set({ lapTimes, totalTime: formatLapTime(totalMs) })
          .where(and(
            eq(raceResultsTable.motoId, motoId),
            eq(raceResultsTable.riderId, riderId),
          ));
      });
    }
  }

  const results = await db
    .select({
      id: raceResultsTable.id,
      riderId: raceResultsTable.riderId,
      raceClass: raceResultsTable.raceClass,
      position: raceResultsTable.position,
      lapTimes: raceResultsTable.lapTimes,
      totalTime: raceResultsTable.totalTime,
      dnf: raceResultsTable.dnf,
      dns: raceResultsTable.dns,
      bibNumber: raceResultsTable.bibNumber,
      firstName: ridersTable.firstName,
      lastName: ridersTable.lastName,
    })
    .from(raceResultsTable)
    .leftJoin(ridersTable, eq(raceResultsTable.riderId, ridersTable.id))
    .where(eq(raceResultsTable.motoId, motoId))
    .orderBy(asc(raceResultsTable.position));

  const leaderboard = results.map((r) => {
    const raw = Array.isArray(r.lapTimes) ? (r.lapTimes as unknown[]) : [];
    const lapMs = raw.map(normalizeLapMs).filter(t => t > 0);
    // Always prefer stored totalTime (matches web platform exactly — covers manually entered
    // results, RFID results, and results that were RFID-timed then manually corrected).
    // Fall back to summing RFID laps only when no stored value (live/in-progress moto).
    const storedTotalMs = r.totalTime ? parseTimeToMs(r.totalTime) : 0;
    const rfidTotalMs = lapMs.length ? lapMs.reduce((s, t) => s + t, 0) : 0;
    const totalMs = storedTotalMs || rfidTotalMs;
    const lastMs = lapMs.at(-1) ?? null;
    const validMs = lapMs.filter(t => t > 0);
    const bestMs = validMs.length ? Math.min(...validMs) : null;
    return {
      position: r.position,
      riderId: r.riderId,
      riderName: `${r.firstName} ${r.lastName}`,
      bibNumber: r.bibNumber,
      laps: lapMs.length,
      lapTimes: lapMs.map(formatLapTime),
      lastLapMs: lastMs,
      lastLap: lastMs != null ? formatLapTime(lastMs) : null,
      bestLapMs: bestMs,
      bestLap: bestMs != null ? formatLapTime(bestMs) : null,
      totalMs,
      // Stored value is source of truth for display (same as web platform).
      // Fall back to formatted RFID sum for live in-progress motos.
      totalTime: r.totalTime ?? (rfidTotalMs ? formatLapTime(rfidTotalMs) : null),
      dnf: r.dnf,
      dns: r.dns,
    };
  });

  // Compute gaps relative to leader
  const leader = leaderboard[0];
  const withGaps = leaderboard.map((entry) => {
    if (!leader || entry.position === 1) return { ...entry, gap: "Leader" };
    // Lap-count gap (RFID motos where one rider is lapped)
    if (entry.laps > 0 && leader.laps > 0 && entry.laps < leader.laps)
      return { ...entry, gap: `+${leader.laps - entry.laps} lap${leader.laps - entry.laps > 1 ? "s" : ""}` };
    // Time gap — works for both RFID (totalMs from laps) and manually entered (totalMs from stored string)
    return {
      ...entry,
      gap: entry.totalMs > 0 && leader.totalMs > 0 ? `+${formatLapTime(entry.totalMs - leader.totalMs)}` : "—",
    };
  });
  const analytics = await buildRaceAnalytics(motoId, withGaps);

  return {
    motoId,
    motoName: moto.name,
    raceClass: moto.raceClass,
    motoType: moto.type,
    fieldSize: Array.isArray(moto.lineup) ? moto.lineup.length : 0,
    status: moto.status,
    startedAt: moto.startedAt?.toISOString() ?? null,
    completedAt: moto.completedAt?.toISOString() ?? null,
    timeLimitMs: moto.timeLimitMs ?? null,
    plusLaps: moto.plusLaps ?? null,
    timeExpiredAt: moto.timeExpiredAt?.toISOString() ?? null,
    announcerStartedAt: moto.announcerStartedAt?.toISOString() ?? null,
    announcerLastLap: moto.announcerLastLap ?? 0,
    announcerFinishedAt: moto.announcerFinishedAt?.toISOString() ?? null,
    leaderboard: withGaps,
    analytics,
    updatedAt: new Date().toISOString(),
  };
}

type LeaderboardSnapshot = NonNullable<Awaited<ReturnType<typeof buildLeaderboard>>>;

// Default minimum milliseconds between two valid crossings for the same tag in the same moto.
// Rejects burst duplicates from the same antenna pass (a single tag read triggers
// 50+ identical events in ~0.2 s on most readers).  3 s is short enough to never
// drop a real lap yet long enough to swallow any realistic burst window.
//
// NOTE: event.minLapMs is a SCORING threshold (flags suspiciously fast laps in the
// results UI) — it is intentionally NOT used here so short-track laps < minLapMs
// are still recorded rather than silently dropped.
const BURST_DEBOUNCE_MS = 10_000;

// ── Per-moto async lock ────────────────────────────────────────────────────────
// Node.js yields at every `await`, so two simultaneous requests can interleave:
//   both read the same prev-crossings list → both compute lap #N → positions flip.
// This lock serialises all crossing processing for a given moto, preventing
// duplicate lap numbers and position collisions under real-track load.
const motoLocks = new Map<number, Promise<void>>();
function withMotoLock<T>(motoId: number, fn: () => Promise<T>): Promise<T> {
  let unlock!: () => void;
  const token = new Promise<void>(r => { unlock = r; });
  const prev = motoLocks.get(motoId) ?? Promise.resolve();
  motoLocks.set(motoId, prev.then(() => token));
  return prev.then(() => fn()).finally(unlock);
}

async function updateRaceResultPositions(sorted: Array<{ id: number }>) {
  if (sorted.length === 0) return;
  const positionCases = sql.join(
    sorted.map((result, index) => sql`when ${raceResultsTable.id} = ${result.id} then ${index + 1}`),
    sql` `,
  );
  await db
    .update(raceResultsTable)
    .set({
      position: sql<number>`case ${positionCases} else ${raceResultsTable.position} end`,
    })
    .where(inArray(raceResultsTable.id, sorted.map(result => result.id)));
}

// ── Core crossing processor (runs inside per-moto lock) ───────────────────────
async function _processCrossing(opts: {
  rfidNumber: string;
  motoId: number;
  crossingTime: Date;
  readerId?: string;
  antennaId?: number;
  bypassDebounce?: boolean;
  overrideRiderId?: number | null;
}) {
  const { rfidNumber, motoId, readerId, antennaId, bypassDebounce, overrideRiderId } = opts;
  // Last line of defence for internal callers that bypass an HTTP ingest route.
  const crossingTime = canonicalizeCrossingTimestamp(opts.crossingTime, new Date(), {
    source: "processCrossing",
    motoId,
    readerId,
  });

  // 1. Load moto
  const [moto] = await db.select().from(motosTable).where(eq(motosTable.id, motoId));
  if (!moto) throw new Error("Moto not found");
  // Enduro tests have no Start button — riders start individually. The first
  // crossing aimed at a scheduled test activates it (and anchors startedAt) here,
  // inside the per-moto lock, so manual bib entry and RFID start both work and
  // concurrent first crossings can't double-activate or reset the anchor.
  if (moto.status === "scheduled" && moto.type === "enduro_test") {
    const startedAt = moto.startedAt ?? crossingTime;
    await db
      .update(motosTable)
      .set({ status: "in_progress", startedAt })
      .where(eq(motosTable.id, motoId));
    moto.status = "in_progress";
    moto.startedAt = startedAt;
  }
  if (moto.status !== "in_progress") throw new Error("Moto is not in progress");
  if (!moto.startedAt) throw new Error("Moto has no start time");

  // 1b. Burst-debounce threshold — fixed short window to reject duplicate hardware reads.
  //     minLapMs is a scoring/flagging field only; it must NOT gate crossing acceptance.
  const debounceMs = BURST_DEBOUNCE_MS;

  // 2. Resolve rider — use override if provided (manual crossing), else look up from RFID assignment
  let riderId: number | null = overrideRiderId !== undefined ? overrideRiderId : null;
  if (riderId === null && overrideRiderId === undefined) {
    // Primary: event-scoped RFID assignment (set via the Assignments tab)
    const assignments = await db
      .select({ riderId: rfidAssignmentsTable.riderId })
      .from(rfidAssignmentsTable)
      .where(and(eq(rfidAssignmentsTable.rfidNumber, rfidNumber), eq(rfidAssignmentsTable.eventId, moto.eventId)));
    riderId = assignments[0]?.riderId ?? null;

    // Practice fallback: for practice-type motos, search RFID assignments across ALL events
    // so any rider registered in the system (any club/organizer) is recognized during practice.
    if (!riderId && moto.type === "practice") {
      const [anyEventAssignment] = await db
        .select({ riderId: rfidAssignmentsTable.riderId })
        .from(rfidAssignmentsTable)
        .where(eq(rfidAssignmentsTable.rfidNumber, rfidNumber))
        .limit(1);
      riderId = anyEventAssignment?.riderId ?? null;
    }

    // Active transponders can be entered per registration instead of being saved
    // permanently on the rider profile. Prefer the registration for this event so
    // a historical/global profile value cannot claim a tag assigned for this race.
    if (!riderId) {
      const [eventRegistration] = await db
        .select({ riderId: registrationsTable.riderId })
        .from(registrationsTable)
        .where(and(
          eq(registrationsTable.eventId, moto.eventId),
          ilike(registrationsTable.myLapsTransponderNumber, rfidNumber.trim()),
        ))
        .orderBy(asc(registrationsTable.id), asc(registrationsTable.riderId))
        .limit(1);
      riderId = eventRegistration?.riderId ?? null;
    }

    // Fallback: permanent RFID or active-transponder identifier on the rider profile.
    // F2000 transponder IDs are hexadecimal, so accept either letter case.
    if (!riderId) {
      const [directRider] = await db
        .select({ id: ridersTable.id })
        .from(ridersTable)
        .where(or(
          ilike(ridersTable.rfidNumber, rfidNumber.trim()),
          ilike(ridersTable.mylapsTransponderId, rfidNumber.trim()),
        ))
        .limit(1);
      riderId = directRider?.id ?? null;
    }
  }

  // ── ENDURO: per-rider start/stop toggle ─────────────────────────────────────
  // Enduro tests are run individually against the clock, not as a mass-start race.
  // Each rider gets exactly TWO crossings: the 1st is their personal START, the
  // 2nd is their FINISH (elapsed = finish − start). State is tracked by riderId
  // (NOT rfidNumber) so a rider can be started by an RFID/transponder read and
  // finished by a manual bib entry at the finish line (or vice-versa) if a tag
  // fails to read. The same input field therefore toggles start → stop.
  if (moto.type === "enduro_test") {
    if (!riderId) {
      throw new Error("Unrecognized tag — assign it to a rider or use manual bib entry");
    }
    // Order by id (insertion order), NOT crossingTime: the start→finish toggle is
    // a logical sequence. Reader/server clock skew on mixed RFID-start /
    // manual-finish reads can make a finish timestamp sort before its own start,
    // which would mis-pair runs. Insertion order is the true toggle sequence;
    // timestamps are used only to measure each run's duration (clamped ≥ 0).
    const riderCrossings = await db
      .select()
      .from(lapCrossingsTable)
      .where(and(eq(lapCrossingsTable.motoId, motoId), eq(lapCrossingsTable.riderId, riderId)))
      .orderBy(asc(lapCrossingsTable.id));

    // Debounce hardware double-reads at the start/finish line (manual bypasses this).
    // BURST_DEBOUNCE_MS (10 s) is well below any real enduro run, so a genuine
    // finish is never swallowed but a lingering tag at the line cannot self-finish.
    if (!bypassDebounce && riderCrossings.length > 0) {
      const last = riderCrossings[riderCrossings.length - 1];
      const lastTime = isImplausiblyFutureCrossing(last.crossingTime, last.createdAt)
        ? last.createdAt
        : last.crossingTime;
      const gapMs = crossingTime.getTime() - lastTime.getTime();
      if (gapMs < debounceMs) {
        return { debounced: true, crossing: null, lapNumber: null, lapTimeMs: null };
      }
    }

    // A full lap = running every test once. lapCount is how many laps the event
    // has, so each rider runs THIS test lapCount times → lapCount completed pass
    // times. Each run = a START crossing then a FINISH crossing (2 per run).
    const lapsPerTest = Math.max(1, moto.lapCount ?? 1);
    const maxCrossings = lapsPerTest * 2;
    if (riderCrossings.length >= maxCrossings) {
      throw new Error(`Rider already completed all ${lapsPerTest} run${lapsPerTest > 1 ? "s" : ""} of this test`);
    }

    // Even prior-count → this crossing STARTS the next run; odd → it FINISHES the
    // run currently in progress. passNumber is which run (1-based) this belongs to.
    const isFinish = riderCrossings.length % 2 === 1;
    const passNumber = Math.floor(riderCrossings.length / 2) + 1;
    const lapNumber = passNumber;
    // Clamp to 0 so reader/server clock skew between a mixed RFID-start /
    // manual-finish (or vice-versa) can never produce a negative elapsed time.
    const elapsedMs = isFinish
      ? Math.max(0, crossingTime.getTime() - new Date(riderCrossings[riderCrossings.length - 1].crossingTime).getTime())
      : 0;

    const [crossing] = await db
      .insert(lapCrossingsTable)
      .values({ eventId: moto.eventId, motoId, riderId, rfidNumber, crossingTime, lapNumber, lapTimeMs: elapsedMs, readerId: readerId ?? null, antennaId: antennaId ?? null })
      .returning();

    // Upsert race_result: running riders carry lapTimes [] (totalTime null → "—"),
    // finished riders carry a single elapsed entry used by the leaderboard.
    const enduroCheckins = await db
      .select()
      .from(checkinsTable)
      .where(and(eq(checkinsTable.eventId, moto.eventId), eq(checkinsTable.riderId, riderId)));
    const enduroCheckin = enduroCheckins.find((c) => c.raceClass === moto.raceClass) ?? enduroCheckins[0];
    const existingResult = await db
      .select()
      .from(raceResultsTable)
      .where(and(eq(raceResultsTable.motoId, motoId), eq(raceResultsTable.riderId, riderId)));

    // Recompute every completed pass time from all crossings by pairing them
    // START→FINISH in insertion order (riderCrossings is id-ordered and the new
    // crossing has the highest id, so this stays in logical toggle order — no
    // crossingTime sort, which could mis-pair under clock skew). A trailing
    // unpaired START (rider mid-run) contributes no completed time yet.
    const allEnduroCrossings = [...riderCrossings, crossing];
    const passTimes: number[] = [];
    for (let i = 0; i + 1 < allEnduroCrossings.length; i += 2) {
      const startMs = new Date(allEnduroCrossings[i].crossingTime).getTime();
      const finishMs = new Date(allEnduroCrossings[i + 1].crossingTime).getTime();
      passTimes.push(Math.max(0, finishMs - startMs));
    }
    const enduroTotalMs = passTimes.reduce((s, t) => s + t, 0);
    const enduroTotalTime = passTimes.length ? formatLapTime(enduroTotalMs) : null;

    if (existingResult[0]) {
      await db
        .update(raceResultsTable)
        .set({ lapTimes: passTimes, totalTime: enduroTotalTime })
        .where(eq(raceResultsTable.id, existingResult[0].id));
    } else {
      await db.insert(raceResultsTable).values({
        eventId: moto.eventId,
        motoId,
        riderId,
        raceClass: moto.raceClass,
        position: 999,
        lapTimes: passTimes,
        totalTime: enduroTotalTime,
        bibNumber: enduroCheckin?.bibNumber ?? null,
        dnf: false,
        dns: false,
      });
    }

    // Recalculate positions: riders ranked by fastest single pass time asc,
    // with time-check penalty seconds added. DQ riders sort last.
    // Riders with no completed pass sort to the bottom.
    const [enduroResults, penaltyMap] = await Promise.all([
      db.select().from(raceResultsTable).where(eq(raceResultsTable.motoId, motoId)),
      fetchEnduoPenaltyMap(moto.eventId),
    ]);
    const enduroSorted = enduroResults
      .map((r) => {
        const laps = Array.isArray(r.lapTimes) ? (r.lapTimes as number[]) : [];
        const bestMs = laps.length > 0 ? Math.min(...laps) : null;
        const pen = penaltyMap.get(r.riderId) ?? { penaltySeconds: 0, disqualified: false };
        return { id: r.id, bestMs, pen };
      })
      .sort((a, b) => {
        // DQ riders always last
        if (a.pen.disqualified !== b.pen.disqualified) return a.pen.disqualified ? 1 : -1;
        // Riders with no completed pass sort before DQ but after others
        if (a.bestMs == null && b.bestMs == null) return 0;
        if (a.bestMs == null) return 1;
        if (b.bestMs == null) return -1;
        // Sort by best pass time + penalty seconds converted to ms
        return (a.bestMs + a.pen.penaltySeconds * 1_000) - (b.bestMs + b.pen.penaltySeconds * 1_000);
      });
    await updateRaceResultPositions(enduroSorted);

    const enduroSnapshot = await buildLeaderboard(motoId);
    if (enduroSnapshot) {
      publishTimingSnapshot(enduroSnapshot);
      const rmonLines = buildRMonitorLines(enduroSnapshot, {
        riderId,
        bibNumber: enduroSnapshot.leaderboard.find((e) => e.riderId === riderId)?.bibNumber ?? null,
        lapTimeMs: elapsedMs,
        lapNumber,
      });
      rmonitorBroadcast(moto.eventId, rmonLines);
    }

    return { crossing, lapNumber, lapTimeMs: elapsedMs, enduroAction: (isFinish ? "finished" : "started") as "started" | "finished", elapsedMs };
  }

  // 3. Previous crossings for this tag+moto
  const prevCrossings = await db
    .select()
    .from(lapCrossingsTable)
    .where(and(eq(lapCrossingsTable.motoId, motoId), eq(lapCrossingsTable.rfidNumber, rfidNumber)))
    .orderBy(asc(lapCrossingsTable.lapNumber), asc(lapCrossingsTable.id));

  // ── Debounce: reject burst reads from the same antenna pass ─────────────────
  // Skipped for manual crossings (organizer is intentionally pressing a button).
  if (!bypassDebounce && prevCrossings.length > 0) {
    const lastCrossing = prevCrossings[prevCrossings.length - 1];
    const lastTime = isImplausiblyFutureCrossing(lastCrossing.crossingTime, lastCrossing.createdAt)
      ? lastCrossing.createdAt
      : lastCrossing.crossingTime;
    const gapMs = crossingTime.getTime() - lastTime.getTime();
    if (gapMs < debounceMs) {
      // Silent accept — not an error, just a duplicate burst read
      return { debounced: true, crossing: null, lapNumber: null, lapTimeMs: null };
    }
  }

  const lapNumber = prevCrossings.length + 1;
  const prevTime =
    prevCrossings.length > 0
      ? (isImplausiblyFutureCrossing(
          prevCrossings[prevCrossings.length - 1].crossingTime,
          prevCrossings[prevCrossings.length - 1].createdAt,
        )
          ? prevCrossings[prevCrossings.length - 1].createdAt
          : prevCrossings[prevCrossings.length - 1].crossingTime)
      : moto.startedAt;
  const lapTimeMs = crossingTime.getTime() - new Date(prevTime).getTime();
  if (!Number.isFinite(lapTimeMs) || lapTimeMs < 0) {
    throw new Error("Crossing time precedes the moto start or previous lap");
  }

  // 4. Store crossing
  const [crossing] = await db
    .insert(lapCrossingsTable)
    .values({ eventId: moto.eventId, motoId, riderId, rfidNumber, crossingTime, lapNumber, lapTimeMs, readerId: readerId ?? null, antennaId: antennaId ?? null })
    .returning();

  // 5. Upsert race_results for this rider
  if (riderId) {
    // Get checkin to find raceClass + bibNumber
    const checkins = await db
      .select()
      .from(checkinsTable)
      .where(and(eq(checkinsTable.eventId, moto.eventId), eq(checkinsTable.riderId, riderId)));
    const checkin = checkins.find((c) => c.raceClass === moto.raceClass) ?? checkins[0];

    const existing = await db
      .select()
      .from(raceResultsTable)
      .where(and(eq(raceResultsTable.motoId, motoId), eq(raceResultsTable.riderId, riderId)));

    if (existing[0]) {
      const prevLaps = Array.isArray(existing[0].lapTimes) ? (existing[0].lapTimes as number[]) : [];
      // Only cap by lapCount for fixed-lap races; time-limit races (timeLimitMs > 0) run until
      // the flag + plusLaps logic fires — capping would silently drop the decisive final lap.
      const timingLapCap = moto.lapCount != null && moto.lapCount > 0 && !moto.timeLimitMs ? Number(moto.lapCount) : null;
      // If already at the lap cap, don't add another lap to race_results
      if (timingLapCap != null && prevLaps.length >= timingLapCap) {
        // crossing is stored in lap_crossings above; just don't update race_results
      } else {
      const newLaps = [...prevLaps, lapTimeMs];
      const cappedLaps = timingLapCap != null ? newLaps.slice(0, timingLapCap) : newLaps;
      const totalMs = cappedLaps.reduce((s, t) => s + t, 0);
      await db
        .update(raceResultsTable)
        .set({ lapTimes: cappedLaps, totalTime: formatLapTime(totalMs) })
        .where(eq(raceResultsTable.id, existing[0].id));
      }
    } else {
      const timingLapCapNew = moto.lapCount != null && moto.lapCount > 0 && !moto.timeLimitMs ? Number(moto.lapCount) : null;
      // Only create the result row if within the lap limit (lap 1 is always within limit)
      if (timingLapCapNew == null || 1 <= timingLapCapNew) {
      await db.insert(raceResultsTable).values({
        eventId: moto.eventId,
        motoId,
        riderId,
        raceClass: moto.raceClass,
        position: 999,
        lapTimes: [lapTimeMs],
        totalTime: formatLapTime(lapTimeMs),
        bibNumber: checkin?.bibNumber ?? null,
        dnf: false,
        dns: false,
      });
      }
    }

    // 6. Recalculate positions for all riders in moto
    const allResults = await db
      .select()
      .from(raceResultsTable)
      .where(eq(raceResultsTable.motoId, motoId));

    const sorted = allResults
      .map((r) => {
        const laps = Array.isArray(r.lapTimes) ? (r.lapTimes as number[]) : [];
        return { id: r.id, laps: laps.length, totalMs: laps.reduce((s, t) => s + t, 0) };
      })
      .sort((a, b) => b.laps - a.laps || a.totalMs - b.totalMs);

    await updateRaceResultPositions(sorted);
  }

  // 7. Build & broadcast leaderboard (JSON SSE for the live scoreboard widget)
  const snapshot = await buildLeaderboard(motoId);
  if (snapshot) {
    publishTimingSnapshot(snapshot);
    // Also push RMonitor lines to any bridge clients subscribed to this event
    const rmonLines = buildRMonitorLines(snapshot, {
      riderId,
      bibNumber: snapshot.leaderboard.find((e) => e.riderId === riderId)?.bibNumber ?? null,
      lapTimeMs,
      lapNumber,
    });
    rmonitorBroadcast(moto.eventId, rmonLines);
  }

  // 8. Time+Laps auto-complete: when timeExpiredAt is set and the leader has finished their plus-laps
  if (moto.timeExpiredAt && moto.plusLaps != null && moto.plusLaps > 0 && snapshot) {
    const leader = snapshot.leaderboard[0];
    if (leader?.riderId != null && !leader.dnf && !leader.dns) {
      const flagTime = new Date(moto.timeExpiredAt);
      const [{ lapsAfterFlag }] = await db
        .select({ lapsAfterFlag: sql<number>`cast(count(*) as int)` })
        .from(lapCrossingsTable)
        .where(and(
          eq(lapCrossingsTable.motoId, motoId),
          eq(lapCrossingsTable.riderId, leader.riderId),
          gt(lapCrossingsTable.crossingTime, flagTime),
        ));
      if ((lapsAfterFlag ?? 0) >= moto.plusLaps) {
        await db.update(motosTable)
          .set({ status: "completed", completedAt: new Date() })
          .where(eq(motosTable.id, motoId));
        const completedSnapshot = await buildLeaderboard(motoId);
        if (completedSnapshot) publishTimingSnapshot(completedSnapshot);
      }
    }
  }

  return { crossing, lapNumber, lapTimeMs };
}

// Public entry point — acquires the per-moto lock before running the processor
// so concurrent crossings are serialised, preventing lap-number duplicates and
// position flips when multiple tags arrive at the same instant.
export function processCrossing(opts: Parameters<typeof _processCrossing>[0]) {
  return withMotoLock(opts.motoId, () => _processCrossing(opts));
}

// ── Routes ────────────────────────────────────────────────────────────────────

// POST /timing/crossing — called by hardware readers (or simulation)
router.post("/timing/crossing", async (req, res) => {
  const { rfidNumber, motoId, crossingTime, readerId, antennaId } = req.body;
  if (!rfidNumber || !motoId) {
    return res.status(400).json({ error: "rfidNumber and motoId are required" });
  }

  const time = ingestCrossingTime(crossingTime, "direct_crossing_ingest");

  const antenna = antennaId !== undefined ? Number(antennaId) : undefined;

  // Staff: verify the moto belongs to their club before accepting the crossing
  const _staffCId = getStaffClubId(res);
  if (_staffCId !== null) {
    const [_motoRow] = await db.select({ eventId: motosTable.eventId }).from(motosTable).where(eq(motosTable.id, Number(motoId)));
    if (!_motoRow) return res.status(404).json({ error: "Moto not found" });
    const [_evtRow] = await db.select({ clubId: eventsTable.clubId }).from(eventsTable).where(eq(eventsTable.id, _motoRow.eventId));
    if (!_evtRow || _evtRow.clubId !== _staffCId) return res.status(403).json({ error: "Forbidden" });
  }

  try {
    const result = await processCrossing({ rfidNumber, motoId: Number(motoId), crossingTime: time, readerId, antennaId: antenna });
    if (result.debounced) {
      // Burst duplicate — acknowledge silently so the reader doesn't retry
      return res.json({ ok: true, debounced: true });
    }
    return res.json({
      ok: true,
      crossingId: result.crossing!.id,
      lapNumber: result.lapNumber,
      lapTime: formatLapTime(result.lapTimeMs!),
      lapTimeMs: result.lapTimeMs,
    });
  } catch (err: any) {
    return res.status(409).json({ error: err.message });
  }
});

// ── Helper: find the single in-progress moto for an event ─────────────────────
async function getActiveMotoForEvent(eventId: number) {
  const rows = await db
    .select()
    .from(motosTable)
    .where(and(eq(motosTable.eventId, eventId), eq(motosTable.status, "in_progress")))
    .orderBy(desc(motosTable.startedAt))
    .limit(1);
  return rows[0] ?? null;
}

// ── Helper: find the in-progress moto across ALL events for a club ─────────────
// Used by the stable "facility endpoint" so hardware never needs reconfiguring.
async function getActiveMotoForClub(clubId: number) {
  const rows = await db
    .select({ moto: motosTable })
    .from(motosTable)
    .innerJoin(eventsTable, eq(motosTable.eventId, eventsTable.id))
    .where(and(eq(eventsTable.clubId, clubId), eq(motosTable.status, "in_progress")))
    .orderBy(desc(motosTable.startedAt))
    .limit(1);
  if (rows[0]) return rows[0].moto;
  // Enduro fallback: enduro tests have no Start button, so none may be in_progress
  // yet. Route a facility-endpoint crossing to the next scheduled test (lowest
  // motoNumber); _processCrossing activates it atomically inside the moto lock.
  const enduroRows = await db
    .select({ moto: motosTable })
    .from(motosTable)
    .innerJoin(eventsTable, eq(motosTable.eventId, eventsTable.id))
    .where(and(
      eq(eventsTable.clubId, clubId),
      eq(motosTable.status, "scheduled"),
      eq(motosTable.type, "enduro_test"),
    ))
    .orderBy(asc(motosTable.motoNumber))
    .limit(1);
  return enduroRows[0]?.moto ?? null;
}

async function getActivePracticeSessionForClub(clubId: number) {
  const [session] = await db
    .select()
    .from(practiceSessionsTable)
    .where(and(eq(practiceSessionsTable.clubId, clubId), eq(practiceSessionsTable.status, "active")))
    .orderBy(desc(practiceSessionsTable.id))
    .limit(1);
  return session ?? null;
}

// POST /timing/active/crossing?clubId=N — stable "facility" endpoint
// ─────────────────────────────────────────────────────────────────────────────
// Configure your hardware ONCE with this URL + your club ID, then never touch
// it again.  The server automatically routes each crossing to whichever moto is
// currently in_progress for any of your club's events.
//
// Accepts ALL hardware payload formats:
//   • Generic:           { rfidNumber, crossingTime? }
//   • F2000 Active Transponder Timing: { transponder, passingTime? }
//   • Impinj R700:       { events: [{ type:"tagInventoryEvent", tagInventoryEvent:{epcHex,firstSeenTime} }] }
//   • Zebra FX7500:      { data: { tags: [{idHex, firstSeenTimestamp}] } } or { tags:[...] }
router.post("/timing/active/crossing", async (req, res) => {
  const clubId = Number(req.query.clubId);
  if (!clubId || isNaN(clubId)) {
    return res.status(400).json({ error: "clubId query param is required" });
  }

  // Staff: verify the target club matches their own club
  const _staffCId = getStaffClubId(res);
  if (_staffCId !== null && clubId !== _staffCId) {
    return res.status(403).json({ error: "Forbidden" });
  }

  const body = req.body as any;

  // ── Impinj R700 native IoT Connector format ─────────────────────────────────
  if (Array.isArray(body?.events)) {
    const tagEvents = (body.events as any[])
      .filter((e: any) => e?.type === "tagInventoryEvent" && e?.tagInventoryEvent?.epcHex)
      .map((e: any) => e.tagInventoryEvent as { epcHex: string; antennaPort?: number; firstSeenTime?: string });

    if (tagEvents.length === 0) {
      return res.json({ ok: true, processed: 0, note: "No tagInventoryEvent entries in payload" });
    }
    for (const t of tagEvents) recordTagSeen(clubId, t.epcHex.toUpperCase());
    const moto = await getActiveMotoForClub(clubId);
    if (!moto) {
      const session = await getActivePracticeSessionForClub(clubId);
      if (!session) {
        return res.status(409).json({ error: "No moto in progress for this club", hint: "Start a moto from the Race Day tab first." });
      }
      const results: unknown[] = [];
      for (const tag of tagEvents) {
        const rfidNumber = tag.epcHex.toUpperCase();
        const crossingTime = ingestCrossingTime(tag.firstSeenTime, "active_ingest_impinj_practice");
        if (isNaN(crossingTime.getTime())) { results.push({ rfidNumber, error: "Invalid firstSeenTime" }); continue; }
        try {
          const r = await processPracticeCrossing(session, rfidNumber, crossingTime);
          results.push("skipped" in r ? { rfidNumber, skipped: true } : { rfidNumber, crossingId: r.crossing?.id });
        } catch (err: any) { results.push({ rfidNumber, error: err.message }); }
      }
      return res.json({ ok: true, processed: tagEvents.length, practiceSessionId: session.id, results });
    }
    const results: unknown[] = [];
    for (const tag of tagEvents) {
      const rfidNumber = tag.epcHex.toUpperCase();
      const crossingTime = ingestCrossingTime(tag.firstSeenTime, "active_ingest_impinj");
      if (isNaN(crossingTime.getTime())) { results.push({ rfidNumber, error: "Invalid firstSeenTime" }); continue; }
      try {
        const r = await processCrossing({ rfidNumber, motoId: moto.id, crossingTime, readerId: "impinj-r700", antennaId: tag.antennaPort });
        results.push(r.debounced ? { rfidNumber, debounced: true } : { rfidNumber, crossingId: r.crossing?.id, lapNumber: r.lapNumber, lapTimeMs: r.lapTimeMs });
      } catch (err: any) { results.push({ rfidNumber, error: err.message }); }
    }
    return res.json({ ok: true, processed: tagEvents.length, motoId: moto.id, results });
  }

  // ── Impinj R700 firmware 10.x IoT Device Interface format ───────────────────
  // Body is a top-level array: [{ timestamp, eventType: "tagInventory", tagInventoryEvent: { epc: "<base64url>", antennaPort } }]
  if (Array.isArray(body)) {
    const fw10Events = (body as any[]).filter(
      (e: any) => e?.eventType === "tagInventory" && e?.tagInventoryEvent?.epc,
    );
    // Empty poll (no tags in range) — return 200 instead of falling through
    if (fw10Events.length === 0) {
      return res.json({ ok: true, processed: 0, note: "No tags in range" });
    }
    const tagEvents = fw10Events.map((e: any) => ({
      epcHex: Buffer.from(e.tagInventoryEvent.epc.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("hex").toUpperCase(),
      antennaPort: e.tagInventoryEvent.antennaPort as number | undefined,
      // Prefer lastSeenTime (exact moment tag was read by antenna) over the
      // top-level event batch timestamp, with fallback to batch timestamp then server time.
      timestamp: (e.tagInventoryEvent.lastSeenTime ?? e.timestamp) as string | undefined,
    }));
    for (const t of tagEvents) recordTagSeen(clubId, t.epcHex);
    const moto = await getActiveMotoForClub(clubId);
    if (!moto) {
      const session = await getActivePracticeSessionForClub(clubId);
      if (!session) {
        return res.status(409).json({ error: "No moto in progress for this club", hint: "Start a moto from the Race Day tab first." });
      }
      const results: unknown[] = [];
      for (const tag of tagEvents) {
        const crossingTime = ingestCrossingTime(tag.timestamp, "active_ingest_tag_practice");
        try {
          const r = await processPracticeCrossing(session, tag.epcHex, crossingTime);
          const outcome = "skipped" in r ? `skipped(${r.reason})` : `recorded(crossing=${r.crossing?.id})`;
          req.log.info({ epc: tag.epcHex, outcome, crossingTime }, "practice crossing");
          results.push("skipped" in r ? { rfidNumber: tag.epcHex, skipped: true, reason: r.reason } : { rfidNumber: tag.epcHex, crossingId: r.crossing?.id });
        } catch (err: any) { results.push({ rfidNumber: tag.epcHex, error: err.message }); }
      }
      return res.json({ ok: true, processed: tagEvents.length, practiceSessionId: session.id, results });
    }
    const results: unknown[] = [];
    for (const tag of tagEvents) {
      const crossingTime = ingestCrossingTime(tag.timestamp, "active_ingest_tag");
      try {
        const r = await processCrossing({ rfidNumber: tag.epcHex, motoId: moto.id, crossingTime, readerId: "impinj-r700-fw10", antennaId: tag.antennaPort });
        results.push(r.debounced ? { rfidNumber: tag.epcHex, debounced: true } : { rfidNumber: tag.epcHex, crossingId: r.crossing?.id, lapNumber: r.lapNumber, lapTimeMs: r.lapTimeMs });
      } catch (err: any) { results.push({ rfidNumber: tag.epcHex, error: err.message }); }
    }
    return res.json({ ok: true, processed: tagEvents.length, motoId: moto.id, results });
  }

  // ── Zebra FX7500 format ─────────────────────────────────────────────────────
  const zebraTags: any[] = Array.isArray(body?.data?.tags) ? body.data.tags
    : Array.isArray(body?.tags) ? body.tags : [];
  if (zebraTags.length > 0) {
    const moto = await getActiveMotoForClub(clubId);
    if (!moto) {
      const session = await getActivePracticeSessionForClub(clubId);
      if (!session) {
        return res.status(409).json({ error: "No moto in progress for this club", hint: "Start a moto from the Race Day tab first." });
      }
      const results: unknown[] = [];
      for (const tag of zebraTags) {
        const rfidNumber = ((tag.idHex || tag.epc) as string | undefined ?? "").toUpperCase();
        if (!rfidNumber) { results.push({ error: "Tag missing idHex/epc field" }); continue; }
        const crossingTime = ingestCrossingTime(tag.firstSeenTimestamp, "active_ingest_zebra_practice");
        try {
          const r = await processPracticeCrossing(session, rfidNumber, crossingTime);
          results.push("skipped" in r ? { rfidNumber, skipped: true } : { rfidNumber, crossingId: r.crossing?.id });
        } catch (err: any) { results.push({ rfidNumber, error: err.message }); }
      }
      return res.json({ ok: true, processed: zebraTags.length, practiceSessionId: session.id, results });
    }
    const results: unknown[] = [];
    for (const tag of zebraTags) {
      const rfidNumber = ((tag.idHex || tag.epc) as string | undefined ?? "").toUpperCase();
      if (!rfidNumber) { results.push({ error: "Tag missing idHex/epc field" }); continue; }
      const crossingTime = ingestCrossingTime(tag.firstSeenTimestamp, "active_ingest_zebra");
      try {
        const r = await processCrossing({ rfidNumber, motoId: moto.id, crossingTime, readerId: "zebra-fx7500", antennaId: tag.antennaPort });
        results.push(r.debounced ? { rfidNumber, debounced: true } : { rfidNumber, crossingId: r.crossing?.id, lapNumber: r.lapNumber, lapTimeMs: r.lapTimeMs });
      } catch (err: any) { results.push({ rfidNumber, error: err.message }); }
    }
    return res.json({ ok: true, processed: zebraTags.length, motoId: moto.id, results });
  }

// ── Generic / Active Transponder Timing format ─────────────────────────────
  const rfidNumber: string | undefined =
    body?.rfidNumber ?? body?.transponder ?? body?.transponderId ?? body?.id;
  if (!rfidNumber) {
    return res.status(400).json({
      error: "Cannot extract tag/transponder ID — expected rfidNumber, transponder, transponderId, Impinj events[], or Zebra tags[]",
    });
  }
  const rawTime: string | undefined =
    body?.crossingTime ?? body?.passingTime ?? body?.timestamp ?? body?.passTime;
  const crossingTime = ingestDirectActiveCrossingTime(rawTime, body, "active_ingest_generic");
  recordTagSeen(clubId, String(rfidNumber).toUpperCase());

  const moto = await getActiveMotoForClub(clubId);
  if (!moto) {
    const session = await getActivePracticeSessionForClub(clubId);
    if (!session) {
      return res.status(409).json({ error: "No moto in progress for this club", hint: "Start a moto from the Race Day tab first." });
    }
    try {
      const r = await processPracticeCrossing(session, String(rfidNumber), crossingTime);
      const outcome = "skipped" in r ? `skipped(${r.reason})` : `recorded(crossing=${r.crossing?.id})`;
      req.log.info({ epc: String(rfidNumber), outcome, crossingTime }, "practice crossing");
      if ("skipped" in r) return res.json({ ok: true, skipped: true, reason: r.reason, practiceSessionId: session.id });
      return res.json({ ok: true, practiceSessionId: session.id, crossingId: r.crossing?.id });
    } catch (err: any) {
      return res.status(409).json({ error: err.message });
    }
  }
  const readerId: string = body?.loopId ?? body?.readerId ?? body?.readername ?? "rfid";

  try {
    const result = await processCrossing({ rfidNumber: String(rfidNumber), motoId: moto.id, crossingTime, readerId });
    if (result.debounced) return res.json({ ok: true, debounced: true, motoId: moto.id });
    return res.json({
      ok: true, motoId: moto.id,
      crossingId: result.crossing?.id,
      lapNumber: result.lapNumber,
      lapTime: result.lapTimeMs != null ? formatLapTime(result.lapTimeMs) : null,
      lapTimeMs: result.lapTimeMs,
    });
  } catch (err: any) {
    return res.status(409).json({ error: err.message });
  }
});

// POST /timing/ping?clubId=N — connectivity test, no moto or session required
// Accepts any tag format; just confirms the server received it.
// Used by the Reader Setup page so organizers can test without starting a moto.
router.post("/timing/ping", async (req, res) => {
  const clubId = Number(req.query.clubId);
  if (!clubId || isNaN(clubId)) {
    return res.status(400).json({ error: "clubId query param is required" });
  }

  const body = req.body as any;

  // Impinj R700 firmware 10.x — top-level array with base64url epc
  if (Array.isArray(body)) {
    const fw10 = (body as any[]).find((e: any) => e?.eventType === "tagInventory" && e?.tagInventoryEvent?.epc);
    if (fw10) {
      const epcHex = Buffer.from(fw10.tagInventoryEvent.epc.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("hex").toUpperCase();
      return res.json({ ok: true, received: epcHex, clubId });
    }
    return res.json({ ok: true, received: "(fw10 array — no tagInventory events)", clubId });
  }

  // Impinj R700 IoT Connector format (older firmware)
  if (Array.isArray(body?.events)) {
    const tag = (body.events as any[]).find(
      (e: any) => e?.type === "tagInventoryEvent" && e?.tagInventoryEvent?.epcHex,
    );
    const rfidNumber = tag?.tagInventoryEvent?.epcHex?.toUpperCase() ?? null;
    return res.json({ ok: true, received: rfidNumber ?? "(impinj payload)", clubId });
  }

  // Zebra FX7500 format
  const zebraTags: any[] = Array.isArray(body?.data?.tags) ? body.data.tags
    : Array.isArray(body?.tags) ? body.tags : [];
  if (zebraTags.length > 0) {
    const rfidNumber = ((zebraTags[0]?.idHex || zebraTags[0]?.epc) as string | undefined ?? "").toUpperCase();
    return res.json({ ok: true, received: rfidNumber || "(zebra payload)", clubId });
  }

  // Generic active-transponder payload
  const rfidNumber: string | undefined =
    body?.rfidNumber ?? body?.transponder ?? body?.transponderId ?? body?.id;
  if (!rfidNumber) {
    return res.status(400).json({ error: "Cannot find tag/transponder ID in payload" });
  }

  return res.json({ ok: true, received: String(rfidNumber), clubId });
});

// POST /timing/impinj-crossing?eventId=N — Impinj R700 native IoT Connector format
// Body: { events: [{ type: "tagInventoryEvent", tagInventoryEvent: { epcHex, antennaPort, firstSeenTime } }] }
router.post("/timing/impinj-crossing", async (req, res) => {
  const eventId = Number(req.query.eventId);
  if (!eventId || isNaN(eventId)) {
    return res.status(400).json({ error: "eventId query param is required" });
  }

  const _staffCId = getStaffClubId(res);
  if (_staffCId !== null) {
    const [_evtRow] = await db.select({ clubId: eventsTable.clubId }).from(eventsTable).where(eq(eventsTable.id, eventId));
    if (!_evtRow || _evtRow.clubId !== _staffCId) return res.status(403).json({ error: "Forbidden" });
  }

  const body = req.body as { events?: unknown[] };
  const events = Array.isArray(body.events) ? body.events : [];

  const tagEvents = events
    .filter((e: any) => e?.type === "tagInventoryEvent" && e?.tagInventoryEvent?.epcHex)
    .map((e: any) => e.tagInventoryEvent as { epcHex: string; antennaPort?: number; firstSeenTime?: string });

  if (tagEvents.length === 0) {
    return res.json({ ok: true, processed: 0, note: "No tagInventoryEvent entries in payload" });
  }

  const moto = await getActiveMotoForEvent(eventId);
  if (!moto) {
    return res.status(409).json({ error: "No moto currently in progress for this event" });
  }

  const results: unknown[] = [];
  for (const tag of tagEvents) {
    const rfidNumber = tag.epcHex.toUpperCase();
    const crossingTime = ingestCrossingTime(tag.firstSeenTime, "legacy_impinj_ingest");
    if (isNaN(crossingTime.getTime())) {
      results.push({ rfidNumber, error: "Invalid firstSeenTime" });
      continue;
    }
    try {
      const result = await processCrossing({
        rfidNumber,
        motoId: moto.id,
        crossingTime,
        readerId: "impinj-r700",
        antennaId: tag.antennaPort,
      });
      if (result.debounced) {
        results.push({ rfidNumber, debounced: true });
      } else {
        results.push({ rfidNumber, crossingId: result.crossing?.id, lapNumber: result.lapNumber, lapTimeMs: result.lapTimeMs });
      }
    } catch (err: any) {
      results.push({ rfidNumber, error: err.message });
    }
  }

  return res.json({ ok: true, processed: tagEvents.length, motoId: moto.id, results });
});

// POST /timing/zebra-crossing?eventId=N — Zebra FX7500 IoT Connector format
// Body: { data: { type: "RFID", tags: [{ idHex, antennaPort, firstSeenTimestamp }] } }
//   or: { tags: [...] } (some firmware versions omit the data wrapper)
router.post("/timing/zebra-crossing", async (req, res) => {
  const eventId = Number(req.query.eventId);
  if (!eventId || isNaN(eventId)) {
    return res.status(400).json({ error: "eventId query param is required" });
  }

  const _staffCId = getStaffClubId(res);
  if (_staffCId !== null) {
    const [_evtRow] = await db.select({ clubId: eventsTable.clubId }).from(eventsTable).where(eq(eventsTable.id, eventId));
    if (!_evtRow || _evtRow.clubId !== _staffCId) return res.status(403).json({ error: "Forbidden" });
  }

  const body = req.body as any;
  const tags: any[] = Array.isArray(body?.data?.tags)
    ? body.data.tags
    : Array.isArray(body?.tags)
    ? body.tags
    : [];

  if (tags.length === 0) {
    return res.json({ ok: true, processed: 0, note: "No tags in payload" });
  }

  const moto = await getActiveMotoForEvent(eventId);
  if (!moto) {
    return res.status(409).json({ error: "No moto currently in progress for this event" });
  }

  const results: unknown[] = [];
  for (const tag of tags) {
    const rfidNumber = ((tag.idHex || tag.epc) as string | undefined ?? "").toUpperCase();
    if (!rfidNumber) {
      results.push({ error: "Tag missing idHex/epc field" });
      continue;
    }
    const crossingTime = ingestCrossingTime(tag.firstSeenTimestamp, "legacy_zebra_ingest");
    if (isNaN(crossingTime.getTime())) {
      results.push({ rfidNumber, error: "Invalid firstSeenTimestamp" });
      continue;
    }
    try {
      const result = await processCrossing({
        rfidNumber,
        motoId: moto.id,
        crossingTime,
        readerId: "zebra-fx7500",
        antennaId: tag.antennaPort,
      });
      if (result.debounced) {
        results.push({ rfidNumber, debounced: true });
      } else {
        results.push({ rfidNumber, crossingId: result.crossing?.id, lapNumber: result.lapNumber, lapTimeMs: result.lapTimeMs });
      }
    } catch (err: any) {
      results.push({ rfidNumber, error: err.message });
    }
  }

  return res.json({ ok: true, processed: tags.length, motoId: moto.id, results });
});

// POST /timing/mylaps-crossing?eventId=N — legacy endpoint for Active Transponder Timing.
// Body: { transponder: "12345", passingTime: "2026-05-27T14:32:01.123Z", loopId?: "finish-line-1" }
//   rfidNumber is accepted as an alias for legacy bridge compatibility.
router.post("/timing/mylaps-crossing", async (req, res) => {
  const eventId = Number(req.query.eventId);
  if (!eventId || isNaN(eventId)) {
    return res.status(400).json({ error: "eventId query param is required" });
  }

  const _staffCId = getStaffClubId(res);
  if (_staffCId !== null) {
    const [_evtRow] = await db.select({ clubId: eventsTable.clubId }).from(eventsTable).where(eq(eventsTable.id, eventId));
    if (!_evtRow || _evtRow.clubId !== _staffCId) return res.status(403).json({ error: "Forbidden" });
  }

  const body = req.body as any;
  // Accept common active-transponder field names.
  const transponder: string | undefined =
    body?.transponder ?? body?.rfidNumber ?? body?.transponderId ?? body?.id;

  if (!transponder) {
    return res.status(400).json({
      error: "Missing transponder field — expected 'transponder', 'rfidNumber', or 'transponderId'",
    });
  }

  // Accept: passingTime / crossingTime / timestamp / passTime
  const rawTime: string | undefined =
    body?.passingTime ?? body?.crossingTime ?? body?.timestamp ?? body?.passTime;

  const crossingTime = ingestDirectActiveCrossingTime(rawTime, body, "legacy_active_ingest");

  const moto = await getActiveMotoForEvent(eventId);
  if (!moto) {
    return res.status(409).json({ error: "No moto currently in progress for this event" });
  }

  const readerId: string = body?.loopId ?? body?.readerId ?? "active-transponder";

  try {
    const result = await processCrossing({
      rfidNumber: String(transponder),
      motoId: moto.id,
      crossingTime,
      readerId,
    });

    if (result.debounced) {
      return res.json({ ok: true, debounced: true, motoId: moto.id });
    }

    return res.json({
      ok: true,
      motoId: moto.id,
      crossingId: result.crossing?.id,
      lapNumber: result.lapNumber,
      lapTime: result.lapTimeMs != null ? formatLapTime(result.lapTimeMs) : null,
      lapTimeMs: result.lapTimeMs,
    });
  } catch (err: any) {
    return res.status(409).json({ error: err.message });
  }
});

// POST /timing/manual-crossing — record a lap for a rider by riderId (no RFID required)
router.post("/timing/manual-crossing", async (req, res) => {
  try {
    const session = req.session as any;
    if (!session?.userId) return res.status(401).json({ error: "Unauthorized" });

    const { riderId, motoId } = req.body;
    if (!riderId || !motoId) return res.status(400).json({ error: "riderId and motoId are required" });

    const [moto] = await db.select().from(motosTable).where(eq(motosTable.id, Number(motoId)));
    if (!moto) return res.status(404).json({ error: `Moto ${motoId} not found` });

    const [sessionUser] = await db
      .select({ clubId: usersTable.clubId, role: usersTable.role })
      .from(usersTable)
      .where(eq(usersTable.id, session.userId));
    if (!sessionUser) return res.status(401).json({ error: "Unauthorized" });

    if (sessionUser.role !== "super_admin") {
      const [event] = await db
        .select({ clubId: eventsTable.clubId })
        .from(eventsTable)
        .where(eq(eventsTable.id, moto.eventId));
      if (!event || event.clubId !== sessionUser.clubId) {
        return res.status(403).json({ error: "Forbidden: not your event" });
      }
    }

    // Use the rider's assigned RFID if available, so manual and hardware crossings share one sequence
    const assignments = await db
      .select({ rfidNumber: rfidAssignmentsTable.rfidNumber })
      .from(rfidAssignmentsTable)
      .where(and(eq(rfidAssignmentsTable.riderId, Number(riderId)), eq(rfidAssignmentsTable.eventId, moto.eventId)));

    const rfidNumber = assignments[0]?.rfidNumber ?? `MANUAL-${riderId}`;

    const result = await processCrossing({
      rfidNumber,
      motoId: Number(motoId),
      crossingTime: new Date(),
      readerId: "MANUAL",
      bypassDebounce: true,
      overrideRiderId: Number(riderId),
    });
    return res.json({
      ok: true,
      crossingId: result.crossing?.id ?? null,
      lapNumber: result.lapNumber,
      lapTime: result.lapTimeMs != null ? formatLapTime(result.lapTimeMs) : null,
      lapTimeMs: result.lapTimeMs,
      enduroAction: (result as any).enduroAction ?? null,
      elapsedMs: (result as any).elapsedMs ?? null,
      elapsed: (result as any).elapsedMs != null ? formatLapTime((result as any).elapsedMs) : null,
    });
  } catch (err: any) {
    const status = typeof err.status === "number" ? err.status : 500;
    return res.status(status).json({ error: err.message ?? "Internal server error" });
  }
});

// GET /timing/live/:motoId — SSE stream for live leaderboard
router.get("/timing/live/:motoId", async (req, res) => {
  const motoId = Number(req.params.motoId);
  const staffCId = getStaffClubId(res);
  if (!await checkMotoClubAccess(motoId, staffCId)) return res.status(403).json({ error: "Forbidden" });

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("Access-Control-Allow-Origin", "*");
  (res as any).flushHeaders?.();

  // Send initial state immediately
  const snapshot = await buildLeaderboard(motoId);
  if (snapshot) {
    (res as any).write(`data: ${JSON.stringify(snapshot)}\n\n`);
  } else {
    (res as any).write(`data: ${JSON.stringify({ error: "Moto not found" })}\n\n`);
  }

  sseSubscribe(motoId, res);

  // Heartbeat every 20s to prevent proxy timeouts
  const heartbeat = setInterval(() => {
    try {
      (res as any).write(": heartbeat\n\n");
    } catch {
      clearInterval(heartbeat);
    }
  }, 20_000);

  req.on("close", () => {
    clearInterval(heartbeat);
    sseUnsubscribe(motoId, res);
  });

  return;
});

router.get("/timing/announcer-live/:motoId", async (req, res) => {
  const motoId = Number(req.params.motoId);
  const staffCId = getStaffClubId(res);
  if (!await checkMotoClubAccess(motoId, staffCId)) return res.status(403).json({ error: "Forbidden" });

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("Access-Control-Allow-Origin", "*");
  (res as any).flushHeaders?.();

  const state = getAnnouncerState(motoId);
  (res as any).write(`data: ${JSON.stringify({
    type: "announcement-state",
    announcement: activeAnnouncement(state),
    sequence: state.sequence,
  })}\n\n`);
  announcerSubscribe(motoId, res);

  const heartbeat = setInterval(() => {
    try {
      (res as any).write(": heartbeat\n\n");
    } catch {
      clearInterval(heartbeat);
    }
  }, 20_000);
  req.on("close", () => {
    clearInterval(heartbeat);
    announcerUnsubscribe(motoId, res);
  });
  return;
});

router.get("/timing/announcer-audio/:eventId", (req, res) => {
  const audio = announcerAudio.get(req.params.eventId);
  if (!audio) return res.status(404).json({ error: "Announcement audio expired" });
  res.setHeader("Content-Type", "audio/mpeg");
  res.setHeader("Cache-Control", "public, max-age=300, immutable");
  return res.send(audio.buffer);
});

// GET /timing/crossings/:motoId — all raw crossings (debug / replay)
router.get("/timing/crossings/:motoId", async (req, res) => {
  const motoId = Number(req.params.motoId);
  const staffCId = getStaffClubId(res);
  if (!await checkMotoClubAccess(motoId, staffCId)) return res.status(403).json({ error: "Forbidden" });
  const crossings = await db
    .select({
      id: lapCrossingsTable.id,
      rfidNumber: lapCrossingsTable.rfidNumber,
      riderId: lapCrossingsTable.riderId,
      eventId: lapCrossingsTable.eventId,
      crossingTime: lapCrossingsTable.crossingTime,
      lapNumber: lapCrossingsTable.lapNumber,
      lapTimeMs: lapCrossingsTable.lapTimeMs,
      readerId: lapCrossingsTable.readerId,
      firstName: ridersTable.firstName,
      lastName: ridersTable.lastName,
    })
    .from(lapCrossingsTable)
    .leftJoin(ridersTable, eq(lapCrossingsTable.riderId, ridersTable.id))
    .where(eq(lapCrossingsTable.motoId, motoId))
    .orderBy(asc(lapCrossingsTable.crossingTime));

  // Fallback: crossings recorded before the RFID assignment existed have riderId=null
  // and therefore miss the join above. Look them up via rfid_assignments so the feed
  // always shows a name when the rider is registered for this event.
  const nameByRfid = new Map<string, { firstName: string | null; lastName: string | null }>();
  const unnamedRfids = [...new Set(crossings.filter(c => !c.firstName).map(c => c.rfidNumber))];
  if (unnamedRfids.length > 0) {
    const eventId = crossings.find(c => !c.firstName)!.eventId;
    const assignments = await db
      .select({
        rfidNumber: rfidAssignmentsTable.rfidNumber,
        firstName: ridersTable.firstName,
        lastName: ridersTable.lastName,
      })
      .from(rfidAssignmentsTable)
      .leftJoin(ridersTable, eq(rfidAssignmentsTable.riderId, ridersTable.id))
      .where(and(
        eq(rfidAssignmentsTable.eventId, eventId),
        inArray(rfidAssignmentsTable.rfidNumber, unnamedRfids),
      ));
    for (const a of assignments) nameByRfid.set(a.rfidNumber, { firstName: a.firstName, lastName: a.lastName });
  }

  return res.json(
    crossings.map((c) => {
      const firstName = c.firstName ?? nameByRfid.get(c.rfidNumber)?.firstName ?? null;
      const lastName = c.lastName ?? nameByRfid.get(c.rfidNumber)?.lastName ?? null;
      return {
        id: c.id,
        rfidNumber: c.rfidNumber,
        riderId: c.riderId,
        crossingTime: c.crossingTime.toISOString(),
        lapNumber: c.lapNumber,
        lapTimeMs: c.lapTimeMs,
        readerId: c.readerId,
        riderName: firstName ? `${firstName} ${lastName}` : null,
        lapTime: c.lapTimeMs ? formatLapTime(c.lapTimeMs) : null,
      };
    })
  );
});

// DELETE /timing/crossings/:crossingId — remove a phantom/bad crossing and recalculate results
router.delete("/timing/crossings/:crossingId", async (req, res) => {
  // ── Auth: must be a logged-in organizer ──────────────────────────────────
  const session = req.session as any;
  if (!session?.userId) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  const crossingId = Number(req.params.crossingId);
  if (!crossingId || isNaN(crossingId)) {
    return res.status(400).json({ error: "Invalid crossingId" });
  }

  // Load the crossing to delete
  const [crossing] = await db
    .select()
    .from(lapCrossingsTable)
    .where(eq(lapCrossingsTable.id, crossingId));

  if (!crossing) {
    return res.status(404).json({ error: "Crossing not found" });
  }

  const { motoId, rfidNumber, riderId } = crossing;

  // Load the moto (need startedAt for lap time recalculation)
  const [moto] = await db.select().from(motosTable).where(eq(motosTable.id, motoId));
  if (!moto) return res.status(404).json({ error: "Moto not found" });

  // ── Ownership check: session user must belong to the same club as the event ──
  const [sessionUser] = await db
    .select({ clubId: usersTable.clubId, role: usersTable.role })
    .from(usersTable)
    .where(eq(usersTable.id, session.userId));

  if (!sessionUser) return res.status(401).json({ error: "Unauthorized" });

  if (sessionUser.role !== "super_admin") {
    const [event] = await db
      .select({ clubId: eventsTable.clubId })
      .from(eventsTable)
      .where(eq(eventsTable.id, moto.eventId));

    if (!event || event.clubId !== sessionUser.clubId) {
      return res.status(403).json({ error: "Forbidden: not your event" });
    }
  }

  // ── All mutations in a single transaction ────────────────────────────────
  const newLapTimes: number[] = [];

  await db.transaction(async (tx) => {
    // Delete the crossing
    await tx.delete(lapCrossingsTable).where(eq(lapCrossingsTable.id, crossingId));

    // Reload remaining crossings for this rfid+moto in time order
    const remaining = await tx
      .select()
      .from(lapCrossingsTable)
      .where(and(eq(lapCrossingsTable.motoId, motoId), eq(lapCrossingsTable.rfidNumber, rfidNumber)))
      .orderBy(asc(lapCrossingsTable.crossingTime));

    // Renumber crossings and recalculate lap times
    for (let i = 0; i < remaining.length; i++) {
      const c = remaining[i];
      const prevTime = i === 0 ? moto.startedAt! : remaining[i - 1].crossingTime;
      const lapTimeMs = new Date(c.crossingTime).getTime() - new Date(prevTime).getTime();
      const lapNumber = i + 1;
      await tx
        .update(lapCrossingsTable)
        .set({ lapNumber, lapTimeMs })
        .where(eq(lapCrossingsTable.id, c.id));
      newLapTimes.push(lapTimeMs);
    }

    // Update race_results for this rider
    if (riderId) {
      const existingResults = await tx
        .select()
        .from(raceResultsTable)
        .where(and(eq(raceResultsTable.motoId, motoId), eq(raceResultsTable.riderId, riderId)));

      if (existingResults[0]) {
        if (newLapTimes.length === 0) {
          // No laps left — remove the result row entirely
          await tx.delete(raceResultsTable).where(eq(raceResultsTable.id, existingResults[0].id));
        } else {
          const totalMs = newLapTimes.reduce((s, t) => s + t, 0);
          await tx
            .update(raceResultsTable)
            .set({ lapTimes: newLapTimes, totalTime: formatLapTime(totalMs) })
            .where(eq(raceResultsTable.id, existingResults[0].id));
        }
      }

      // Recalculate positions for all riders in moto
      const allResults = await tx
        .select()
        .from(raceResultsTable)
        .where(eq(raceResultsTable.motoId, motoId));

      const sorted = allResults
        .map((r) => {
          const laps = Array.isArray(r.lapTimes) ? (r.lapTimes as number[]) : [];
          return { id: r.id, laps: laps.length, totalMs: laps.reduce((s, t) => s + t, 0) };
        })
        .sort((a, b) => b.laps - a.laps || a.totalMs - b.totalMs);

      for (let i = 0; i < sorted.length; i++) {
        await tx
          .update(raceResultsTable)
          .set({ position: i + 1 })
          .where(eq(raceResultsTable.id, sorted[i].id));
      }
    }
  });

  // Broadcast updated leaderboard (outside transaction — read-only)
  // Include correction: true so live viewers know a crossing was removed
  const snapshot = await buildLeaderboard(motoId);
  if (snapshot) sseBroadcast(motoId, { ...snapshot, correction: true });

  return res.json({ ok: true });
});

// GET /timing/leaderboard/:motoId — snapshot (polling fallback)
router.get("/timing/leaderboard/:motoId", async (req, res) => {
  const motoId = Number(req.params.motoId);
  const staffCId = getStaffClubId(res);
  if (!await checkMotoClubAccess(motoId, staffCId)) return res.status(403).json({ error: "Forbidden" });
  const snapshot = await buildLeaderboard(motoId);
  if (!snapshot) return res.status(404).json({ error: "Moto not found" });
  return res.json(snapshot);
});

// ── RMonitor live feed (SSE) — consumed by rfid_bridge.py --rmonitor ──────────
// Each SSE event carries a JSON payload: { lines: string[] }
// Lines are raw RMonitor protocol strings WITHOUT \r\n (bridge adds them on TCP send).
router.get("/timing/rmonitor-feed", async (req, res) => {
  const eventId = Number(req.query.eventId);
  if (!eventId || isNaN(eventId)) {
    return res.status(400).json({ error: "eventId is required" });
  }
  const staffCId = getStaffClubId(res);
  if (!await checkEventClubAccess(eventId, staffCId)) return res.status(403).json({ error: "Forbidden" });

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("Access-Control-Allow-Origin", "*");
  (res as any).flushHeaders?.();

  // Send initial snapshot so the bridge can greet newly-connected TCP clients
  const activeMoto = await db
    .select()
    .from(motosTable)
    .where(and(eq(motosTable.eventId, eventId), eq(motosTable.status, "in_progress")))
    .limit(1);

  if (activeMoto[0]) {
    const snap = await buildLeaderboard(activeMoto[0].id);
    if (snap) {
      const lines = buildRMonitorLines(snap);
      (res as any).write(`data: ${JSON.stringify({ lines, snapshot: true })}\n\n`);
    }
  }

  rmonitorSubscribe(eventId, res);

  const heartbeat = setInterval(() => {
    try {
      const now = new Date();
      const hh = String(now.getHours()).padStart(2, "0");
      const mm = String(now.getMinutes()).padStart(2, "0");
      const ss = String(now.getSeconds()).padStart(2, "0");
      const heartLine = `$E,"DATE","${now.toLocaleDateString("en-US")}","${hh}:${mm}:${ss}"`;
      (res as any).write(`data: ${JSON.stringify({ lines: [heartLine], heartbeat: true })}\n\n`);
    } catch {
      clearInterval(heartbeat);
    }
  }, 20_000);

  req.on("close", () => {
    clearInterval(heartbeat);
    rmonitorUnsubscribe(eventId, res);
  });

  return;
});

// ── RMonitor snapshot — returns full initial state as array of protocol lines ──
// Called by the bridge on new TCP client connect to pre-load state.
router.get("/timing/rmonitor-snapshot", async (req, res) => {
  const eventId = Number(req.query.eventId);
  if (!eventId || isNaN(eventId)) {
    return res.status(400).json({ error: "eventId is required" });
  }
  const staffCId = getStaffClubId(res);
  if (!await checkEventClubAccess(eventId, staffCId)) return res.status(403).json({ error: "Forbidden" });

  // Prefer in-progress moto; fall back to most recent completed
  const [activeMoto] = await db
    .select()
    .from(motosTable)
    .where(and(eq(motosTable.eventId, eventId), eq(motosTable.status, "in_progress")))
    .limit(1);

  const moto = activeMoto ?? (await db
    .select()
    .from(motosTable)
    .where(eq(motosTable.eventId, eventId))
    .orderBy(asc(motosTable.id))
    .limit(1))[0];

  if (!moto) return res.json({ lines: [] });

  const snap = await buildLeaderboard(moto.id);
  if (!snap) return res.json({ lines: [] });

  return res.json({ lines: buildRMonitorLines(snap) });
});

// ── RMonitor status — how many bridge SSE subscribers are active ───────────────
router.get("/timing/rmonitor-status", async (req, res) => {
  const eventId = Number(req.query.eventId);
  if (!eventId || isNaN(eventId)) {
    return res.status(400).json({ error: "eventId is required" });
  }
  const staffCId = getStaffClubId(res);
  if (!await checkEventClubAccess(eventId, staffCId)) return res.status(403).json({ error: "Forbidden" });
  return res.json({ bridges: rmonitorClientCount(eventId) });
});

// ── Announcer voice & script generation ──────────────────────────────────────

const ANNOUNCER_VOICE_INSTRUCTIONS = `You are a booming, deep-voiced professional motorsports announcer — the voice of Supercross and AMA motocross. \
Deliver every word with maximum energy, drama, and passion. \
Speak in a powerful, resonant baritone. Vary your pacing — build tension, pause on big moments, then hit the crowd with explosive energy. \
Sound like you are in a packed stadium with 60,000 fans on their feet. Every race is the most important race in the world.`;

/** Pick a random element from an array. */
function pick<T>(arr: T[]): T { return arr[Math.floor(Math.random() * arr.length)]; }

/**
 * Expand common abbreviations in moto/class names so the TTS engine
 * pronounces them correctly.
 *   "Div 1" → "Division 1"   "Div1" → "Division 1"
 *   "Div." → "Division"
 */
function expandAbbrev(s: string | null): string | null {
  if (!s) return s;
  return s.replace(/\bDiv\.?\s*(\d*)/gi, (_, n) => n ? `Division ${n}` : "Division").trim();
}

/** Build a fact-only race-start script from known data — no invented history or countdowns. */
function buildStartScript(opts: {
  typeLabel: string;
  raceClass: string | null;
  motoName: string | null;
  riders: Array<{ bibNumber: string | null; riderName: string | null }>;
}): string {
  const { typeLabel, riders } = opts;
  const raceClass = expandAbbrev(opts.raceClass);
  const motoName  = expandAbbrev(opts.motoName);

  const openings = [
    "Alright folks, eyes on the track — it is race time!",
    "Your attention please everyone — we are about to get underway!",
    "Let's get loud in here — it's time to race!",
    "Alright ladies and gentlemen — here we go!",
    "Listen up everybody — this next moto is ready to go!",
  ];

  const classIntros = raceClass
    ? [
        `Coming to the gate right now — ${raceClass}, ${typeLabel}!`,
        `Up next on track — the ${raceClass} ${typeLabel}!`,
        `We have the ${raceClass} ${typeLabel} ready to go!`,
        `The gate is set — ${raceClass}, ${typeLabel} is up!`,
        `Next up — ${raceClass} in the ${typeLabel}!`,
      ]
    : [
        `Coming to the gate — the ${typeLabel} is up!`,
        `Next on track — the ${typeLabel} is ready to go!`,
        `The ${typeLabel} is set — here we go!`,
      ];

  const validRiders = riders.filter(r => r.riderName);

  let riderLine = "";
  if (validRiders.length > 0) {
    const names = validRiders.map(r =>
      r.bibNumber ? `number ${r.bibNumber}, ${r.riderName}` : r.riderName!
    );
    const listStr = names.length === 1
      ? names[0]
      : names.slice(0, -1).join("; ") + "; and " + names[names.length - 1];
    const riderIntros = [
      `Taking the gate today: ${listStr}.`,
      `At the gate we have: ${listStr}.`,
      `Lined up and ready: ${listStr}.`,
      `Our competitors for this moto: ${listStr}.`,
    ];
    riderLine = pick(riderIntros);
  }

  const closings = [
    "Let's hear it for these riders — let's race!",
    "Give it up for the competitors — it's race time!",
    "Get on your feet, folks — this moto is about to get underway!",
    "What a field — let's see what they've got on track today!",
    "Buckle up — this one is about to go!",
  ];

  const parts = [pick(openings), pick(classIntros)];
  if (motoName) parts.push(`This is ${motoName}.`);
  if (riderLine) parts.push(riderLine);
  parts.push(pick(closings));
  return parts.join(" ");
}

function buildRaceUnderwayScript(opts: {
  typeLabel: string;
  raceClass: string | null;
  motoName: string | null;
}): string {
  const raceClass = expandAbbrev(opts.raceClass);
  const motoName = expandAbbrev(opts.motoName);
  return [
    pick([
      "The gate has dropped — we are racing!",
      "And they are off — this race is underway!",
      "Here we go — racing is live on track!",
    ]),
    raceClass ? `${raceClass}, ${opts.typeLabel} is underway.` : `The ${opts.typeLabel} is underway.`,
    motoName ? `This is ${motoName}.` : null,
  ].filter(Boolean).join(" ");
}

// ── Announcement script builder (pure code — no LLM needed) ───────────────────

interface Top5Entry {
  position: number;
  riderName: string;
  laps: number;
  lastLap: string | null;
  totalTime: string | null;
  gap: string;
  dnf?: boolean;
  dns?: boolean;
}

interface PositionChange {
  riderName: string;
  from: number;
  to: number;
}

function buildAnnouncementScript(opts: {
  lapCompleted: number;
  top5: Top5Entry[];
  positionChanges: PositionChange[];
  isComplete: boolean;
}): string {
  const { lapCompleted, top5, positionChanges, isComplete } = opts;

  const ORDINALS = ["", "first", "second", "third", "fourth", "fifth", "sixth", "seventh", "eighth", "ninth", "tenth"];
  const CARDINALS = ["", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten",
    "eleven", "twelve", "thirteen", "fourteen", "fifteen", "sixteen", "seventeen", "eighteen", "nineteen", "twenty"];

  function lapWord(n: number): string {
    return n < CARDINALS.length ? CARDINALS[n] : String(n);
  }

  function posWord(n: number): string {
    return n <= 5 ? ORDINALS[n] : `${n}th`;
  }

  // Parse "M:SS.cc" gap string → natural English
  function gapToSpeech(gap: string): string | null {
    if (!gap || gap === "Leader" || gap === "—") return null;
    // Never say "N laps back" — lap-down riders are excluded by the caller;
    // if one slips through, silently omit rather than speak confusing lap counts.
    if (/^\+\d+\s+laps?/.test(gap)) return null;
    const timeMatch = gap.match(/^\+(\d+):(\d+)\.(\d+)/);
    if (!timeMatch) return null;
    const mins = parseInt(timeMatch[1]);
    const secs = parseInt(timeMatch[2]);
    const cents = parseInt(timeMatch[3]);
    if (mins === 0) {
      const tenths = Math.round(cents / 10);
      return tenths > 0 ? `${secs} point ${tenths} seconds back` : `${secs} seconds back`;
    }
    const tenths = Math.round(cents / 10);
    const secStr = tenths > 0 ? `${secs} point ${tenths} seconds` : `${secs} seconds`;
    return `${mins} minute${mins > 1 ? "s" : ""} and ${secStr} back`;
  }

  // Format total time "M:SS.cc" → natural speech
  function totalToSpeech(t: string | null): string | null {
    if (!t) return null;
    const m = t.match(/^(\d+):(\d+)\.(\d+)/);
    if (!m) return null;
    const mins = parseInt(m[1]);
    const secs = parseInt(m[2]);
    const cents = parseInt(m[3]);
    const tenths = Math.round(cents / 10);
    const secStr = tenths > 0 ? `${secs} point ${tenths}` : String(secs);
    if (mins === 0) return `${secStr} seconds`;
    return `${mins} minute${mins > 1 ? "s" : ""} and ${secStr} seconds`;
  }

  const parts: string[] = [];

  if (isComplete) {
    parts.push(pick([
      "Checkered flag!",
      "That's the checkered flag!",
      "And there it is — checkered flag!",
      "We have a winner!",
    ]));
    const winner = top5[0];
    if (winner) {
      const timeStr = totalToSpeech(winner.totalTime);
      parts.push(pick([
        `${winner.riderName} takes the win${timeStr ? ` in ${timeStr}` : ""}!`,
        `${winner.riderName} crosses the line first${timeStr ? ` — ${timeStr}` : ""}!`,
        `It's ${winner.riderName} for the win${timeStr ? ` in ${timeStr}` : ""}!`,
      ]));
    }
    if (top5[1]) parts.push(pick([
      `${top5[1].riderName} crosses in second.`,
      `${top5[1].riderName} finishes second.`,
      `Second place goes to ${top5[1].riderName}.`,
    ]));
    if (top5[2]) parts.push(pick([
      `${top5[2].riderName} rounds out the podium.`,
      `${top5[2].riderName} takes third.`,
      `And ${top5[2].riderName} in third — completing the podium.`,
    ]));
    if (top5[3]) parts.push(`${top5[3].riderName} finishes fourth.`);
  } else {
    // Lead with position changes first — most dramatic
    for (const change of positionChanges) {
      if (change.to < change.from) {
        parts.push(pick([
          `${change.riderName} makes a move — up to ${posWord(change.to)}!`,
          `${change.riderName} is charging — moving up to ${posWord(change.to)}!`,
          `What a pass — ${change.riderName} into ${posWord(change.to)}!`,
          `${change.riderName} makes it happen — up to ${posWord(change.to)} position!`,
        ]));
      }
    }

    // Lap callout
    const lapStr = lapCompleted < CARDINALS.length ? CARDINALS[lapCompleted] : String(lapCompleted);
    parts.push(pick([
      `Lap ${lapStr} is complete.`,
      `That's lap ${lapStr} in the books.`,
      `Through lap ${lapStr} now.`,
      `Lap ${lapStr} done.`,
    ]));

    // Leader
    const leader = top5[0];
    if (leader) {
      const timeStr = totalToSpeech(leader.totalTime);
      parts.push(pick([
        `${leader.riderName} leads${timeStr ? `, ${timeStr} on the clock` : ""}.`,
        `${leader.riderName} out front${timeStr ? ` — ${timeStr}` : ""}.`,
        `${leader.riderName} in the lead${timeStr ? ` with ${timeStr} elapsed` : ""}.`,
      ]));
    }

    // P2–P5: only call out riders who are on the same lap as the leader.
    // A rider who is laps down does not have a meaningful positional
    // relationship to the leader — saying "in second, 2 laps back" is
    // both misleading and incorrect when most of the field hasn't yet
    // crossed the timing line.
    const leaderLaps = leader?.laps ?? 0;
    for (let i = 1; i < Math.min(top5.length, 5); i++) {
      const r = top5[i];
      if (r.dnf || r.dns) continue;
      if (r.laps < leaderLaps) continue; // skip riders who are a lap or more behind
      const gapStr = gapToSpeech(r.gap);
      if (gapStr) {
        parts.push(pick([
          `${r.riderName} running ${posWord(r.position)}, ${gapStr}.`,
          `${r.riderName} in ${posWord(r.position)}, ${gapStr}.`,
          `${posWord(r.position).charAt(0).toUpperCase() + posWord(r.position).slice(1)} place — ${r.riderName}, ${gapStr}.`,
        ]));
      } else {
        parts.push(`${r.riderName} in ${posWord(r.position)}.`);
      }
    }
  }

  return parts.join(" ");
}

async function createSharedAnnouncement(
  motoId: number,
  state: AnnouncerState,
  kind: AnnouncerEvent["kind"],
  lap: number,
  script: string,
  label: string,
  persistMarker?: () => Promise<boolean>,
) {
  const audioBuffer = await textToSpeech(script, "onyx", "mp3", ANNOUNCER_VOICE_INSTRUCTIONS);
  if (persistMarker && !await persistMarker()) return;
  const sequence = ++state.sequence;
  const id = `${motoId}-${Date.now()}-${sequence}`;
  announcerAudio.set(id, { buffer: audioBuffer, createdAt: Date.now() });
  const announcement: AnnouncerEvent = {
    id,
    sequence,
    kind,
    lap,
    createdAt: new Date().toISOString(),
    audioUrl: `/api/timing/announcer-audio/${id}`,
    label,
  };
  state.currentEvent = announcement;
  broadcastAnnouncement(motoId, announcement);
  setTimeout(() => announcerAudio.delete(id), 10 * 60_000).unref?.();
}

async function processSharedAnnouncer(snapshot: LeaderboardSnapshot): Promise<void> {
  const state = getAnnouncerState(snapshot.motoId);
  const active = snapshot.leaderboard.filter(r => !r.dnf && !r.dns);
  hydrateAnnouncerLifecycle(state.lifecycle, {
    started: !!snapshot.announcerStartedAt,
    finished: !!snapshot.announcerFinishedAt,
    lastAnnouncedLap: snapshot.announcerLastLap,
  });
  if (state.lifecycle.previousPositions.size === 0 && state.lifecycle.lastAnnouncedLap > 0) {
    state.lifecycle.previousPositions = new Map(
      active.map(rider => [rider.riderId, rider.position ?? 9999]),
    );
  }
  const nextLifecycle: AnnouncerLifecycleState = {
    ...state.lifecycle,
    previousPositions: new Map(state.lifecycle.previousPositions),
  };
  const action = advanceAnnouncerLifecycle(
    nextLifecycle,
    snapshot.status,
    snapshot.leaderboard,
    snapshot.fieldSize,
  );
  if (action.kind === "start") {
    const typeLabel =
      snapshot.motoType === "heat" ? "heat race" :
      snapshot.motoType === "main" ? "main event" :
      snapshot.motoType === "practice" ? "practice session" :
      snapshot.motoType === "lcq" ? "last chance qualifier" :
      "race";
    const script = buildRaceUnderwayScript({
      typeLabel,
      raceClass: snapshot.raceClass,
      motoName: snapshot.motoName,
    });
    await createSharedAnnouncement(
      snapshot.motoId,
      state,
      "start",
      0,
      script,
      "Race starting!",
      async () => {
        const claimed = await db.update(motosTable)
          .set({ announcerStartedAt: new Date() })
          .where(and(
            eq(motosTable.id, snapshot.motoId),
            isNull(motosTable.announcerStartedAt),
          ))
          .returning({ id: motosTable.id });
        return claimed.length > 0;
      },
    );
    state.lifecycle = nextLifecycle;
    return;
  }
  if (action.kind === "none") {
    state.lifecycle = nextLifecycle;
    return;
  }
  const script = buildAnnouncementScript({
    lapCompleted: action.lap,
    top5: active.slice(0, 5) as Top5Entry[],
    positionChanges: action.kind === "lap" ? action.positionChanges : [],
    isComplete: action.kind === "finish",
  });
  await createSharedAnnouncement(
    snapshot.motoId,
    state,
    action.kind,
    action.lap,
    script,
    action.kind === "finish" ? "Race complete!" : `Lap ${action.lap} announced`,
    action.kind === "finish"
      ? async () => {
          const claimed = await db.update(motosTable)
            .set({ announcerFinishedAt: new Date() })
            .where(and(
              eq(motosTable.id, snapshot.motoId),
              isNull(motosTable.announcerFinishedAt),
            ))
            .returning({ id: motosTable.id });
          return claimed.length > 0;
        }
      : async () => {
          const claimed = await db.update(motosTable)
            .set({ announcerLastLap: action.lap })
            .where(and(
              eq(motosTable.id, snapshot.motoId),
              lt(motosTable.announcerLastLap, action.lap),
            ))
            .returning({ id: motosTable.id });
          return claimed.length > 0;
        },
  );
  state.lifecycle = nextLifecycle;
}

export function updateSharedAnnouncer(snapshot: LeaderboardSnapshot): Promise<void> {
  const state = getAnnouncerState(snapshot.motoId);
  state.pending = state.pending.catch(() => {}).then(async () => {
    if (state.retrySnapshot) {
      const retry = state.retrySnapshot;
      await processSharedAnnouncer(retry);
      state.retrySnapshot = null;
    }
    try {
      await processSharedAnnouncer(snapshot);
    } catch (error) {
      state.retrySnapshot ??= snapshot;
      throw error;
    }
  });
  return state.pending;
}

export function startSharedAnnouncer(snapshot: LeaderboardSnapshot): Promise<void> {
  return updateSharedAnnouncer({
    ...snapshot,
    status: "in_progress",
    leaderboard: snapshot.leaderboard.map(rider => ({ ...rider, laps: 0 })),
  });
}

export function publishTimingSnapshot(snapshot: LeaderboardSnapshot) {
  sseBroadcast(snapshot.motoId, snapshot);
  void updateSharedAnnouncer(snapshot).catch(() => {});
}

export async function resetSharedAnnouncer(motoId: number) {
  announcerStates.delete(motoId);
  await db.update(motosTable)
    .set({ announcerStartedAt: null, announcerLastLap: 0, announcerFinishedAt: null })
    .where(eq(motosTable.id, motoId));
}

// POST /timing/announce-moto-start — hype intro when organizer starts a moto
router.post("/timing/announce-moto-start", async (req, res) => {
  try {
    const { motoName, motoType, raceClass, lineup } = req.body as {
      motoName: string;
      motoType: string;
      raceClass: string | null;
      motoNumber: number | null;
      lineup: Array<{ bibNumber: string | null; riderName: string | null }>;
    };

    const typeLabel =
      motoType === "heat" ? "heat race" :
      motoType === "main" ? "main event" :
      motoType === "practice" ? "practice session" :
      motoType === "lcq" ? "last chance qualifier" :
      (motoType ?? "race");

    const script = buildStartScript({
      typeLabel,
      raceClass: raceClass ?? null,
      motoName: motoName ?? null,
      riders: lineup ?? [],
    });

    const audioBuffer = await textToSpeech(script, "onyx", "mp3", ANNOUNCER_VOICE_INSTRUCTIONS);
    res.setHeader("Content-Type", "audio/mpeg");
    res.setHeader("Cache-Control", "no-store");
    return res.send(audioBuffer);
  } catch (err: any) {
    req.log.error({ err }, "announce-moto-start TTS error");
    return res.status(500).json({ error: "Failed to generate announcement" });
  }
});

// POST /timing/announce — generate AI voice announcement for current leaderboard
router.post("/timing/announce", async (req, res) => {
  try {
    const { lapCompleted, top5, positionChanges = [], isComplete = false } = req.body as {
      lapCompleted: number;
      top5: Top5Entry[];
      positionChanges: PositionChange[];
      isComplete: boolean;
    };

    if (!Array.isArray(top5) || top5.length === 0) {
      return res.status(400).json({ error: "top5 array is required" });
    }

    const script = buildAnnouncementScript({ lapCompleted, top5, positionChanges, isComplete });
    const audioBuffer = await textToSpeech(script, "onyx", "mp3", ANNOUNCER_VOICE_INSTRUCTIONS);

    res.setHeader("Content-Type", "audio/mpeg");
    res.setHeader("Cache-Control", "no-store");
    return res.send(audioBuffer);
  } catch (err: any) {
    req.log.error({ err }, "announce TTS error");
    return res.status(500).json({ error: "Failed to generate announcement" });
  }
});

export default router;
