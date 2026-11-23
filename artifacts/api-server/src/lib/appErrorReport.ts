// Rider app JS error reports (POST /api/app-errors, routes/app-errors.ts).
//
// The rider app ships over the air, so a crash in a new update is otherwise
// invisible until a rider complains. Reports are logged as one structured
// `rider_app_error` line each; nothing is stored in the database.
//
// Questions this answers for whoever is on call:
//   1. Did the latest update (updateId) start throwing errors it didn't before?
//   2. Which screen (route template) and which error (name + message + stack)?
//   3. Is it one install hammering or many riders (installId, per-update count)?
//
// Privacy: only the allowlisted fields below are kept, emails and long
// token-like strings are masked, and the client never sends names, accounts or
// request bodies. The caller's address is not added here (the request logger
// already records the request).

/** Whole JSON body, as received. */
export const MAX_BODY_BYTES = 8 * 1024;
/** Stack trace kept in the log line. */
export const MAX_STACK_CHARS = 4 * 1024;
const MAX_MESSAGE_CHARS = 500;

export type AppErrorSource = "boundary" | "global" | "promise" | "caught";
const SOURCES = new Set<AppErrorSource>(["boundary", "global", "promise", "caught"]);
const PLATFORMS = new Set(["ios", "android", "web"]);

export interface AppErrorReport {
  message: string;
  name: string | null;
  stack: string | null;
  source: AppErrorSource | null;
  context: string | null;
  fatal: boolean;
  route: string | null;
  appVersion: string | null;
  runtimeVersion: string | null;
  updateId: string | null;
  platform: string | null;
  osVersion: string | null;
  installId: string | null;
}

export type ParseResult =
  | { ok: true; report: AppErrorReport }
  | { ok: false; status: 400 | 413; error: string };

const EMAIL = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;
// Bearer tokens, JWTs, long hex/base64 secrets that ended up inside an error message.
const BEARER = /\bBearer\s+[A-Za-z0-9._~+/=-]+/gi;
const LONG_TOKEN = /\b[A-Za-z0-9_-]{32,}(\.[A-Za-z0-9_-]+){0,2}\b/g;

/** Masks emails and token-like strings so an error message can't leak them into logs. */
export function scrubText(text: string): string {
  return text.replace(EMAIL, "[email]").replace(BEARER, "Bearer [token]").replace(LONG_TOKEN, "[token]");
}

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/** Byte length of a parsed body as JSON (the body may have arrived chunked, without Content-Length). */
export function jsonByteLength(body: unknown): number {
  try { return Buffer.byteLength(JSON.stringify(body) ?? "", "utf8"); } catch { return Infinity; }
}

/**
 * Validates and trims a report. Unknown fields are dropped; a field of the wrong
 * type is a 400, a body over MAX_BODY_BYTES is a 413.
 */
export function parseAppErrorReport(body: unknown, declaredBytes?: number): ParseResult {
  if ((declaredBytes ?? 0) > MAX_BODY_BYTES || jsonByteLength(body) > MAX_BODY_BYTES) {
    return { ok: false, status: 413, error: "Report too large" };
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { ok: false, status: 400, error: "Expected a JSON object" };
  }
  const b = body as Record<string, unknown>;
  if (typeof b.message !== "string" || b.message.trim() === "") {
    return { ok: false, status: 400, error: "message is required" };
  }

  let bad: string | null = null;
  const str = (key: string, max: number, pattern?: RegExp): string | null => {
    const v = b[key];
    if (v == null) return null;
    if (typeof v !== "string") { bad ??= key; return null; }
    const t = v.trim();
    if (t === "") return null;
    if (pattern && !pattern.test(t)) { bad ??= key; return null; }
    return clip(t, max);
  };

  const sourceRaw = str("source", 20);
  if (sourceRaw && !SOURCES.has(sourceRaw as AppErrorSource)) bad ??= "source";
  const platform = str("platform", 10);
  if (platform && !PLATFORMS.has(platform)) bad ??= "platform";
  if (b.fatal != null && typeof b.fatal !== "boolean") bad ??= "fatal";

  const report: AppErrorReport = {
    message: scrubText(clip(b.message.trim(), MAX_MESSAGE_CHARS)),
    name: str("name", 100),
    stack: null,
    source: sourceRaw && SOURCES.has(sourceRaw as AppErrorSource) ? (sourceRaw as AppErrorSource) : null,
    context: str("context", 100, /^[\w .:/-]+$/),
    fatal: b.fatal === true,
    route: str("route", 200, /^[\w ()[\]/.+-]*$/),
    appVersion: str("appVersion", 40, /^[\w.+-]+$/),
    runtimeVersion: str("runtimeVersion", 40, /^[\w.+-]+$/),
    updateId: str("updateId", 64, /^[\w-]+$/),
    platform: platform && PLATFORMS.has(platform) ? platform : null,
    osVersion: str("osVersion", 40, /^[\w .+-]+$/),
    installId: str("installId", 64, /^[\w-]+$/),
  };
  const stack = str("stack", MAX_STACK_CHARS);
  report.stack = stack ? scrubText(stack) : null;
  if (report.name) report.name = scrubText(report.name);

  if (bad) return { ok: false, status: 400, error: `Invalid ${bad}` };
  return { ok: true, report };
}

/** Fixed-window per-address limiter: `max` reports a minute. In memory (single instance). */
export class ReportRateLimiter {
  private hits = new Map<string, { windowStart: number; count: number }>();
  constructor(private max = 20, private windowMs = 60_000) {}

  allow(key: string, now = Date.now()): boolean {
    const entry = this.hits.get(key);
    if (!entry || now - entry.windowStart >= this.windowMs) {
      if (this.hits.size > 5_000) this.hits.clear();
      this.hits.set(key, { windowStart: now, count: 1 });
      return true;
    }
    entry.count++;
    return entry.count <= this.max;
  }
}

/** Running count of reports per update id since this server started (bounded). */
export class UpdateErrorCounter {
  private counts = new Map<string, number>();
  constructor(private maxKeys = 200) {}

  increment(updateId: string | null): number {
    const key = updateId ?? "embedded";
    const next = (this.counts.get(key) ?? 0) + 1;
    if (!this.counts.has(key) && this.counts.size >= this.maxKeys) this.counts.clear();
    this.counts.set(key, next);
    return next;
  }
}
