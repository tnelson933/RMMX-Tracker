import { logger } from "./logger";
import { sendOpsText, type OpsSmsSender } from "./opsAlerts";

/**
 * Server-error (5xx) texts, throttled: the first 500 after a quiet window texts
 * at once; later ones within SERVER_ERROR_ALERT_WINDOW_MIN (default 15) are
 * counted and summarised in one text when the window ends. Every 500 still gets
 * its own `server_error` log line from the error handler.
 *
 * SERVER_ERROR_ALERTS=off stops the texts. Texts only in production unless
 * SERVER_ERROR_SMS=on (otherwise logged as ops_alert_sms_skipped).
 */

export type ErrorSummary = { count: number; topRoute: string; topRouteCount: number; routes: number };

/** Pure throttle: counts errors and says when a summary text is due. */
export class ErrorAlertThrottle {
  private lastSentMs: number | null = null;
  private pending = new Map<string, number>();

  constructor(private windowMs: number) {}

  /** Record one error. Returns a summary to send now, or null when it was folded into the window. */
  record(route: string, nowMs: number): ErrorSummary | null {
    this.pending.set(route, (this.pending.get(route) ?? 0) + 1);
    if (this.lastSentMs !== null && nowMs - this.lastSentMs < this.windowMs) return null;
    return this.take(nowMs);
  }

  /** When the window has passed and errors are waiting, the summary to send. */
  flush(nowMs: number): ErrorSummary | null {
    if (this.pending.size === 0) return null;
    if (this.lastSentMs !== null && nowMs - this.lastSentMs < this.windowMs) return null;
    return this.take(nowMs);
  }

  /** Ms until flush() can send, or null when nothing is waiting. */
  msUntilFlush(nowMs: number): number | null {
    if (this.pending.size === 0) return null;
    return this.lastSentMs === null ? 0 : Math.max(0, this.windowMs - (nowMs - this.lastSentMs));
  }

  private take(nowMs: number): ErrorSummary {
    let count = 0;
    let topRoute = "";
    let topRouteCount = 0;
    for (const [route, n] of this.pending) {
      count += n;
      if (n > topRouteCount) { topRoute = route; topRouteCount = n; }
    }
    const routes = this.pending.size;
    this.pending.clear();
    this.lastSentMs = nowMs;
    return { count, topRoute, topRouteCount, routes };
  }
}

export function summaryText(s: ErrorSummary, windowMin: number): string {
  const what = s.count === 1 ? "1 server error" : `${s.count} server errors`;
  const others = s.routes > 1 ? ` across ${s.routes} routes` : "";
  return `RM Roost: ${what}${others} (max one text per ${windowMin} min). Top: ${s.topRoute} (${s.topRouteCount}). Check the server_error lines in the Railway logs.`;
}

function windowMinFromEnv(): number {
  const n = Number(process.env.SERVER_ERROR_ALERT_WINDOW_MIN);
  return Number.isFinite(n) && n > 0 ? n : 15;
}

const windowMin = windowMinFromEnv();
const throttle = new ErrorAlertThrottle(windowMin * 60_000);
let flushTimer: ReturnType<typeof setTimeout> | null = null;
let sender: OpsSmsSender | undefined;

/** Test hook: route texts somewhere other than the support phones. */
export function setServerErrorSender(s: OpsSmsSender | undefined): void {
  sender = s;
}

function send(summary: ErrorSummary): void {
  logger.warn({ event: "server_error_alert", ...summary, windowMin }, "server_error_alert");
  void sendOpsText("server_error", summaryText(summary, windowMin), "SERVER_ERROR_SMS", sender);
}

function scheduleFlush(nowMs: number): void {
  if (flushTimer) return;
  const wait = throttle.msUntilFlush(nowMs);
  if (wait === null) return;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    const summary = throttle.flush(Date.now());
    if (summary) send(summary);
    else scheduleFlush(Date.now());
  }, wait + 1000);
  flushTimer.unref?.();
}

/** Called by the 500 handler with the route pattern (never the raw URL). */
export function noteServerError(route: string, nowMs = Date.now()): void {
  if ((process.env.SERVER_ERROR_ALERTS ?? "").trim().toLowerCase() === "off") return;
  try {
    const summary = throttle.record(route, nowMs);
    if (summary) send(summary);
    else scheduleFlush(nowMs);
  } catch (err) {
    logger.warn({ event: "server_error_alert_failed", err: err instanceof Error ? err.message : String(err) }, "server error alert failed");
  }
}
