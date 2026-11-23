/**
 * Race-day watchdog decisions (pure; no database, clock or SMS). raceWatchdog.ts
 * feeds it the in-progress motos once a minute and sends what it returns.
 *
 * Questions it answers for whoever is on call during a race:
 *  1. Did live timing stop? A running race with no accepted crossing for a while
 *     ("stale"): reader, RM Connect or network trouble at the track.
 *  2. Was a race left running? In progress far past its time limit, or 90 min
 *     without one ("long_running").
 *  3. Is timing back? One "recovered" text when crossings resume after a stale alert.
 */

export type WatchdogKind = "stale" | "long_running";

export type WatchdogMoto = {
  motoId: number;
  motoName: string;
  eventName: string;
  clubName: string;
  type: string;
  startedAtMs: number;
  /** Set while the organizer has the moto paused (motos.paused_at). */
  pausedAtMs: number | null;
  /** motos.total_paused_ms: completed pauses only. */
  totalPausedMs: number;
  timeLimitMs: number | null;
  /** Server receive time of the newest accepted crossing (lap_crossings.created_at). */
  lastCrossingMs: number | null;
  /** When the watchdog saw the moto come out of a pause (in memory; null after a restart). */
  resumedAtMs: number | null;
};

export type WatchdogConfig = {
  staleMs: number;
  repeatMs: number;
  /** In progress longer than this with no time limit. */
  longNoLimitMs: number;
  /** In progress longer than limit x this. */
  longLimitFactor: number;
};

export type WatchdogAlert = {
  kind: WatchdogKind | "recovered";
  moto: WatchdogMoto;
  /** Minutes without a crossing (stale/recovered) or minutes running (long_running). */
  minutes: number;
  text: string;
};

/** Per moto+kind: when the last text went out. Kept by the caller between ticks. */
export type WatchdogState = Map<string, { lastSentMs: number; lastCrossingMs?: number | null }>;

const MIN = 60_000;

/** Practice sessions idle legitimately and enduro tests run for hours with long gaps. */
export function watchdogApplies(type: string): boolean {
  return type !== "practice" && type !== "enduro_test";
}

function label(m: WatchdogMoto): string {
  return `${m.motoName} (${m.eventName}, ${m.clubName})`;
}

function stateKey(motoId: number, kind: WatchdogKind): string {
  return `${motoId}:${kind}`;
}

/** Racing time so far, not counting pauses. */
export function activeRaceMs(m: WatchdogMoto, nowMs: number): number {
  const pausedNow = m.pausedAtMs !== null ? Math.max(0, nowMs - m.pausedAtMs) : 0;
  return Math.max(0, nowMs - m.startedAtMs - m.totalPausedMs - pausedNow);
}

/**
 * How long timing has been quiet, or null when it isn't measurable yet. Before
 * the first crossing the whole first lap counts, so pauses since the start are
 * taken off; after a resume the clock restarts at the resume.
 */
export function quietMs(m: WatchdogMoto, nowMs: number): number {
  if (m.lastCrossingMs === null) {
    const since = Math.max(m.startedAtMs, m.resumedAtMs ?? 0);
    const raw = nowMs - since;
    return Math.max(0, since === m.startedAtMs ? raw - m.totalPausedMs : raw);
  }
  return Math.max(0, nowMs - Math.max(m.lastCrossingMs, m.resumedAtMs ?? 0));
}

/**
 * Before the first crossing, wait twice the threshold: long cross-country laps
 * mean nobody crosses for a while after the gate drops.
 */
export function staleThresholdMs(m: WatchdogMoto, cfg: WatchdogConfig): number {
  return m.lastCrossingMs === null ? cfg.staleMs * 2 : cfg.staleMs;
}

export function longRunningThresholdMs(m: WatchdogMoto, cfg: WatchdogConfig): number {
  return m.timeLimitMs && m.timeLimitMs > 0 ? m.timeLimitMs * cfg.longLimitFactor : cfg.longNoLimitMs;
}

/**
 * Decide what to send this tick. Mutates `state`: records sends, clears a stale
 * alert when crossings resume, and forgets motos that are no longer running.
 */
export function evaluateWatchdog(
  motos: WatchdogMoto[],
  state: WatchdogState,
  nowMs: number,
  cfg: WatchdogConfig,
): WatchdogAlert[] {
  const out: WatchdogAlert[] = [];
  const running = new Set<number>();

  for (const m of motos) {
    if (!watchdogApplies(m.type)) continue;
    running.add(m.motoId);

    // Stale timing. A paused moto is quiet on purpose: no alert, but an open
    // alert stays open until crossings really resume.
    const staleKey = stateKey(m.motoId, "stale");
    const staleOpen = state.get(staleKey);
    const quiet = quietMs(m, nowMs);
    const threshold = staleThresholdMs(m, cfg);
    if (m.pausedAtMs === null) {
      if (quiet >= threshold) {
        if (!staleOpen || nowMs - staleOpen.lastSentMs >= cfg.repeatMs) {
          const minutes = Math.floor(quiet / MIN);
          out.push({
            kind: "stale", moto: m, minutes,
            text: `RM Roost race watchdog: no timing crossings for ${minutes} min in ${label(m)}. The race is still running. Check the readers / RM Connect at the track.`,
          });
          state.set(staleKey, { lastSentMs: nowMs, lastCrossingMs: m.lastCrossingMs });
        }
      } else if (staleOpen && m.lastCrossingMs !== null && m.lastCrossingMs !== staleOpen.lastCrossingMs) {
        // A new crossing arrived since the alert (not just a resume from a pause).
        state.delete(staleKey);
        const minutes = Math.floor(quiet / MIN);
        out.push({
          kind: "recovered", moto: m, minutes,
          text: `RM Roost race watchdog: timing crossings resumed in ${label(m)}.`,
        });
      }
    }

    // Left running far too long.
    const longKey = stateKey(m.motoId, "long_running");
    const longOpen = state.get(longKey);
    const active = activeRaceMs(m, nowMs);
    if (active >= longRunningThresholdMs(m, cfg) && (!longOpen || nowMs - longOpen.lastSentMs >= cfg.repeatMs)) {
      const minutes = Math.floor(active / MIN);
      const limit = m.timeLimitMs ? ` (time limit ${Math.round(m.timeLimitMs / MIN)} min)` : "";
      out.push({
        kind: "long_running", moto: m, minutes,
        text: `RM Roost race watchdog: ${label(m)} has been in progress ${minutes} min${limit}. It may need to be ended.`,
      });
      state.set(longKey, { lastSentMs: nowMs });
    }
  }

  // Motos that finished, were cancelled or were reset: forget their alerts.
  for (const key of [...state.keys()]) {
    if (!running.has(Number(key.split(":")[0]))) state.delete(key);
  }
  return out;
}

function envNumber(value: string | undefined, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export function watchdogConfigFromEnv(env: NodeJS.ProcessEnv = process.env): WatchdogConfig {
  return {
    staleMs: envNumber(env.RACE_WATCHDOG_STALE_MIN, 6) * MIN,
    repeatMs: envNumber(env.RACE_WATCHDOG_REPEAT_MIN, 30) * MIN,
    longNoLimitMs: envNumber(env.RACE_WATCHDOG_LONG_MIN, 90) * MIN,
    longLimitFactor: 2,
  };
}
