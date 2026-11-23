/**
 * When the desktop sync engine talks to the cloud. Pure functions so the
 * timing can be unit tested without a database or a network.
 *
 * Pushes are driven by local writes (a cheap SQLite check every second), not
 * by the pull timer, so a new registration or lap crossing still reaches the
 * cloud within ~1–2 s. Pulls download the club's whole dataset, so they run on
 * an adaptive timer instead of every 2 s:
 *
 *   race day (an event in race_day status, or dated today and not finished): 10 s
 *   someone is using this computer:                                          15 s
 *   nobody is, and the last pulls brought nothing new:              30 s, then 60 s
 *
 * Failed cycles back off 2, 4, 8, 16, 30, 30 … s; each retry first asks the
 * cheap /api/healthz, and a manual "Sync now" always runs at once.
 */

export const SYNC_TIMING = {
  /** How often the local database is checked for new queued writes. */
  localCheckMs: 1_000,
  /** Wait after a detected local write so a burst goes out as one push. */
  pushDebounceMs: 250,
  /** A push also pulls when the last pull is at least this old. */
  pullAfterPushMinGapMs: 5_000,
  /** Pull interval while an event is on race day. */
  raceDayPullMs: 10_000,
  /** Pull interval while someone is using the computer. */
  activePullMs: 15_000,
  /** Pull interval when nobody is using it and the last pulls were unchanged. */
  idlePullMs: 30_000,
  /** Pull interval once it has been idle and unchanged for longer. */
  deepIdlePullMs: 60_000,
  /** Unchanged pulls before the idle interval applies. */
  idleAfterUnchangedPulls: 3,
  /** Unchanged pulls before the deep-idle interval applies. */
  deepIdleAfterUnchangedPulls: 6,
  /** First retry delay after a failed cycle; doubles per failure. */
  backoffBaseMs: 2_000,
  /** Longest wait between retries while the cloud is unreachable or failing. */
  backoffMaxMs: 30_000,
  /** A session that worked within this long is reused without asking /api/auth/me. */
  sessionRecheckMs: 5 * 60_000,
  /** Smallest pull interval a manual override (sync:setInterval) may set. */
  minOverrideMs: 2_000,
} as const;

export type SyncTiming = { [K in keyof typeof SYNC_TIMING]: number };

/** Delay before retry number `failures` (1 = the first failure). */
export function backoffDelay(failures: number, timing: SyncTiming = SYNC_TIMING): number {
  if (failures <= 0) return 0;
  const exp = Math.min(failures - 1, 20);
  return Math.min(timing.backoffMaxMs, timing.backoffBaseMs * 2 ** exp);
}

export type PullContext = {
  /** An event in this club is racing today. */
  raceDay: boolean;
  /** Someone has used this computer recently and the window is showing. */
  userActive: boolean;
  /** Consecutive successful pulls whose response matched the previous one. */
  unchangedPulls: number;
};

/** How long to wait before the next pull when everything is working. */
export function pullInterval(ctx: PullContext, timing: SyncTiming = SYNC_TIMING): number {
  if (ctx.raceDay) return timing.raceDayPullMs;
  if (ctx.userActive) return timing.activePullMs;
  if (ctx.unchangedPulls >= timing.deepIdleAfterUnchangedPulls) return timing.deepIdlePullMs;
  if (ctx.unchangedPulls >= timing.idleAfterUnchangedPulls) return timing.idlePullMs;
  return timing.activePullMs;
}

export type CycleOutcome = PullContext & {
  /** Consecutive failed cycles, including this one (0 when it succeeded). */
  failures: number;
  /** A fixed pull interval set through sync:setInterval, or null. */
  overrideMs: number | null;
};

/** When the next full (push + pull) cycle should start, relative to now. */
export function nextFullCycleDelay(o: CycleOutcome, timing: SyncTiming = SYNC_TIMING): number {
  if (o.failures > 0) return backoffDelay(o.failures, timing);
  if (o.overrideMs != null) return Math.max(timing.minOverrideMs, o.overrideMs);
  return pullInterval(o, timing);
}

/** Whether a push-triggered cycle should also pull. */
export function shouldPullAfterPush(
  nowMs: number,
  lastPullAtMs: number | null,
  timing: SyncTiming = SYNC_TIMING,
): boolean {
  return lastPullAtMs == null || nowMs - lastPullAtMs >= timing.pullAfterPushMinGapMs;
}

/** Whether a known-good session can be used without asking /api/auth/me. */
export function sessionStillTrusted(
  nowMs: number,
  lastConfirmedAtMs: number | null,
  timing: SyncTiming = SYNC_TIMING,
): boolean {
  return lastConfirmedAtMs != null && nowMs - lastConfirmedAtMs < timing.sessionRecheckMs;
}

/** YYYY-MM-DD in this computer's local time zone (event dates are local). */
export function localDateKey(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** Whether a fetch rejection means the network or server could not be reached. */
export function isNetworkError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  if (err.name === "AbortError" || err.name === "TimeoutError") return true;
  if (err instanceof TypeError && /fetch failed|network|ECONN|ENOTFOUND|ETIMEDOUT|EAI_AGAIN/i.test(err.message)) return true;
  const cause = (err as { cause?: { code?: string } }).cause;
  return typeof cause?.code === "string" && /^(ECONN|ENOTFOUND|ETIMEDOUT|EAI_AGAIN|UND_ERR|ENETUNREACH|EHOSTUNREACH)/.test(cause.code);
}
