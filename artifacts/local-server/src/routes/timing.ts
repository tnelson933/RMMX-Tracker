import { teamTagRider } from "../lib/group-teams";
import { Router } from "express";
import { compareStandings, computeFinishAt, everyoneFinished, finishGraceMs, flagTimeFor, scoreRider, type ScoringMoto } from "../lib/lapScoring";
import type { Response } from "express";
import { getDb, parseJsonArr, parseJson } from "../db";
import { rejectForeignBrowserIngest } from "../lib/request-origin";
import { LIVE_WINDOW_MS, resolvePracticeRider } from "./practice";
import {
  ENDURO_ALL_CLASSES,
  ENDURO_MAX_RUN_MS,
  EnduroCrossingRejected,
  pairEnduroRuns,
  recomputeEnduroPositionsForEvent,
  rerankEnduroTest,
  resolveEnduroRiderClass,
} from "../lib/enduroScoring";

const router = Router();
const MAX_CROSSING_FUTURE_MS = 5 * 60 * 1000;

// Must match the direct active provenance emitted by RM Connect, RM Roost,
// and the Python live TCP bridge. Generic/passive facility payloads are not
// included because an old timestamp may be a valid delayed upload.
export const TRUSTED_DIRECT_ACTIVE_TIMING_SOURCES = [
  "connector_live_tcp",
  "f2000_tcp",
  "f2000_device",
  "bridge_live_tcp",
] as const;

export function isTrustedDirectActiveTimingSource(...values: unknown[]): boolean {
  const trusted = new Set<string>(TRUSTED_DIRECT_ACTIVE_TIMING_SOURCES);
  return values.some(value =>
    typeof value === "string" && trusted.has(value.trim().toLowerCase()),
  );
}

function canonicalizeCrossingTimestamp(
  value: unknown,
  receivedAt = new Date(),
  source = "local_timing",
  rejectPastSkew = false,
): Date {
  const candidate = value instanceof Date ? value : new Date(value as string | number);
  if (
    !Number.isFinite(candidate.getTime())
    || candidate.getTime() > receivedAt.getTime() + MAX_CROSSING_FUTURE_MS
    || (rejectPastSkew && candidate.getTime() < receivedAt.getTime() - MAX_CROSSING_FUTURE_MS)
  ) {
    console.warn(JSON.stringify({
      event: "crossing_timestamp_canonicalized",
      source,
      suppliedTimestamp: Number.isFinite(candidate.getTime()) ? candidate.toISOString() : String(value),
      receivedAt: receivedAt.toISOString(),
    }));
    return receivedAt;
  }
  return candidate;
}

export function canonicalizeDirectActiveTimestamp(value: unknown, body: Record<string, unknown>, source: string): Date {
  const serverReceivedAt = new Date();
  const rawReceipt = body.receivedAtUtc ?? body.receivedAt;
  const suppliedReceipt = rawReceipt == null ? null : new Date(rawReceipt as string | number);
  const trustworthyReceipt = suppliedReceipt
    && Number.isFinite(suppliedReceipt.getTime())
    && suppliedReceipt.getTime() <= serverReceivedAt.getTime() + MAX_CROSSING_FUTURE_MS
      ? suppliedReceipt
      : null;
  const receivedAt = trustworthyReceipt ?? serverReceivedAt;
  return canonicalizeCrossingTimestamp(
    value ?? receivedAt,
    receivedAt,
    source,
    trustworthyReceipt !== null && isTrustedDirectActiveTimingSource(body.source, body.timeSource),
  );
}

