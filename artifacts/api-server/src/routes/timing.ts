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
} from "@workspace/db";
import { fetchEnduoPenaltyMap } from "./enduro-scoring";
import { eq, and, asc, desc, isNotNull, or, gt, sql } from "drizzle-orm";
import type { Response } from "express";
import { textToSpeech } from "@workspace/integrations-openai-ai-server/audio";
import { processPracticeCrossing } from "./practice";

const router = Router();

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
// All times in "M:SS.cc" (centiseconds) — the standard AMB/MyLaps format.
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

// ── Leaderboard snapshot from current race_results ─────────────────────────────
export async function buildLeaderboard(motoId: number) {
  const [moto] = await db.select().from(motosTable).where(eq(motosTable.id, motoId));
  if (!moto) return null;

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
    const lapMs = raw.map(normalizeLapMs);
    const totalMs = lapMs.reduce((s, t) => s + t, 0);
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
      totalTime: lapMs.length ? formatLapTime(totalMs) : null,
      dnf: r.dnf,
      dns: r.dns,
    };
  });

  // Compute gaps relative to leader
  const leader = leaderboard[0];
  const withGaps = leaderboard.map((entry) => {
    if (!leader || entry.position === 1) return { ...entry, gap: "Leader" };
    if (entry.laps < leader.laps)
      return { ...entry, gap: `+${leader.laps - entry.laps} lap${leader.laps - entry.laps > 1 ? "s" : ""}` };
    return {
      ...entry,
      gap: entry.totalMs > 0 && leader.totalMs > 0 ? `+${formatLapTime(entry.totalMs - leader.totalMs)}` : "—",
    };
  });

  return {
    motoId,
    motoName: moto.name,
    raceClass: moto.raceClass,
    status: moto.status,
    startedAt: moto.startedAt?.toISOString() ?? null,
    completedAt: moto.completedAt?.toISOString() ?? null,
    timeLimitMs: moto.timeLimitMs ?? null,
    plusLaps: moto.plusLaps ?? null,
    timeExpiredAt: moto.timeExpiredAt?.toISOString() ?? null,
    leaderboard: withGaps,
    updatedAt: new Date().toISOString(),
  };
}

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
  const { rfidNumber, motoId, crossingTime, readerId, antennaId, bypassDebounce, overrideRiderId } = opts;

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

    // Fallback: permanent rfid_number or mylaps_transponder_id on the rider's profile
    if (!riderId) {
      const [directRider] = await db
        .select({ id: ridersTable.id })
        .from(ridersTable)
        .where(or(
          eq(ridersTable.rfidNumber, rfidNumber),
          eq(ridersTable.mylapsTransponderId, rfidNumber),
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
      const gapMs = crossingTime.getTime() - new Date(last.crossingTime).getTime();
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
    for (let i = 0; i < enduroSorted.length; i++) {
      await db
        .update(raceResultsTable)
        .set({ position: i + 1 })
        .where(eq(raceResultsTable.id, enduroSorted[i].id));
    }

    const enduroSnapshot = await buildLeaderboard(motoId);
    if (enduroSnapshot) {
      sseBroadcast(motoId, enduroSnapshot);
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
    .orderBy(asc(lapCrossingsTable.crossingTime));

  // ── Debounce: reject burst reads from the same antenna pass ─────────────────
  // Skipped for manual crossings (organizer is intentionally pressing a button).
  if (!bypassDebounce && prevCrossings.length > 0) {
    const lastCrossing = prevCrossings[prevCrossings.length - 1];
    const gapMs = crossingTime.getTime() - new Date(lastCrossing.crossingTime).getTime();
    if (gapMs < debounceMs) {
      // Silent accept — not an error, just a duplicate burst read
      return { debounced: true, crossing: null, lapNumber: null, lapTimeMs: null };
    }
  }

  const lapNumber = prevCrossings.length + 1;
  const prevTime =
    prevCrossings.length > 0
      ? prevCrossings[prevCrossings.length - 1].crossingTime
      : moto.startedAt;
  const lapTimeMs = crossingTime.getTime() - new Date(prevTime).getTime();

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
      const newLaps = [...prevLaps, lapTimeMs];
      const totalMs = newLaps.reduce((s, t) => s + t, 0);
      await db
        .update(raceResultsTable)
        .set({ lapTimes: newLaps, totalTime: formatLapTime(totalMs) })
        .where(eq(raceResultsTable.id, existing[0].id));
    } else {
      const totalMs = lapTimeMs;
      await db.insert(raceResultsTable).values({
        eventId: moto.eventId,
        motoId,
        riderId,
        raceClass: moto.raceClass,
        position: 999,
        lapTimes: [lapTimeMs],
        totalTime: formatLapTime(totalMs),
        bibNumber: checkin?.bibNumber ?? null,
        dnf: false,
        dns: false,
      });
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

    for (let i = 0; i < sorted.length; i++) {
      await db
        .update(raceResultsTable)
        .set({ position: i + 1 })
        .where(eq(raceResultsTable.id, sorted[i].id));
    }
  }

  // 7. Build & broadcast leaderboard (JSON SSE for the live scoreboard widget)
  const snapshot = await buildLeaderboard(motoId);
  if (snapshot) {
    sseBroadcast(motoId, snapshot);
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
        if (completedSnapshot) sseBroadcast(motoId, completedSnapshot);
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

  const time = crossingTime ? new Date(crossingTime) : new Date();
  if (isNaN(time.getTime())) {
    return res.status(400).json({ error: "Invalid crossingTime" });
  }

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
//   • Generic / bridge:  { rfidNumber, crossingTime? }
//   • AMBrc / MyLaps:    { transponder, passingTime? }
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
    const moto = await getActiveMotoForClub(clubId);
    if (!moto) {
      const session = await getActivePracticeSessionForClub(clubId);
      if (!session) {
        return res.status(409).json({ error: "No moto in progress for this club", hint: "Start a moto from the Race Day tab first." });
      }
      const results: unknown[] = [];
      for (const tag of tagEvents) {
        const rfidNumber = tag.epcHex.toUpperCase();
        const crossingTime = tag.firstSeenTime ? new Date(tag.firstSeenTime) : new Date();
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
      const crossingTime = tag.firstSeenTime ? new Date(tag.firstSeenTime) : new Date();
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
    const moto = await getActiveMotoForClub(clubId);
    if (!moto) {
      const session = await getActivePracticeSessionForClub(clubId);
      if (!session) {
        return res.status(409).json({ error: "No moto in progress for this club", hint: "Start a moto from the Race Day tab first." });
      }
      const results: unknown[] = [];
      for (const tag of tagEvents) {
        const crossingTime = tag.timestamp ? new Date(tag.timestamp) : new Date();
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
      const crossingTime = tag.timestamp ? new Date(tag.timestamp) : new Date();
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
        const crossingTime = tag.firstSeenTimestamp ? new Date(tag.firstSeenTimestamp) : new Date();
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
      const crossingTime = tag.firstSeenTimestamp ? new Date(tag.firstSeenTimestamp) : new Date();
      try {
        const r = await processCrossing({ rfidNumber, motoId: moto.id, crossingTime, readerId: "zebra-fx7500", antennaId: tag.antennaPort });
        results.push(r.debounced ? { rfidNumber, debounced: true } : { rfidNumber, crossingId: r.crossing?.id, lapNumber: r.lapNumber, lapTimeMs: r.lapTimeMs });
      } catch (err: any) { results.push({ rfidNumber, error: err.message }); }
    }
    return res.json({ ok: true, processed: zebraTags.length, motoId: moto.id, results });
  }

  // ── Generic / AMBrc / MyLaps format ────────────────────────────────────────
  const rfidNumber: string | undefined =
    body?.rfidNumber ?? body?.transponder ?? body?.transponderId ?? body?.id;
  if (!rfidNumber) {
    return res.status(400).json({
      error: "Cannot extract tag/transponder ID — expected rfidNumber, transponder, transponderId, Impinj events[], or Zebra tags[]",
    });
  }
  const rawTime: string | undefined =
    body?.crossingTime ?? body?.passingTime ?? body?.timestamp ?? body?.passTime;
  const crossingTime = rawTime ? new Date(rawTime) : new Date();
  if (isNaN(crossingTime.getTime())) {
    return res.status(400).json({ error: "Invalid crossing time — must be ISO 8601" });
  }

  const moto = await getActiveMotoForClub(clubId);
  if (!moto) {
    const session = await getActivePracticeSessionForClub(clubId);
    if (!session) {
      return res.status(409).json({ error: "No moto in progress for this club", hint: "Start a moto from the Race Day tab first." });
    }
    try {
      const r = await processPracticeCrossing(session, String(rfidNumber), crossingTime);
      if ("skipped" in r) return res.json({ ok: true, skipped: true, practiceSessionId: session.id });
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

  // Generic / AMBrc / MyLaps
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
    const crossingTime = tag.firstSeenTime ? new Date(tag.firstSeenTime) : new Date();
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
    const crossingTime = tag.firstSeenTimestamp ? new Date(tag.firstSeenTimestamp) : new Date();
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

// POST /timing/mylaps-crossing?eventId=N — AMBrc / MyLaps native format
// Body: { transponder: "12345", passingTime: "2026-05-27T14:32:01.123Z", loopId?: "finish-line-1" }
//   or the AMBrc template variables already substituted (rfidNumber accepted as alias)
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
  // Accept: transponder / rfidNumber / transponderId (common AMBrc field names)
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

  const crossingTime = rawTime ? new Date(rawTime) : new Date();
  if (isNaN(crossingTime.getTime())) {
    return res.status(400).json({ error: "Invalid passingTime — must be ISO 8601" });
  }

  const moto = await getActiveMotoForEvent(eventId);
  if (!moto) {
    return res.status(409).json({ error: "No moto currently in progress for this event" });
  }

  const readerId: string = body?.loopId ?? body?.readerId ?? "mylaps";

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

  return res.json(
    crossings.map((c) => ({
      ...c,
      crossingTime: c.crossingTime.toISOString(),
      riderName: c.firstName ? `${c.firstName} ${c.lastName}` : null,
      lapTime: c.lapTimeMs ? formatLapTime(c.lapTimeMs) : null,
    }))
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
