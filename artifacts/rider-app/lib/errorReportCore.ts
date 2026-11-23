// Pure parts of lib/errorReport.ts (no React Native imports, so node tests can load it).

/** What the API accepts (api-server lib/appErrorReport.ts). */
export const MAX_BODY_BYTES = 8 * 1024;
export const MAX_STACK_CHARS = 4 * 1024;
export const MAX_MESSAGE_CHARS = 500;
/** Reports sent per app session (cold start to cold start). */
export const MAX_REPORTS_PER_SESSION = 10;

export type ErrorSource = "boundary" | "global" | "promise" | "caught";

export interface ErrorReportMeta {
  route: string | null;
  appVersion: string | null;
  runtimeVersion: string | null;
  updateId: string | null;
  platform: string;
  osVersion: string | null;
  installId: string | null;
}

export interface ErrorReportPayload extends ErrorReportMeta {
  message: string;
  name: string | null;
  stack: string | null;
  source: ErrorSource;
  context: string | null;
  fatal: boolean;
}

const EMAIL = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;
const BEARER = /\bBearer\s+[A-Za-z0-9._~+/=-]+/gi;

/** Masks emails and bearer tokens: an error message can quote what the rider typed. */
export function scrub(text: string): string {
  return text.replace(EMAIL, "[email]").replace(BEARER, "Bearer [token]");
}

export function utf8Length(text: string): number {
  let n = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c < 0x80) n += 1;
    else if (c < 0x800) n += 2;
    else if (c >= 0xd800 && c <= 0xdbff) { n += 4; i++; }
    else n += 3;
  }
  return n;
}

/** Anything thrown (Error, string, object) as name/message/stack. */
export function describeError(error: unknown): { name: string | null; message: string; stack: string | null } {
  if (error instanceof Error) {
    return { name: error.name || null, message: error.message || String(error), stack: error.stack ?? null };
  }
  if (typeof error === "string") return { name: null, message: error, stack: null };
  try {
    return { name: null, message: JSON.stringify(error) ?? String(error), stack: null };
  } catch {
    return { name: null, message: String(error), stack: null };
  }
}

/** Route template ("/racer/[id]", never the real id) from expo-router segments. */
export function routeFromSegments(segments: readonly string[]): string {
  return `/${segments.join("/")}`.slice(0, 200);
}

/** A labelled context: letters, digits and a few separators, at most 100 characters. */
function cleanContext(context: string | undefined): string | null {
  if (!context) return null;
  const c = context.replace(/[^\w .:/-]/g, "").slice(0, 100).trim();
  return c || null;
}

/** Builds the JSON body, trimmed so it always fits the API's limits. */
export function buildReport(
  error: unknown,
  opts: { source: ErrorSource; fatal?: boolean; context?: string; extraStack?: string },
  meta: ErrorReportMeta,
): string {
  const d = describeError(error);
  let stack = d.stack ?? "";
  if (opts.extraStack) stack += `\nComponent stack:${opts.extraStack}`;
  stack = scrub(stack).slice(0, MAX_STACK_CHARS);
  const payload: ErrorReportPayload = {
    ...meta,
    message: scrub(d.message.trim() || "(no message)").slice(0, MAX_MESSAGE_CHARS),
    name: d.name ? d.name.slice(0, 100) : null,
    stack: stack || null,
    source: opts.source,
    context: cleanContext(opts.context),
    fatal: opts.fatal === true,
  };
  let body = JSON.stringify(payload);
  // Multi-byte text can push a 4,096-character stack past 8 KB: halve it until it fits.
  while (utf8Length(body) > MAX_BODY_BYTES - 256 && payload.stack) {
    payload.stack = payload.stack.slice(0, Math.floor(payload.stack.length / 2)) || null;
    body = JSON.stringify(payload);
  }
  return body;
}

/** Per-session budget and duplicate filter. */
export class ReportGate {
  private seen = new Set<string>();
  private sent = 0;
  constructor(private max = MAX_REPORTS_PER_SESSION) {}

  /** True when this error should be sent (first time seen, budget left). */
  take(key: string): boolean {
    if (this.sent >= this.max || this.seen.has(key)) return false;
    this.seen.add(key);
    this.sent++;
    return true;
  }
}

/** Random install id (not tied to any account). */
export function newInstallId(random: () => number = Math.random): string {
  const hex = (n: number) => Array.from({ length: n }, () => Math.floor(random() * 16).toString(16)).join("");
  return `${hex(8)}-${hex(4)}-4${hex(3)}-${"89ab"[Math.floor(random() * 4)]}${hex(3)}-${hex(12)}`;
}