function deriveClockSkewRepair(
  startedAt: Date,
  crossings: Array<{ id: number; crossing_time: string; created_at: string }>,
): Array<{ id: number; time: Date; lapMs: number }> | null {
  // Historical SQLite rows lack durable original receipt/source metadata. A
  // stable past offset can be a legitimate delayed or retried batch, so only
  // repair the known reader-clock-ahead failure mode. Direct active ingress
  // applies trusted receipt-backed skew correction in both directions.
  if (crossings.length < 2) return null;
  const offsets = crossings.map(c => new Date(c.crossing_time).getTime() - new Date(c.created_at).getTime());
  if (offsets.some(offset => !Number.isFinite(offset))) return null;
  const sorted = [...offsets].sort((a, b) => a - b);
  const median = sorted.length % 2
    ? sorted[(sorted.length - 1) / 2]
    : (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2;
  const spread = sorted[sorted.length - 1] - sorted[0];
  const quarterHourMs = 15 * 60 * 1000;
  const timezoneDistance = Math.abs(Math.abs(median) - Math.round(Math.abs(median) / quarterHourMs) * quarterHourMs);
  if (
    median <= MAX_CROSSING_FUTURE_MS
    || spread > 2 * 60 * 1000
    || !offsets.every(offset => Math.sign(offset) === Math.sign(median))
    || timezoneDistance > 2 * 60 * 1000
  ) return null;
  let previousMs = startedAt.getTime();
  const repaired: Array<{ id: number; time: Date; lapMs: number }> = [];
  for (const crossing of crossings) {
    const time = new Date(crossing.created_at);
    const lapMs = time.getTime() - previousMs;
    if (!Number.isFinite(lapMs) || lapMs < 0) return null;
    repaired.push({ id: crossing.id, time, lapMs });
    previousMs = time.getTime();
  }
  return repaired;
}

// ── Utility: format milliseconds → "M:SS.mm" ─────────────────────────────────
export function formatLapTime(ms: number): string {
  if (ms <= 0) return "0:00.00";
  const minutes = Math.floor(ms / 60000);
  const seconds = Math.floor((ms % 60000) / 1000);
  const centis = Math.floor((ms % 1000) / 10);
  return `${minutes}:${String(seconds).padStart(2, "0")}.${String(centis).padStart(2, "0")}`;
}

// ── SSE registry: motoId → connected Response objects ────────────────────────
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

function broadcastCrossingAccepted(motoId: number, result: {
  crossing: { id: number } | null;
  lapNumber: number | null;
  lapTimeMs: number | null;
}, crossingTime: Date, readerId?: string, readerReceivedAt?: string, ingestStartedAt = new Date().toISOString()) {
  if (!result.crossing) return;
  sseBroadcast(motoId, {
    type: "crossing_accepted",
    motoId,
    crossingId: result.crossing.id,
    lapNumber: result.lapNumber,
    lapTimeMs: result.lapTimeMs,
    crossingTime: crossingTime.toISOString(),
    readerReceivedAt: readerReceivedAt ?? null,
    ingestStartedAt,
    acknowledgedAt: new Date().toISOString(),
    readerId: readerId ?? null,
  });
}

// ── Build leaderboard snapshot from SQLite ────────────────────────────────────
export function buildLeaderboard(motoId: number) {
  const db = getDb();

  const moto = db.prepare("SELECT * FROM motos WHERE id = ?").get(motoId) as any;
  if (!moto) return null;
  const event = db.prepare("SELECT race_style FROM events WHERE id = ?").get(moto.event_id) as any;
  const excludeFirstLapFromBest = event?.race_style === "motocross";

  // Self-heal stable timezone-labelled reader clocks using logical
  // lap/insertion order. Delayed uploads are intentionally not repaired.
  // Enduro tests pair start/finish reads by insertion order instead, so this
  // lap-based repair doesn't apply to them.
  if (moto.started_at && moto.type !== "enduro_test") {
    const crossings = db.prepare(`
      SELECT * FROM lap_crossings
      WHERE moto_id = ? AND rider_id IS NOT NULL
      ORDER BY rider_id, lap_number, id
    `).all(motoId) as any[];
    const byRider = new Map<number, any[]>();
    for (const crossing of crossings) {
      const group = byRider.get(crossing.rider_id) ?? [];
      group.push(crossing);
      byRider.set(crossing.rider_id, group);
    }
    const repair = db.transaction(() => {
      for (const [riderId, riderCrossings] of byRider) {
        const repaired = deriveClockSkewRepair(new Date(moto.started_at), riderCrossings);
        if (!repaired?.length) continue;
        const updateCrossing = db.prepare(
          "UPDATE lap_crossings SET crossing_time = ?, lap_time_ms = ? WHERE id = ?",
        );
        for (const row of repaired) updateCrossing.run(row.time.toISOString(), row.lapMs, row.id);
        const laps = repaired.map(row => row.lapMs);
        db.prepare("UPDATE race_results SET lap_times = ?, total_time = ? WHERE moto_id = ? AND rider_id = ?")
          .run(JSON.stringify(laps), formatLapTime(laps.reduce((sum, lap) => sum + lap, 0)), motoId, riderId);
      }
    });
    repair();
  }

  const results = db.prepare(`
    SELECT rr.*, r.first_name, r.last_name
    FROM race_results rr
    LEFT JOIN riders r ON rr.rider_id = r.id
    WHERE rr.moto_id = ?
    ORDER BY rr.position ASC NULLS LAST
  `).all(motoId) as any[];

  const leaderboard = results.map((r: any) => {
    const lapMs = parseJsonArr<number>(r.lap_times);
    const totalMs = lapMs.reduce((s, t) => s + t, 0);
    const lastMs = lapMs.length > 0 ? lapMs[lapMs.length - 1] : null;
    const eligibleLapMs = lapMs.filter(
      (t, index) => (!excludeFirstLapFromBest || index >= 1) && t > 0,
    );
    const bestMs = eligibleLapMs.length ? Math.min(...eligibleLapMs) : null;
    return {
      position: r.position ?? 999,
      riderId: r.rider_id,
      riderName: `${r.first_name ?? ""} ${r.last_name ?? ""}`.trim() || "Unknown",
      bibNumber: r.bib_number ?? null,
      laps: lapMs.length,
      lapTimes: lapMs.map(formatLapTime),
      lastLapMs: lastMs,
      lastLap: lastMs != null ? formatLapTime(lastMs) : null,
      bestLapMs: bestMs,
      bestLap: bestMs != null ? formatLapTime(bestMs) : null,
      totalMs,
      totalTime: lapMs.length ? formatLapTime(totalMs) : null,
      dnf: r.dnf === 1,
      dns: r.dns === 1,
    };
  });

  const leader = leaderboard[0];
  const withGaps = leaderboard.map((entry) => {
    if (!leader || entry.position === 1) return { ...entry, gap: "Leader" };
    if (entry.laps < leader.laps)
      return { ...entry, gap: `+${leader.laps - entry.laps} lap${leader.laps - entry.laps > 1 ? "s" : ""}` };
    return {
      ...entry,
      gap:
        entry.totalMs > 0 && leader.totalMs > 0
          ? `+${formatLapTime(entry.totalMs - leader.totalMs)}`
          : "—",
    };
  });

  return {
    motoId,
    motoName: moto.name ?? "",
    raceClass: moto.race_class,
    status: moto.status,
    startedAt: moto.started_at ?? null,
    completedAt: moto.completed_at ?? null,
    pausedAt: moto.paused_at ?? null,
    totalPausedMs: moto.total_paused_ms ?? 0,
    resultsOfficial: moto.results_finalized_at != null || moto.type === "practice",
    leaderboard: withGaps,
    updatedAt: new Date().toISOString(),
  };
}

// ── Burst window for duplicate reads of one pass (same rule as the cloud) ─────
// A class's minimum lap time is a scoring flag, not an acceptance gate: short
// arena laps must never be dropped.
const DEBOUNCE_MS = 10_000;

function effectiveTime(row: { crossing_time: string; created_at: string }): Date {
  const raw = new Date(row.crossing_time);
  const createdAt = new Date(row.created_at);
  return raw.getTime() > createdAt.getTime() + MAX_CROSSING_FUTURE_MS ? createdAt : raw;
}

function scoringMotoOf(moto: any): ScoringMoto {
  return {
    startedAt: new Date(moto.started_at),
    lapCount: moto.lap_count ?? null,
    timeLimitMs: moto.time_limit_ms ?? null,
    plusLaps: moto.plus_laps ?? null,
    timeExpiredAt: moto.time_expired_at ? new Date(moto.time_expired_at) : null,
  };
}

/** The rider a tag belongs to for this event (tags compare case-insensitively). */
function resolveRider(tagNumber: string, eventId: number): number | null {
  const db = getDb();
  // Group race: any team member's tag is a lap for the team (its captain).
  const teamRider = teamTagRider(tagNumber, eventId);
  if (teamRider) return teamRider;
  const assignment = db
    .prepare("SELECT rider_id FROM rfid_assignments WHERE rfid_number = ? COLLATE NOCASE AND event_id = ? LIMIT 1")
    .get(tagNumber, eventId) as any;
  if (assignment?.rider_id) return assignment.rider_id;
  const registration = db
    .prepare("SELECT rider_id FROM registrations WHERE event_id = ? AND mylaps_transponder_number = ? COLLATE NOCASE ORDER BY id LIMIT 1")
    .get(eventId, tagNumber) as any;
  if (registration?.rider_id) return registration.rider_id;
  const profile = db
    .prepare("SELECT id FROM riders WHERE mylaps_transponder_id = ? COLLATE NOCASE OR rfid_number = ? COLLATE NOCASE LIMIT 1")
    .get(tagNumber, tagNumber) as any;
  if (profile?.id) return profile.id;
  // Scanners that send bib numbers instead of tag IDs.
  const bib = db
    .prepare("SELECT rider_id FROM checkins WHERE event_id = ? AND bib_number = ? AND checked_in = 1 LIMIT 1")
    .get(eventId, tagNumber) as any;
  return bib?.rider_id ?? null;
}

/**
 * Staggered starts run several motos at once over one timing line: a read
 * belongs to the running moto in that event whose lineup has the rider.
 */
function motoForRider(motoId: number, tagNumber: string): number {
  const db = getDb();
  const moto = db.prepare("SELECT * FROM motos WHERE id = ?").get(motoId) as any;
  if (!moto || moto.type === "practice" || moto.type === "enduro_test") return motoId;
  if (parseJsonArr(moto.lineup).length === 0) return motoId;
  const riderId = resolveRider(tagNumber, moto.event_id);
  if (!riderId) return motoId;
  const inLineup = (m: any) => parseJsonArr<{ riderId?: number }>(m.lineup).some(e => e?.riderId === riderId);
  if (inLineup(moto)) return motoId;
  const others = (db.prepare("SELECT * FROM motos WHERE event_id = ? AND id != ?").all(moto.event_id, motoId) as any[])
    .filter(m => m.type !== "practice" && m.type !== "enduro_test" && inLineup(m));
  const running = others.find(m => m.status === "in_progress");
  if (running) return running.id;
  // A rider from a moto that just finished must not score laps in someone else's race.
  const justFinished = others.some(m => m.status === "completed" && m.completed_at
    && Date.now() - new Date(m.completed_at).getTime() < 30 * 60_000);
  if (justFinished) throw new Error("This rider's moto has already finished");
  return motoId;
}

/**
 * Rebuilds one rider's (or one unassigned tag's) laps in a moto from all of
 * their crossings, the rider's result (up to their checkered flag) and all
 * positions. Runs inside a transaction. Returns the lap of `crossingId`.
 */
function rescoreRider(moto: any, riderId: number | null, tagNumber: string, crossingId?: number) {
  const db = getDb();
  const scoring = scoringMotoOf(moto);
  const rows = db.prepare("SELECT * FROM lap_crossings WHERE moto_id = ?").all(moto.id) as any[];
  const tag = tagNumber.trim().toLowerCase();
  const mine = rows
    .filter(r => (riderId ? r.rider_id === riderId : r.rider_id == null && String(r.rfid_number).trim().toLowerCase() === tag))
    .sort((x, y) => effectiveTime(x).getTime() - effectiveTime(y).getTime() || x.id - y.id);

  let result: { lapNumber: number | null; lapTimeMs: number | null } = { lapNumber: null, lapTimeMs: null };
  const setLap = db.prepare("UPDATE lap_crossings SET lap_number = ?, lap_time_ms = ? WHERE id = ?");
  for (let i = 0; i < mine.length; i++) {
    const lapNumber = i + 1;
    const prev = i === 0 ? scoring.startedAt : effectiveTime(mine[i - 1]);
    const lapTimeMs = Math.max(0, effectiveTime(mine[i]).getTime() - prev.getTime());
    if (mine[i].lap_number !== lapNumber || mine[i].lap_time_ms !== lapTimeMs) setLap.run(lapNumber, lapTimeMs, mine[i].id);
    if (mine[i].id === crossingId) result = { lapNumber, lapTimeMs };
  }
  if (!riderId) return result;

  const byRider = new Map<number, Date[]>();
  for (const r of rows) {
    if (r.rider_id == null) continue;
    const list = byRider.get(r.rider_id) ?? [];
    list.push(effectiveTime(r));
    byRider.set(r.rider_id, list);
  }
  const finishAt = computeFinishAt(scoring, [...byRider.values()]);
  const score = scoreRider(scoring, byRider.get(riderId) ?? [], finishAt);

  const existing = db.prepare("SELECT * FROM race_results WHERE moto_id = ? AND rider_id = ? LIMIT 1").get(moto.id, riderId) as any;
  if (existing) {
    if (mine.length === 0) {
      db.prepare("DELETE FROM race_results WHERE id = ?").run(existing.id);
    } else {
      db.prepare("UPDATE race_results SET lap_times = ?, total_time = ? WHERE id = ?")
        .run(JSON.stringify(score.lapTimes), score.lapTimes.length ? formatLapTime(score.totalMs) : null, existing.id);
    }
  } else if (score.lapTimes.length > 0) {
    const checkin = (db
      .prepare("SELECT race_class, bib_number FROM checkins WHERE event_id = ? AND rider_id = ? AND race_class = ? LIMIT 1")
      .get(moto.event_id, riderId, moto.race_class) as any) ??
      (db.prepare("SELECT race_class, bib_number FROM checkins WHERE event_id = ? AND rider_id = ? LIMIT 1").get(moto.event_id, riderId) as any);
    db.prepare(`
      INSERT INTO race_results (event_id, moto_id, rider_id, race_class, position, bib_number, lap_times, total_time, dnf, dns)
      VALUES (?, ?, ?, ?, 999, ?, ?, ?, 0, 0)
    `).run(moto.event_id, moto.id, riderId, moto.race_class, checkin?.bib_number ?? null, JSON.stringify(score.lapTimes), formatLapTime(score.totalMs));
  }

  const allResults = db.prepare("SELECT id, lap_times, dnf, dns FROM race_results WHERE moto_id = ?").all(moto.id) as any[];
  const sorted = allResults
    .map((r: any) => {
      const laps = parseJsonArr<number>(r.lap_times);
      return { id: r.id, laps: laps.length, totalMs: laps.reduce((s: number, t: number) => s + t, 0), out: r.dnf === 1 || r.dns === 1 };
    })
    .sort(compareStandings);
  const updatePos = db.prepare("UPDATE race_results SET position = ? WHERE id = ?");
  for (let i = 0; i < sorted.length; i++) updatePos.run(i + 1, sorted[i].id);
  return result;
}

/**
 * Rebuild one rider's runs on an enduro test from their remaining crossings
 * (start/finish pairs in insertion order): run number and elapsed time on each
 * crossing, and their race result (lap_times = completed runs, total_time =
 * their sum, race_class = the rider's class at the event). Removes the result
 * when no crossing is left. Same as the cloud's rescoreEnduroRider; run inside
 * a transaction and re-rank the test afterwards.
 */
function rescoreEnduroRider(moto: any, riderId: number): void {
  const db = getDb();
  const crossings = (db
    .prepare("SELECT * FROM lap_crossings WHERE moto_id = ? AND rider_id = ? ORDER BY id")
    .all(moto.id, riderId) as any[])
    .map(c => ({ id: c.id as number, crossingTime: c.crossing_time as string, lapNumber: c.lap_number, lapTimeMs: c.lap_time_ms }));
  const { runs, numbered } = pairEnduroRuns(crossings);
  const setLap = db.prepare("UPDATE lap_crossings SET lap_number = ?, lap_time_ms = ? WHERE id = ?");
  for (const n of numbered) {
    if (n.crossing.lapNumber !== n.runNumber || n.crossing.lapTimeMs !== n.elapsedMs) {
      setLap.run(n.runNumber, n.elapsedMs, n.crossing.id);
    }
  }
  const existing = db.prepare("SELECT * FROM race_results WHERE moto_id = ? AND rider_id = ? LIMIT 1").get(moto.id, riderId) as any;
  if (crossings.length === 0) {
    if (existing) db.prepare("DELETE FROM race_results WHERE id = ?").run(existing.id);
    return;
  }
  const passTimes = runs.map(r => r.elapsedMs);
  const totalTime = passTimes.length ? formatLapTime(passTimes.reduce((sum, t) => sum + t, 0)) : null;
  const raceClass = resolveEnduroRiderClass(moto.event_id, riderId, existing?.race_class || moto.race_class || ENDURO_ALL_CLASSES);
  if (existing) {
    db.prepare("UPDATE race_results SET lap_times = ?, total_time = ?, race_class = ? WHERE id = ?")
      .run(JSON.stringify(passTimes), totalTime, raceClass, existing.id);
  } else {
    const checkins = db.prepare("SELECT race_class, bib_number FROM checkins WHERE event_id = ? AND rider_id = ? ORDER BY id").all(moto.event_id, riderId) as any[];
    const checkin = checkins.find(c => c.race_class === raceClass) ?? checkins[0];
    db.prepare(`
      INSERT INTO race_results (event_id, moto_id, rider_id, race_class, position, bib_number, lap_times, total_time, dnf, dns)
      VALUES (?, ?, ?, ?, 999, ?, ?, ?, 0, 0)
    `).run(moto.event_id, moto.id, riderId, raceClass, checkin?.bib_number ?? null, JSON.stringify(passTimes), totalTime);
  }
}

/**
 * A timed race closes once every rider still racing has taken the checkered
 * flag, or a grace period after the leader's finish. Returns true if closed.
 */
export function completeTimedMotoIfFinished(motoId: number, nowMs = Date.now()): boolean {
  const db = getDb();
  const moto = db.prepare("SELECT * FROM motos WHERE id = ?").get(motoId) as any;
  if (!moto || moto.status !== "in_progress" || !moto.started_at || !moto.time_limit_ms || !moto.time_expired_at) return false;
  if (moto.type === "practice" || moto.type === "enduro_test") return false;
  const scoring = scoringMotoOf(moto);
  const rows = db.prepare("SELECT * FROM lap_crossings WHERE moto_id = ? AND rider_id IS NOT NULL").all(motoId) as any[];
  const byRider = new Map<number, Date[]>();
  for (const r of rows) byRider.set(r.rider_id, [...(byRider.get(r.rider_id) ?? []), effectiveTime(r)]);
  const finishAt = computeFinishAt(scoring, [...byRider.values()]);
  if (!finishAt) return false;
  const out = new Set((db.prepare("SELECT rider_id FROM race_results WHERE moto_id = ? AND (dnf = 1 OR dns = 1)").all(motoId) as any[]).map(r => r.rider_id));
  const scores = [...byRider.entries()].map(([id, times]) => ({ id, score: scoreRider(scoring, times, finishAt), out: out.has(id) }));
  const leader = scores.filter(x => !x.out).sort((x, y) => compareStandings(
    { laps: x.score.lapTimes.length, totalMs: x.score.totalMs },
    { laps: y.score.lapTimes.length, totalMs: y.score.totalMs },
  ))[0];
  const graceOver = nowMs > finishAt.getTime() + finishGraceMs(leader?.score.lapTimes ?? []);
  if (!everyoneFinished(scores) && !graceOver) return false;
  const changed = db.prepare("UPDATE motos SET status = 'completed', completed_at = ? WHERE id = ? AND status = 'in_progress'")
    .run(new Date().toISOString(), motoId);
  if (changed.changes > 0) {
    const snapshot = buildLeaderboard(motoId);
    if (snapshot) sseBroadcast(motoId, snapshot);
  }
  return changed.changes > 0;
}

/**
 * The race clock for timed motos (same as the cloud's lib/raceClock.ts): drops
 * the flag at start + limit + red-flag time, ends timed practices, and closes
 * flagged races once everyone is in.
 */
export function tickRaceClock(nowMs = Date.now()): void {
  const db = getDb();
  const motos = db.prepare("SELECT * FROM motos WHERE status = 'in_progress' AND time_limit_ms IS NOT NULL AND started_at IS NOT NULL").all() as any[];
  for (const moto of motos) {
    if (moto.type === "enduro_test") continue;
    try {
      if (!moto.time_expired_at) {
        const flag = flagTimeFor({
          startedAt: new Date(moto.started_at),
          timeLimitMs: moto.time_limit_ms,
          totalPausedMs: moto.total_paused_ms ?? 0,
          pausedAt: moto.paused_at ? new Date(moto.paused_at) : null,
        }, nowMs);
        if (!flag) continue;
        const update = moto.type === "practice"
          ? db.prepare("UPDATE motos SET status = 'completed', completed_at = ? WHERE id = ? AND status = 'in_progress'").run(new Date(nowMs).toISOString(), moto.id)
          : db.prepare("UPDATE motos SET time_expired_at = ? WHERE id = ? AND status = 'in_progress' AND time_expired_at IS NULL").run(flag.toISOString(), moto.id);
        if (update.changes > 0) {
          const snapshot = buildLeaderboard(moto.id);
          if (snapshot) sseBroadcast(moto.id, snapshot);
        }
        continue;
      }
      completeTimedMotoIfFinished(moto.id, nowMs);
    } catch (err) {
      console.warn(`[race-clock] moto ${moto.id}:`, err instanceof Error ? err.message : err);
    }
  }
}

let raceClockTimer: ReturnType<typeof setInterval> | null = null;
export function startRaceClock(): void {
  if (raceClockTimer) return;
  raceClockTimer = setInterval(() => tickRaceClock(), 1000);
  raceClockTimer.unref?.();
}

// ── Core crossing processor (synchronous — SQLite is single-writer) ───────────
function processCrossing(opts: {
  rfidNumber: string;
  motoId: number;
  crossingTime: Date;
  readerId?: string;
  antennaId?: number;
  bypassDebounce?: boolean;
  overrideRiderId?: number | null;
  /** Enduro gate role of a dedicated reader; checked with the rider's crossings. */
  enduroRole?: "start" | "finish";
  onAccepted?: (result: {
    crossing: { id: number };
    lapNumber: number;
    lapTimeMs: number;
  }) => void;
}) {
  const db = getDb();
  const { rfidNumber, readerId, antennaId, bypassDebounce, overrideRiderId, enduroRole, onAccepted } = opts;
  const crossingTime = canonicalizeCrossingTimestamp(opts.crossingTime, new Date(), "processCrossing");
  const tagNumber = rfidNumber.trim();
  // Manual entries name their moto; reads from the track go to the rider's moto.
  const motoId = overrideRiderId === undefined ? motoForRider(opts.motoId, tagNumber) : opts.motoId;

  type CrossingResult =
    | { debounced: true; crossing: null; lapNumber: null; lapTimeMs: null }
    | { debounced: false; crossing: { id: number }; lapNumber: number; lapTimeMs: number; enduroAction?: "started" | "finished"; elapsedMs?: number };

  // Enduro tests have no Start button: riders start individually. The first
  // crossing aimed at a scheduled test activates it and anchors its start time.
  // As on the cloud, the test stays active even if this crossing is then
  // rejected, so this is not part of the crossing's transaction.
  db.prepare(
    "UPDATE motos SET status = 'in_progress', started_at = COALESCE(started_at, ?) WHERE id = ? AND status = 'scheduled' AND type = 'enduro_test'",
  ).run(crossingTime.toISOString(), motoId);

  const accepted = db.transaction((): CrossingResult => {
    const moto = db.prepare("SELECT * FROM motos WHERE id = ?").get(motoId) as any;
    if (!moto) throw new Error("Moto not found");
    if (moto.status !== "in_progress") {
      if (moto.type === "enduro_test") throw new EnduroCrossingRejected(`${moto.name} is finished — reopen it to record more runs`);
      throw new Error("Moto is not in progress");
    }
    if (!moto.started_at) throw new Error("Moto has no start time");

    const riderId: number | null = overrideRiderId !== undefined ? overrideRiderId : resolveRider(tagNumber, moto.event_id);

    // ── ENDURO: per-rider start/stop toggle (same rules as the cloud) ─────────
    // Each run is two crossings: the rider's START, then their FINISH (elapsed =
    // finish − start). State is tracked by rider, not tag, so a run started by a
    // read can be finished by a manual bib entry or the other way round.
    if (moto.type === "enduro_test") {
      if (!riderId) {
        throw new EnduroCrossingRejected("This tag isn't assigned to a rider. Assign it on Check-In, or enter the rider's bib number by hand.");
      }
      // Insertion order (id), not crossing time, is the toggle sequence.
      const riderCrossings = db
        .prepare("SELECT * FROM lap_crossings WHERE moto_id = ? AND rider_id = ? ORDER BY id")
        .all(motoId, riderId) as any[];

      // Debounce double reads at the line (manual entries bypass this).
      if (!bypassDebounce && riderCrossings.length > 0) {
        const last = riderCrossings[riderCrossings.length - 1];
        if (crossingTime.getTime() - effectiveTime(last).getTime() < DEBOUNCE_MS) {
          return { debounced: true, crossing: null, lapNumber: null, lapTimeMs: null };
        }
      }

      // lap_count is how many times each rider runs this test (2 crossings a run).
      const lapsPerTest = Math.max(1, moto.lap_count ?? 1);
      if (riderCrossings.length >= lapsPerTest * 2) {
        throw new EnduroCrossingRejected(`Rider already completed all ${lapsPerTest} run${lapsPerTest > 1 ? "s" : ""} of this test`);
      }

      // Even prior count: this crossing STARTS the next run; odd: it FINISHES it.
      const isFinish = riderCrossings.length % 2 === 1;
      if (enduroRole === "start" && isFinish) {
        throw new EnduroCrossingRejected("Rider already has an open start — waiting for finish crossing");
      }
      if (enduroRole === "finish" && !isFinish) {
        throw new EnduroCrossingRejected("No open start for this rider on this test");
      }
      const lapNumber = Math.floor(riderCrossings.length / 2) + 1;
      const openStart = isFinish ? riderCrossings[riderCrossings.length - 1] : null;
      const elapsedMs = openStart
        ? Math.max(0, crossingTime.getTime() - new Date(openStart.crossing_time).getTime())
        : 0;
      // A hardware read finishing a run open longer than the maximum is almost
      // certainly a missed finish: don't record it. The start stays open so the
      // organizer can void it or finish it by manual bib entry (no maximum).
      if (openStart && !bypassDebounce && elapsedMs > ENDURO_MAX_RUN_MS) {
        console.warn(JSON.stringify({ event: "enduro_finish_rejected_over_max", motoId, riderId, startCrossingId: openStart.id, elapsedMs, readerId: readerId ?? null }));
        throw new EnduroCrossingRejected(
          `Run open for ${Math.round(elapsedMs / 60_000)} min (max ${ENDURO_MAX_RUN_MS / 60_000}) — not recorded as a finish. Void the start in Race Day Management or finish it by bib entry.`,
        );
      }

      const ins = db.prepare(`
        INSERT INTO lap_crossings
          (event_id, moto_id, rider_id, rfid_number, crossing_time, lap_number, lap_time_ms, reader_id, antenna_id)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(moto.event_id, motoId, riderId, tagNumber, crossingTime.toISOString(), lapNumber, elapsedMs, readerId ?? null, antennaId ?? null);
      // Rebuild the rider's runs and result (in their own class), then re-rank
      // the test within each class by total time of completed runs.
      rescoreEnduroRider(moto, riderId);
      rerankEnduroTest(motoId);
      return {
        debounced: false,
        crossing: { id: Number(ins.lastInsertRowid) },
        lapNumber,
        lapTimeMs: elapsedMs,
        enduroAction: isFinish ? "finished" : "started",
        elapsedMs,
      };
    }

    // A tag read before it was assigned to anyone belongs to this rider now.
    if (riderId) {
      db.prepare("UPDATE lap_crossings SET rider_id = ? WHERE moto_id = ? AND rider_id IS NULL AND rfid_number = ? COLLATE NOCASE")
        .run(riderId, motoId, tagNumber);
    }

    // Laps belong to the rider (every tag and manual entry). Reject burst
    // duplicates within the window on either side: retried reads arrive late.
    const mine = (riderId
      ? db.prepare("SELECT * FROM lap_crossings WHERE moto_id = ? AND rider_id = ?").all(motoId, riderId)
      : db.prepare("SELECT * FROM lap_crossings WHERE moto_id = ? AND rider_id IS NULL AND rfid_number = ? COLLATE NOCASE").all(motoId, tagNumber)) as any[];
    if (!bypassDebounce && mine.some(c => Math.abs(crossingTime.getTime() - effectiveTime(c).getTime()) < DEBOUNCE_MS)) {
      return { debounced: true, crossing: null, lapNumber: null, lapTimeMs: null };
    }
    if (crossingTime.getTime() < new Date(moto.started_at).getTime()) {
      throw new Error("Crossing time precedes the moto start");
    }

    const insResult = db.prepare(`
      INSERT INTO lap_crossings
        (event_id, moto_id, rider_id, rfid_number, crossing_time, lap_number, lap_time_ms, reader_id, antenna_id)
      VALUES (?, ?, ?, ?, ?, 0, 0, ?, ?)
    `).run(moto.event_id, motoId, riderId, tagNumber, crossingTime.toISOString(), readerId ?? null, antennaId ?? null);
    const crossing = { id: Number(insResult.lastInsertRowid) };
    const lap = rescoreRider(moto, riderId, tagNumber, crossing.id);
    return { debounced: false, crossing, lapNumber: lap.lapNumber ?? 0, lapTimeMs: lap.lapTimeMs ?? 0 };
  })();

  if (accepted.debounced) return accepted;
  onAccepted?.({ crossing: accepted.crossing, lapNumber: accepted.lapNumber, lapTimeMs: accepted.lapTimeMs });
  completeTimedMotoIfFinished(motoId);
  return accepted;
}

// ── Helpers: find active moto ─────────────────────────────────────────────────
function getActiveMotoForEvent(eventId: number): any {
  return (
    getDb()
      .prepare("SELECT * FROM motos WHERE event_id = ? AND status = 'in_progress' ORDER BY started_at DESC LIMIT 1")
      .get(eventId) ?? null
  );
}

// Which session gets the reads, with the cloud's rule (api-server lib/liveSession.ts):
// a moto left "in progress" (e.g. after testing) only counts while it started
// within the live window and no practice was started after it.
function getActiveMotoForAnyEvent(): any {
  const moto = getDb()
    .prepare("SELECT * FROM motos WHERE status = 'in_progress' ORDER BY started_at DESC LIMIT 1")
    .get() as any;
  if (!moto?.started_at) return null;
  const started = new Date(moto.started_at).getTime();
  if (Date.now() - started > LIVE_WINDOW_MS) return null;
  const practice = getActivePracticeSession();
  if (practice && new Date(practice.started_at ?? practice.created_at).getTime() > started) return null;
  return moto;
}

function getActivePracticeSession(): any {
  return (
    getDb()
      .prepare(
        `SELECT * FROM practice_sessions WHERE status = 'active'
         AND COALESCE(started_at, created_at) >= ? ORDER BY id DESC LIMIT 1`,
      )
      .get(new Date(Date.now() - LIVE_WINDOW_MS).toISOString()) ?? null
  );
}

/** The next enduro test nobody has started, on an event that's racing today. */
function nextScheduledEnduroTest(): any {
  return (
    getDb()
      .prepare(
        `SELECT m.* FROM motos m JOIN events e ON e.id = m.event_id
         WHERE e.status = 'race_day' AND m.status = 'scheduled' AND m.type = 'enduro_test'
         ORDER BY m.moto_number ASC, m.id ASC LIMIT 1`,
      )
      .get() ?? null
  );
}

/**
 * The moto a read with no gate assignment goes to (the cloud's
 * getActiveMotoForClub): the live moto; else nothing while a practice runs;
 * else the next scheduled enduro test, which processCrossing activates.
 */
function getFacilityMoto(): any {
  const live = getActiveMotoForAnyEvent();
  if (live) return live;
  if (getActivePracticeSession()) return null;
  return nextScheduledEnduroTest();
}

function raceDayEventIds(): number[] {
  return (getDb().prepare("SELECT id FROM events WHERE status = 'race_day'").all() as Array<{ id: number }>).map(e => e.id);
}

/**
 * True exactly when the hardware ingest would take a read: a live moto, a live
 * practice, an enduro test waiting for its first start read, or (for readers
 * that send their id) a time check or test gate on today's only event.
 */
function readsAccepted(): boolean {
  if (getFacilityMoto() || getActivePracticeSession()) return true;
  const events = raceDayEventIds();
  if (events.length !== 1) return false;
  return !!getDb()
    .prepare(
      `SELECT 1 FROM event_reader_assignments a
       LEFT JOIN motos m ON m.id = a.moto_id
       WHERE a.event_id = ?
         AND ((a.role = 'time_check' AND a.time_check_id IS NOT NULL)
           OR (a.role IN ('start', 'finish') AND m.type = 'enduro_test' AND m.status IN ('scheduled', 'in_progress')))
       LIMIT 1`,
    )
    .get(events[0]);
}

/**
 * The cloud reader id a read came from. Reader assignments are keyed by the
 * cloud's numeric reader id (the offline database has no readers table, so
 * tokens and names can't be looked up); "12" and "reader:12" both name reader 12.
 */
function assignmentReaderId(value: unknown): number | null {
  if (typeof value === "number") return Number.isInteger(value) && value > 0 ? value : null;
  if (typeof value !== "string") return null;
  const match = value.trim().match(/^(?:reader:)?(\d+)$/i);
  return match ? Number(match[1]) : null;
}

/** Record (or replace) a rider's arrival at a time check, as the cloud's reader ingest does. */
function recordTimeCheckArrival(eventId: number, timeCheckId: number | null, tagNumber: string, crossingTime: Date): void {
  if (!timeCheckId) return;
  const riderId = resolveRider(tagNumber, eventId);
  if (!riderId) return;
  try {
    getDb().prepare(
      `INSERT INTO enduro_checkpoint_arrivals (event_id, time_check_id, rider_id, arrival_time, recorded_by)
       VALUES (?, ?, ?, ?, 'rfid')
       ON CONFLICT (time_check_id, rider_id) DO UPDATE SET arrival_time = excluded.arrival_time, recorded_by = 'rfid'`,
    ).run(eventId, timeCheckId, riderId, crossingTime.toISOString());
    // Re-rank so penalties/DQ show immediately.
    recomputeEnduroPositionsForEvent(eventId);
  } catch (err) {
    console.warn("[enduro] time check arrival not recorded:", err instanceof Error ? err.message : err);
  }
}

/**
 * A read from a reader the organizer placed as an enduro test gate or time
 * check (the cloud's /timing/readers/:token/crossing, steps 3 to 8). Returns
 * false when the reader has no such assignment for the event in play, so the
 * caller handles the read as a single-reader (facility) read.
 */
function handleEnduroGateRead(res: Response, opts: {
  assignmentReader: number;
  rfidNumber: string;
  crossingTime: Date;
  antennaId: number | null;
  readerReceivedAt?: string;
  ingestStartedAt: string;
}): boolean {
  const db = getDb();
  const { assignmentReader, rfidNumber, crossingTime, antennaId, readerReceivedAt, ingestStartedAt } = opts;

  // Which event: the live moto's; else, with no practice running, today's only event.
  const live = getActiveMotoForAnyEvent();
  let eventId: number;
  if (live) {
    eventId = live.event_id;
  } else {
    if (getActivePracticeSession()) return false;
    const events = raceDayEventIds();
    if (events.length !== 1) return false;
    eventId = events[0];
  }

  const assignments = db
    .prepare("SELECT * FROM event_reader_assignments WHERE event_id = ? AND reader_id = ? ORDER BY id")
    .all(eventId, assignmentReader) as any[];
  const isCourse = (a: any) => a.moto_id == null && (a.role === "finish" || a.role === "split");
  if (assignments.length === 0 || assignments.every(isCourse)) return false;

  // Course map (event-wide finish/split reader): it only acts as a gate while an
  // enduro test (or a test it gates) is running; otherwise laps score as usual.
  const course = assignments.find(isCourse);
  if (course) {
    const activeMoto = getActiveMotoForEvent(eventId);
    if (!activeMoto) return false;
    const hasTestGate = assignments.some(a => a.moto_id === activeMoto.id);
    if (activeMoto.type !== "enduro_test" && !hasTestGate) return false;
    if (course.role === "split" && !hasTestGate) {
      res.status(409).json({ ok: false, message: "Split readers record sector times on motocross and supercross motos only" });
      return true;
    }
  }

  const readerLabel = `reader:${assignmentReader}`;
  const crossingCount = (motoId: number, riderId: number) =>
    (db.prepare("SELECT COUNT(*) AS n FROM lap_crossings WHERE moto_id = ? AND rider_id = ?").get(motoId, riderId) as { n: number }).n;

  const scoreGate = (motoId: number, enduroRole?: "start" | "finish") => {
    try {
      const result = processCrossing({
        rfidNumber,
        motoId,
        crossingTime,
        readerId: readerLabel,
        antennaId: antennaId ?? undefined,
        enduroRole,
        onAccepted: accepted => broadcastCrossingAccepted(motoId, accepted, crossingTime, readerLabel, readerReceivedAt, ingestStartedAt),
      });
      if (result.debounced) return res.json({ ok: true, debounced: true, motoId, message: "Duplicate read ignored" });
      const snapshot = buildLeaderboard(motoId);
      if (snapshot) sseBroadcast(motoId, snapshot);
      return res.json({
        ok: true,
        message: `Rider ${result.enduroAction ?? "recorded"} on moto ${motoId}`,
        motoId,
        crossingId: result.crossing.id,
        lapNumber: result.lapNumber,
        lapTime: formatLapTime(result.lapTimeMs),
        lapTimeMs: result.lapTimeMs,
        enduroAction: result.enduroAction ?? null,
      });
    } catch (err: any) {
      // Expected rejections are 200 ok:false (nothing to retry); anything else is a 500.
      if (err instanceof EnduroCrossingRejected) return res.json({ ok: false, message: err.message });
      return res.status(500).json({ ok: false, message: err?.message ?? "Processing error" });
    }
  };

  // Time check: record the arrival and stop.
  const timeCheck = assignments.find(a => a.role === "time_check");
  if (timeCheck && assignments.length === 1) {
    recordTimeCheckArrival(eventId, timeCheck.time_check_id ?? null, rfidNumber, crossingTime);
    res.json({ ok: true, message: `Time check arrival recorded (check id ${timeCheck.time_check_id ?? null})` });
    return true;
  }

  // Same gate: one reader is both start and finish of a test; the rider's
  // crossing count picks the role (even → start, odd → finish).
  const startMotos = new Set(assignments.filter(a => a.role === "start" && a.moto_id).map(a => a.moto_id as number));
  const sameGateMotoId = assignments.find(a => a.role === "finish" && a.moto_id && startMotos.has(a.moto_id))?.moto_id ?? null;
  if (sameGateMotoId) {
    if (!resolveRider(rfidNumber, eventId)) {
      res.json({ ok: false, message: `Tag ${rfidNumber} not assigned to any rider in this event` });
      return true;
    }
    scoreGate(sameGateMotoId);
    return true;
  }

  // One role: the assignment for this antenna, else the reader-wide one.
  const assignment =
    assignments.find(a => a.antenna_id != null && a.antenna_id === antennaId) ??
    assignments.find(a => a.antenna_id == null) ??
    null;
  if (!assignment) {
    res.status(422).json({ ok: false, message: "Reader has no matching checkpoint assignment" });
    return true;
  }
  if (assignment.role === "time_check") {
    recordTimeCheckArrival(eventId, assignment.time_check_id ?? null, rfidNumber, crossingTime);
    res.json({ ok: true, message: `Time check arrival recorded (check id ${assignment.time_check_id ?? null})` });
    return true;
  }
  if (!assignment.moto_id) {
    res.status(422).json({ ok: false, message: "Assignment has no motoId for start/finish" });
    return true;
  }

  const riderId = resolveRider(rfidNumber, eventId);
  if (!riderId) {
    res.json({ ok: false, message: `Tag ${rfidNumber} not assigned to any rider in this event` });
    return true;
  }
  const isEven = crossingCount(assignment.moto_id, riderId) % 2 === 0;
  if (assignment.role === "start" && !isEven) {
    res.json({ ok: false, message: "Rider already has an open start — waiting for finish crossing" });
    return true;
  }
  if (assignment.role === "finish" && isEven) {
    res.json({ ok: false, message: "No open start for this rider on this test" });
    return true;
  }
  scoreGate(assignment.moto_id, assignment.role === "start" || assignment.role === "finish" ? assignment.role : undefined);
  return true;
}

function processPracticeCrossing(opts: {
  rfidNumber: string;
  session: any;
  crossingTime: Date;
}): { id: number; lapNumber: number; lapTimeMs: number | null } | { debounced: true } | null {
  const db = getDb();
  const { rfidNumber, session } = opts;
  const crossingTime = canonicalizeCrossingTimestamp(opts.crossingTime, new Date(), "processPracticeCrossing");
  const tagNumber = rfidNumber.trim();

  const lastCrossing = db
    .prepare(
      "SELECT * FROM practice_crossings WHERE session_id = ? AND rfid_number = ? ORDER BY crossing_time DESC LIMIT 1",
    )
    .get(session.id, tagNumber) as any;

  if (lastCrossing) {
    const elapsed = crossingTime.getTime() - new Date(lastCrossing.crossing_time).getTime();
    if (elapsed < (session.debounce_ms ?? 10000)) return { debounced: true };
  }

  // Same matching as the practice routes; unknown (ambient) tags are dropped.
  const rider = resolvePracticeRider(db, session.club_id, tagNumber);
  if (!rider) return null;
  const { riderId, riderName, bibNumber } = rider;

  const lapNumber = (lastCrossing?.lap_number ?? 0) + 1;
  const lapTimeMs = lastCrossing
    ? crossingTime.getTime() - new Date(lastCrossing.crossing_time).getTime()
    : null;

  const ins = db
    .prepare(
      `INSERT INTO practice_crossings
         (session_id, rfid_number, rider_id, rider_name, bib_number, crossing_time, lap_number, lap_time_ms)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      session.id,
      tagNumber,
      riderId,
      riderName,
      bibNumber,
      crossingTime.toISOString(),
      lapNumber,
      lapTimeMs,
    );

  return { id: Number(ins.lastInsertRowid), lapNumber, lapTimeMs };
}

// ── Routes ────────────────────────────────────────────────────────────────────

// GET /timing/reader-state — local desktop hardware lifecycle state
// "reading" uses the ingest's own rule, so the loops are open exactly when
// /timing/active/crossing would take a read.
router.get("/timing/reader-state", (_req, res) => {
  return res.json({ reading: readsAccepted() });
});

// POST /timing/crossing — direct motoId crossing (hardware or simulation)
router.post("/timing/crossing", rejectForeignBrowserIngest, (req, res) => {
  const ingestStartedAt = new Date().toISOString();
  const { rfidNumber, motoId, crossingTime, readerId, antennaId, readerReceivedAt } = req.body;
  if (!rfidNumber || !motoId) {
    return res.status(400).json({ error: "rfidNumber and motoId are required" });
  }
  const time = canonicalizeCrossingTimestamp(crossingTime ?? new Date(), new Date(), "direct_crossing_ingest");
  const antenna = antennaId !== undefined ? Number(antennaId) : undefined;
  try {
    const result = processCrossing({
      rfidNumber,
      motoId: Number(motoId),
      crossingTime: time,
      readerId,
      antennaId: antenna,
      onAccepted: accepted => broadcastCrossingAccepted(Number(motoId), accepted, time, readerId, readerReceivedAt, ingestStartedAt),
    });
    if (result.debounced) return res.json({ ok: true, debounced: true });
    const snapshot = buildLeaderboard(Number(motoId));
    if (snapshot) sseBroadcast(Number(motoId), snapshot);
    return res.json({ ok: true, crossingId: result.crossing!.id, lapNumber: result.lapNumber, lapTime: formatLapTime(result.lapTimeMs!), lapTimeMs: result.lapTimeMs });
  } catch (err: any) {
    return res.status(409).json({ error: err.message });
  }
});

// POST /timing/active/crossing?clubId=N — stable facility endpoint
// Accepts all hardware formats: Generic JSON bridge, Impinj R700, Zebra FX7500
// In the local server, clubId is accepted for compatibility but ignored (only one club).
router.post("/timing/active/crossing", rejectForeignBrowserIngest, (req, res) => {
  const ingestStartedAt = new Date().toISOString();
  const body = req.body as any;

  // Impinj R700 native IoT Connector format
  if (Array.isArray(body?.events)) {
    const tagEvents = (body.events as any[])
      .filter((e: any) => e?.type === "tagInventoryEvent" && e?.tagInventoryEvent?.epcHex)
      .map((e: any) => e.tagInventoryEvent as { epcHex: string; antennaPort?: number; firstSeenTime?: string });
    if (tagEvents.length === 0) return res.json({ ok: true, processed: 0, note: "No tagInventoryEvent entries" });
    const moto = getFacilityMoto();
    const practiceImpinj = !moto ? getActivePracticeSession() : null;
    if (!moto && !practiceImpinj) return res.status(409).json({ error: "No moto or practice session in progress", hint: "Start a moto or practice session first." });
    const results: unknown[] = [];
    for (const tag of tagEvents) {
      const rfidNumber = tag.epcHex.toUpperCase();
      const crossingTime = canonicalizeCrossingTimestamp(tag.firstSeenTime ?? new Date(), new Date(), "active_impinj_ingest");
      if (moto) {
        try {
          const r = processCrossing({ rfidNumber, motoId: moto.id, crossingTime, readerId: "impinj-r700", antennaId: tag.antennaPort });
          results.push(r.debounced ? { rfidNumber, debounced: true } : { rfidNumber, crossingId: r.crossing?.id, lapNumber: r.lapNumber, lapTimeMs: r.lapTimeMs });
        } catch (err: any) { results.push({ rfidNumber, error: err.message }); }
      } else {
        const r = processPracticeCrossing({ rfidNumber, session: practiceImpinj!, crossingTime });
        results.push(!r || "debounced" in r ? { rfidNumber, debounced: true } : { rfidNumber, crossingId: r.id, lapNumber: r.lapNumber, lapTimeMs: r.lapTimeMs });
      }
    }
    if (moto) {
      const snapshot = buildLeaderboard(moto.id);
      if (snapshot) sseBroadcast(moto.id, snapshot);
      return res.json({ ok: true, processed: tagEvents.length, motoId: moto.id, results });
    }
    return res.json({ ok: true, processed: tagEvents.length, practiceSessionId: practiceImpinj!.id, results });
  }

  // Zebra FX7500 format
  const zebraTags: any[] = Array.isArray(body?.data?.tags) ? body.data.tags : Array.isArray(body?.tags) ? body.tags : [];
  if (zebraTags.length > 0) {
    const moto = getFacilityMoto();
    const practiceZebra = !moto ? getActivePracticeSession() : null;
    if (!moto && !practiceZebra) return res.status(409).json({ error: "No moto or practice session in progress", hint: "Start a moto or practice session first." });
    const results: unknown[] = [];
    for (const tag of zebraTags) {
      const rfidNumber = ((tag.idHex || tag.epc) as string | undefined ?? "").toUpperCase();
      if (!rfidNumber) { results.push({ error: "Tag missing idHex/epc field" }); continue; }
      const crossingTime = tag.firstSeenTimestamp ? new Date(tag.firstSeenTimestamp) : new Date();
      if (moto) {
        try {
          const r = processCrossing({ rfidNumber, motoId: moto.id, crossingTime, readerId: "zebra-fx7500", antennaId: tag.antennaPort });
          results.push(r.debounced ? { rfidNumber, debounced: true } : { rfidNumber, crossingId: r.crossing?.id, lapNumber: r.lapNumber, lapTimeMs: r.lapTimeMs });
        } catch (err: any) { results.push({ rfidNumber, error: err.message }); }
      } else {
        const r = processPracticeCrossing({ rfidNumber, session: practiceZebra!, crossingTime });
        results.push(!r || "debounced" in r ? { rfidNumber, debounced: true } : { rfidNumber, crossingId: r.id, lapNumber: r.lapNumber, lapTimeMs: r.lapTimeMs });
      }
    }
    if (moto) {
      const snapshot = buildLeaderboard(moto.id);
      if (snapshot) sseBroadcast(moto.id, snapshot);
      return res.json({ ok: true, processed: zebraTags.length, motoId: moto.id, results });
    }
    return res.json({ ok: true, processed: zebraTags.length, practiceSessionId: practiceZebra!.id, results });
  }

  // Generic JSON format (tag/transponder ID plus optional time)
  const rfidNumber: string | undefined = body?.rfidNumber ?? body?.transponder ?? body?.transponderId ?? body?.id;
  if (!rfidNumber) {
    return res.status(400).json({ error: "Cannot extract tag/transponder ID — expected rfidNumber, transponder, transponderId, Impinj events[], or Zebra tags[]" });
  }
  const rawTime = body?.crossingTime ?? body?.passingTime ?? body?.timestamp ?? body?.passTime;
  const crossingTime = canonicalizeDirectActiveTimestamp(rawTime, body, "active_generic_ingest");

  // A reader the organizer placed as an enduro test gate or time check is
  // handled by its role. Any other read (no readerId, or no such assignment)
  // is a single-reader read: on an enduro test it toggles start/finish.
  const assignmentReader = assignmentReaderId(body?.readerId);
  if (assignmentReader != null) {
    const handled = handleEnduroGateRead(res, {
      assignmentReader,
      rfidNumber: String(rfidNumber),
      crossingTime,
      antennaId: body?.antennaId != null && Number.isFinite(Number(body.antennaId)) ? Number(body.antennaId) : null,
      readerReceivedAt: body?.readerReceivedAt,
      ingestStartedAt,
    });
    if (handled) return;
  }

  const moto = getFacilityMoto();
  const practiceGeneric = !moto ? getActivePracticeSession() : null;
  if (!moto && !practiceGeneric) return res.status(409).json({ error: "No moto or practice session in progress", hint: "Start a moto or practice session first." });
  const readerId: string = body?.loopId ?? body?.readerId ?? body?.readername ?? "rfid";

  if (moto) {
    try {
      const result = processCrossing({
        rfidNumber: String(rfidNumber),
        motoId: moto.id,
        crossingTime,
        readerId,
        onAccepted: accepted => broadcastCrossingAccepted(moto.id, accepted, crossingTime, readerId, body?.readerReceivedAt, ingestStartedAt),
      });
      if (result.debounced) return res.json({ ok: true, debounced: true, motoId: moto.id });
      const snapshot = buildLeaderboard(moto.id);
      if (snapshot) sseBroadcast(moto.id, snapshot);
      return res.json({ ok: true, motoId: moto.id, crossingId: result.crossing?.id, lapNumber: result.lapNumber, lapTime: result.lapTimeMs != null ? formatLapTime(result.lapTimeMs) : null, lapTimeMs: result.lapTimeMs });
    } catch (err: any) {
      return res.status(409).json({ error: err.message });
    }
  }

  const practiceResult = processPracticeCrossing({ rfidNumber: String(rfidNumber), session: practiceGeneric!, crossingTime });
  if (!practiceResult || "debounced" in practiceResult) {
    return res.json({ ok: true, debounced: true, practiceSessionId: practiceGeneric!.id });
  }
  return res.json({ ok: true, practiceSessionId: practiceGeneric!.id, crossingId: practiceResult.id, lapNumber: practiceResult.lapNumber, lapTimeMs: practiceResult.lapTimeMs });
});

// POST /timing/transponder-crossing?eventId=N — generic active-transponder JSON format.
router.post("/timing/transponder-crossing", rejectForeignBrowserIngest, (req, res) => {
  const ingestStartedAt = new Date().toISOString();
  const eventId = Number(req.query.eventId);
  if (!eventId || isNaN(eventId)) return res.status(400).json({ error: "eventId query param is required" });
  const body = req.body as any;
  const transponder: string | undefined = body?.transponder ?? body?.rfidNumber ?? body?.transponderId ?? body?.id;
  if (!transponder) return res.status(400).json({ error: "Missing transponder field — expected 'transponder', 'rfidNumber', or 'transponderId'" });
  const rawTime = body?.passingTime ?? body?.crossingTime ?? body?.timestamp ?? body?.passTime;
  const crossingTime = canonicalizeDirectActiveTimestamp(rawTime, body, "legacy_active_ingest");
  const moto = getActiveMotoForEvent(eventId);
  if (!moto) return res.status(409).json({ error: "No moto currently in progress for this event" });
  const readerId: string = body?.loopId ?? body?.readerId ?? "active-transponder";
  try {
    const result = processCrossing({
      rfidNumber: String(transponder),
      motoId: moto.id,
      crossingTime,
      readerId,
      onAccepted: accepted => broadcastCrossingAccepted(moto.id, accepted, crossingTime, readerId, body?.readerReceivedAt, ingestStartedAt),
    });
    if (result.debounced) return res.json({ ok: true, debounced: true, motoId: moto.id });
    const snapshot = buildLeaderboard(moto.id);
    if (snapshot) sseBroadcast(moto.id, snapshot);
    return res.json({ ok: true, motoId: moto.id, crossingId: result.crossing?.id, lapNumber: result.lapNumber, lapTime: result.lapTimeMs != null ? formatLapTime(result.lapTimeMs) : null, lapTimeMs: result.lapTimeMs });
  } catch (err: any) {
    return res.status(409).json({ error: err.message });
  }
});

// POST /timing/impinj-crossing?eventId=N — Impinj R700 native IoT Connector format
router.post("/timing/impinj-crossing", rejectForeignBrowserIngest, (req, res) => {
  const eventId = Number(req.query.eventId);
  if (!eventId || isNaN(eventId)) return res.status(400).json({ error: "eventId query param is required" });
  const body = req.body as { events?: unknown[] };
  const tagEvents = (Array.isArray(body.events) ? body.events : [])
    .filter((e: any) => e?.type === "tagInventoryEvent" && e?.tagInventoryEvent?.epcHex)
    .map((e: any) => e.tagInventoryEvent as { epcHex: string; antennaPort?: number; firstSeenTime?: string });
  if (tagEvents.length === 0) return res.json({ ok: true, processed: 0, note: "No tagInventoryEvent entries" });
  const moto = getActiveMotoForEvent(eventId);
  if (!moto) return res.status(409).json({ error: "No moto currently in progress for this event" });
  const results: unknown[] = [];
  for (const tag of tagEvents) {
    const rfidNumber = tag.epcHex.toUpperCase();
    const crossingTime = canonicalizeCrossingTimestamp(tag.firstSeenTime ?? new Date(), new Date(), "legacy_impinj_ingest");
    try {
      const r = processCrossing({ rfidNumber, motoId: moto.id, crossingTime, readerId: "impinj-r700", antennaId: tag.antennaPort });
      results.push(r.debounced ? { rfidNumber, debounced: true } : { rfidNumber, crossingId: r.crossing?.id, lapNumber: r.lapNumber, lapTimeMs: r.lapTimeMs });
    } catch (err: any) { results.push({ rfidNumber, error: err.message }); }
  }
  const snapshot = buildLeaderboard(moto.id);
  if (snapshot) sseBroadcast(moto.id, snapshot);
  return res.json({ ok: true, processed: tagEvents.length, motoId: moto.id, results });
});

// POST /timing/zebra-crossing?eventId=N — Zebra FX7500 IoT Connector format
router.post("/timing/zebra-crossing", rejectForeignBrowserIngest, (req, res) => {
  const eventId = Number(req.query.eventId);
  if (!eventId || isNaN(eventId)) return res.status(400).json({ error: "eventId query param is required" });
  const body = req.body as any;
  const tags: any[] = Array.isArray(body?.data?.tags) ? body.data.tags : Array.isArray(body?.tags) ? body.tags : [];
  if (tags.length === 0) return res.json({ ok: true, processed: 0, note: "No tags in payload" });
  const moto = getActiveMotoForEvent(eventId);
  if (!moto) return res.status(409).json({ error: "No moto currently in progress for this event" });
  const results: unknown[] = [];
  for (const tag of tags) {
    const rfidNumber = ((tag.idHex || tag.epc) as string | undefined ?? "").toUpperCase();
    if (!rfidNumber) { results.push({ error: "Tag missing idHex/epc field" }); continue; }
    const crossingTime = tag.firstSeenTimestamp ? new Date(tag.firstSeenTimestamp) : new Date();
    try {
      const r = processCrossing({ rfidNumber, motoId: moto.id, crossingTime, readerId: "zebra-fx7500", antennaId: tag.antennaPort });
      results.push(r.debounced ? { rfidNumber, debounced: true } : { rfidNumber, crossingId: r.crossing?.id, lapNumber: r.lapNumber, lapTimeMs: r.lapTimeMs });
    } catch (err: any) { results.push({ rfidNumber, error: err.message }); }
  }
  const snapshot = buildLeaderboard(moto.id);
  if (snapshot) sseBroadcast(moto.id, snapshot);
  return res.json({ ok: true, processed: tags.length, motoId: moto.id, results });
});

// POST /timing/manual-crossing — record a lap by riderId (no RFID required)
router.post("/timing/manual-crossing", (req, res) => {
  const session = req.session as any;
  if (!session?.userId) return res.status(401).json({ error: "Unauthorized" });
  const { riderId, motoId } = req.body;
  if (!riderId || !motoId) return res.status(400).json({ error: "riderId and motoId are required" });
  const db = getDb();
  const moto = db.prepare("SELECT * FROM motos WHERE id = ?").get(Number(motoId)) as any;
  if (!moto) return res.status(404).json({ error: `Moto ${motoId} not found` });
  const assignment = db
    .prepare("SELECT rfid_number FROM rfid_assignments WHERE rider_id = ? AND event_id = ? LIMIT 1")
    .get(Number(riderId), moto.event_id) as any;
  const rfidNumber = assignment?.rfid_number ?? `MANUAL-${riderId}`;
  try {
    const manualCrossingTime = new Date();
    const result = processCrossing({
      rfidNumber,
      motoId: Number(motoId),
      crossingTime: manualCrossingTime,
      readerId: "MANUAL",
      bypassDebounce: true,
      overrideRiderId: Number(riderId),
      onAccepted: accepted => broadcastCrossingAccepted(Number(motoId), accepted, manualCrossingTime, "MANUAL"),
    });
    const snapshot = buildLeaderboard(Number(motoId));
    if (snapshot) sseBroadcast(Number(motoId), snapshot);
    const enduro = !result.debounced && result.enduroAction
      ? { enduroAction: result.enduroAction, elapsedMs: result.elapsedMs ?? null, elapsed: result.elapsedMs != null ? formatLapTime(result.elapsedMs) : null }
      : {};
    return res.json({ ok: true, crossingId: result.crossing?.id ?? null, lapNumber: result.lapNumber, lapTime: result.lapTimeMs != null ? formatLapTime(result.lapTimeMs) : null, lapTimeMs: result.lapTimeMs, ...enduro });
  } catch (err: any) {
    return res.status(err instanceof EnduroCrossingRejected ? 409 : 500).json({ error: err.message });
  }
});

// GET /timing/live/:motoId — SSE stream for live leaderboard
router.get("/timing/live/:motoId", (req, res) => {
  const motoId = Number(req.params.motoId);

  // Disable Nagle buffering so each write() is immediately flushed to the
  // client without waiting for a full TCP packet.  Without this, SSE events
  // are buffered on direct localhost connections (no reverse proxy to force
  // the flush) and the browser only sees them in bulk once the buffer fills.
  const sock = (req as any).socket;
  if (sock) {
    sock.setNoDelay(true);
    sock.setTimeout(0);
    sock.setKeepAlive(true, 0);
  }

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.setHeader("Access-Control-Allow-Origin", "*");
  (res as any).flushHeaders?.();

  sseSubscribe(motoId, res);

  const snapshot = buildLeaderboard(motoId);
  if (snapshot) {
    (res as any).write(`data: ${JSON.stringify(snapshot)}\n\n`);
  } else {
    (res as any).write(`data: ${JSON.stringify({ error: "Moto not found" })}\n\n`);
  }

  const heartbeat = setInterval(() => {
    try { (res as any).write(": heartbeat\n\n"); }
    catch { clearInterval(heartbeat); sseUnsubscribe(motoId, res); }
  }, 15_000);

  req.on("close", () => {
    clearInterval(heartbeat);
    sseUnsubscribe(motoId, res);
  });
});

// GET /timing/leaderboard/:motoId — polling fallback snapshot
router.get("/timing/leaderboard/:motoId", (req, res) => {
  const snapshot = buildLeaderboard(Number(req.params.motoId));
  if (!snapshot) return res.status(404).json({ error: "Moto not found" });
  return res.json(snapshot);
});

// GET /timing/crossings/:motoId — all raw crossings (debug / replay / delete UI)
router.get("/timing/crossings/:motoId", (req, res) => {
  const db = getDb();
  const motoId = Number(req.params.motoId);
  // Primary JOIN: resolve rider via rider_id stored on the crossing.
  // Secondary JOIN: bib-number fallback for crossings where rider_id was not
  // resolved at recording time (e.g. scanner sends bib numbers, not hex IDs).
  const crossings = db.prepare(`
    SELECT lc.*,
      COALESCE(r.first_name,  r2.first_name)  AS first_name,
      COALESCE(r.last_name,   r2.last_name)   AS last_name,
      COALESCE(lc.rider_id,   chk.rider_id)   AS resolved_rider_id
    FROM lap_crossings lc
    LEFT JOIN riders r   ON r.id = lc.rider_id
    LEFT JOIN checkins chk
           ON chk.event_id   = lc.event_id
          AND chk.bib_number = lc.rfid_number
          AND chk.checked_in = 1
    LEFT JOIN riders r2  ON r2.id = chk.rider_id
    WHERE lc.moto_id = ?
    ORDER BY lc.crossing_time ASC
  `).all(motoId) as any[];
  return res.json(crossings.map((c: any) => ({
    id: c.id,
    rfidNumber: c.rfid_number,
    riderId: c.resolved_rider_id ?? c.rider_id,
    crossingTime: c.crossing_time,
    lapNumber: c.lap_number,
    lapTimeMs: c.lap_time_ms,
    readerId: c.reader_id,
    riderName: c.first_name ? `${c.first_name} ${c.last_name ?? ""}`.trim() : null,
    lapTime: c.lap_time_ms ? formatLapTime(c.lap_time_ms) : null,
  })));
});

// DELETE /timing/crossings/:crossingId — remove a phantom/bad crossing and recalculate
router.delete("/timing/crossings/:crossingId", (req, res) => {
  const session = req.session as any;
  if (!session?.userId) return res.status(401).json({ error: "Unauthorized" });
  const crossingId = Number(req.params.crossingId);
  if (!crossingId || isNaN(crossingId)) return res.status(400).json({ error: "Invalid crossingId" });

  const db = getDb();
  const crossing = db.prepare("SELECT * FROM lap_crossings WHERE id = ?").get(crossingId) as any;
  if (!crossing) return res.status(404).json({ error: "Crossing not found" });

  const { moto_id: motoId, rfid_number: rfidNumber, rider_id: riderId } = crossing;
  const moto = db.prepare("SELECT * FROM motos WHERE id = ?").get(motoId) as any;
  if (!moto) return res.status(404).json({ error: "Moto not found" });

  // Rebuild the rider's laps from everything left (every tag and manual entry).
  // Enduro: rebuild the rider's runs as start/finish pairs, then re-rank the test.
  db.transaction(() => {
    db.prepare("DELETE FROM lap_crossings WHERE id = ?").run(crossingId);
    if (moto.type === "enduro_test") {
      if (riderId) rescoreEnduroRider(moto, riderId);
      rerankEnduroTest(motoId);
    } else {
      rescoreRider(moto, riderId ?? null, rfidNumber);
    }
  })();

  const snapshot = buildLeaderboard(motoId);
  if (snapshot) sseBroadcast(motoId, { ...snapshot, correction: true });

  return res.json({ ok: true });
});

export default router;
