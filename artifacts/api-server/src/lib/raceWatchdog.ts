import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import { logger } from "./logger";
import {
  evaluateWatchdog, watchdogConfigFromEnv,
  type WatchdogAlert, type WatchdogMoto, type WatchdogState,
} from "./raceWatchdogCore";

/**
 * Race-day watchdog (decisions in raceWatchdogCore.ts). Once a minute it reads
 * in-progress motos and the newest accepted crossing of each, read-only and
 * outside the per-moto lock, so it can't slow or reorder timing. Each alert is
 * one `race_watchdog_alert` log line plus one text to the support-alert phones.
 * State is in memory: production is a single replica, and after a restart an
 * open problem is simply reported again.
 *
 * RACE_WATCHDOG=off disables it. Log lines only: it never sends texts (owner decision 2026-11-23).
 */

const TICK_MS = 60_000;
let timer: ReturnType<typeof setInterval> | null = null;
let running = false;
const state: WatchdogState = new Map();
/** motoId -> when the watchdog saw it come out of a pause. */
const resumedAt = new Map<number, number>();
const wasPaused = new Set<number>();

type Row = {
  id: number; name: string; type: string; event_name: string; club_name: string | null;
  club_id: number | null; event_id: number;
  started_ago_ms: string | number; paused_ago_ms: string | number | null;
  total_paused_ms: number; time_limit_ms: number | null; since_last_crossing_ms: string | number | null;
};

/** Ages are computed by the database clock, so server/DB clock skew can't fake a stale race. */
async function loadRunningMotos(nowMs: number): Promise<Array<WatchdogMoto & { clubId: number | null; eventId: number }>> {
  const result = await db.execute(sql`
    select m.id, m.name, m.type, m.event_id, e.name as event_name, c.name as club_name, e.club_id,
      extract(epoch from (now() - m.started_at)) * 1000 as started_ago_ms,
      extract(epoch from (now() - m.paused_at)) * 1000 as paused_ago_ms,
      m.total_paused_ms, m.time_limit_ms,
      (select extract(epoch from (now() - max(lc.created_at))) * 1000
         from lap_crossings lc where lc.moto_id = m.id) as since_last_crossing_ms
    from motos m
    join events e on e.id = m.event_id
    left join clubs c on c.id = e.club_id
    where m.status = 'in_progress' and m.started_at is not null`);
  const rows = (result as unknown as { rows: Row[] }).rows;
  return rows.map(r => {
    const paused = r.paused_ago_ms === null ? null : nowMs - Number(r.paused_ago_ms);
    if (paused !== null) wasPaused.add(r.id);
    else if (wasPaused.delete(r.id)) resumedAt.set(r.id, nowMs);
    return {
      motoId: r.id,
      motoName: r.name,
      eventName: r.event_name,
      clubName: r.club_name ?? "no club",
      type: r.type,
      startedAtMs: nowMs - Number(r.started_ago_ms),
      pausedAtMs: paused,
      totalPausedMs: Number(r.total_paused_ms ?? 0),
      timeLimitMs: r.time_limit_ms,
      lastCrossingMs: r.since_last_crossing_ms === null ? null : nowMs - Number(r.since_last_crossing_ms),
      resumedAtMs: resumedAt.get(r.id) ?? null,
      clubId: r.club_id,
      eventId: r.event_id,
    };
  });
}

export async function tickRaceWatchdog(nowMs = Date.now()): Promise<WatchdogAlert[]> {
  const motos = await loadRunningMotos(nowMs);
  const ids = new Set(motos.map(m => m.motoId));
  for (const id of [...resumedAt.keys()]) if (!ids.has(id)) resumedAt.delete(id);
  for (const id of [...wasPaused]) if (!ids.has(id)) wasPaused.delete(id);

  const alerts = evaluateWatchdog(motos, state, nowMs, watchdogConfigFromEnv());
  for (const alert of alerts) {
    const m = alert.moto as WatchdogMoto & { clubId: number | null; eventId: number };
    logger[alert.kind === "recovered" ? "info" : "warn"]({
      event: alert.kind === "recovered" ? "race_watchdog_recovered" : "race_watchdog_alert",
      kind: alert.kind,
      clubId: m.clubId, club: m.clubName,
      eventId: m.eventId, eventName: m.eventName,
      motoId: m.motoId, moto: m.motoName,
      minutes: alert.minutes,
    }, alert.kind === "recovered" ? "race_watchdog_recovered" : "race_watchdog_alert");
    // Owner decision 2026-11-23: no texts for stalled or long-running races.
    // With many clubs, forgotten practices would text the support list over and
    // over; this stays a log line (race_watchdog_alert / _recovered) only.
  }
  return alerts;
}

export function raceWatchdogEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return (env.RACE_WATCHDOG ?? "").trim().toLowerCase() !== "off";
}

export function startRaceWatchdog(): void {
  if (timer) return;
  if (!raceWatchdogEnabled()) {
    logger.info({ event: "race_watchdog_disabled" }, "Race watchdog off (RACE_WATCHDOG=off)");
    return;
  }
  const cfg = watchdogConfigFromEnv();
  logger.info({ event: "race_watchdog_started", staleMin: cfg.staleMs / 60_000, repeatMin: cfg.repeatMs / 60_000 }, "Race watchdog started");
  timer = setInterval(() => {
    if (running) return;
    running = true;
    tickRaceWatchdog()
      .catch(err => logger.warn({ event: "race_watchdog_tick_failed", err: err instanceof Error ? err.message : String(err) }, "Race watchdog tick failed"))
      .finally(() => { running = false; });
  }, TICK_MS);
  timer.unref?.();
}

export function stopRaceWatchdog(): void {
  if (timer) clearInterval(timer);
  timer = null;
}
