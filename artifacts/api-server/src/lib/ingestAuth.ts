/**
 * Timing ingest authorization (Phase 1 of docs/timing-ingest-auth-plan.md).
 *
 * Every crossing ingest request resolves to a principal:
 *   - reader: a registered reader's token, from the URL path or
 *             `Authorization: Bearer <readerToken>`
 *   - user:   an organizer/admin/staff session (staff permissions are already
 *             enforced by accessControlMiddleware)
 *   - none:   legacy unauthenticated hardware and bridges
 *
 * A reader or user principal from a different club than the request targets is
 * rejected with 403. A request with no principal, or with a bearer token that
 * doesn't verify, is logged as `timing_ingest_unauthenticated` and accepted
 * unless enforcement is on: TIMING_INGEST_ENFORCE (all clubs) or the club's
 * `timing_ingest_auth` = enforce. Both default off, so callers working today
 * (older RM Connect, older bridges, hand-programmed facility URLs) keep working.
 *
 * Lookups are cached briefly so authorization adds no measurable latency ahead
 * of crossing processing. All checks run before processCrossing and never
 * inside the per-moto lock.
 */
import type { Request, Response } from "express";
import { db } from "@workspace/db";
import { clubsTable, eventsTable, motosTable, readersTable, usersTable, type Reader } from "@workspace/db/schema";
import { eq } from "drizzle-orm";
import { logger } from "./logger";

export type TimingIngestAuthMode = "off" | "warn" | "enforce";

export type IngestPrincipal =
  | { kind: "reader"; readerId: number; clubId: number }
  | { kind: "user"; userId: number; clubId: number | null; platformWide: boolean }
  | { kind: "none" };

class TtlCache<K, V> {
  private entries = new Map<K, { value: V; expiresAt: number }>();
  constructor(private ttlMs: number, private maxEntries: number) {}

  get(key: K): V | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt <= Date.now()) {
      this.entries.delete(key);
      return undefined;
    }
    return entry.value;
  }

  set(key: K, value: V): void {
    if (this.entries.size >= this.maxEntries) this.entries.clear();
    this.entries.set(key, { value, expiresAt: Date.now() + this.ttlMs });
  }

  delete(key: K): void {
    this.entries.delete(key);
  }

  clear(): void {
    this.entries.clear();
  }
}

const readerByToken = new TtlCache<string, Reader | null>(30_000, 2_000);
const clubByEvent = new TtlCache<number, number | null>(60_000, 5_000);
const clubByMoto = new TtlCache<number, number | null>(60_000, 5_000);
const modeByClub = new TtlCache<number, TimingIngestAuthMode>(10_000, 2_000);

/** Test hook: drop every cached lookup. */
export function clearIngestAuthCaches(): void {
  readerByToken.clear();
  clubByEvent.clear();
  clubByMoto.clear();
  modeByClub.clear();
}

export async function findReaderByToken(token: string): Promise<Reader | null> {
  const cached = readerByToken.get(token);
  if (cached !== undefined) return cached;
  const [reader] = await db.select().from(readersTable).where(eq(readersTable.token, token));
  readerByToken.set(token, reader ?? null);
  return reader ?? null;
}

/** Call when a token is rotated or its reader deleted, so it stops working at once. */
export function forgetReaderToken(token: string): void {
  readerByToken.delete(token);
}

function positiveId(value: unknown): number | null {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : null;
}

export async function clubIdForEvent(eventId: unknown): Promise<number | null> {
  const id = positiveId(eventId);
  if (id === null) return null;
  const cached = clubByEvent.get(id);
  if (cached !== undefined) return cached;
  const [event] = await db.select({ clubId: eventsTable.clubId }).from(eventsTable).where(eq(eventsTable.id, id));
  const clubId = event?.clubId ?? null;
  clubByEvent.set(id, clubId);
  return clubId;
}

export async function clubIdForMoto(motoId: unknown): Promise<number | null> {
  const id = positiveId(motoId);
  if (id === null) return null;
  const cached = clubByMoto.get(id);
  if (cached !== undefined) return cached;
  const [row] = await db
    .select({ clubId: eventsTable.clubId })
    .from(motosTable)
    .innerJoin(eventsTable, eq(motosTable.eventId, eventsTable.id))
    .where(eq(motosTable.id, id));
  const clubId = row?.clubId ?? null;
  clubByMoto.set(id, clubId);
  return clubId;
}

/**
 * TIMING_INGEST_ENFORCE=1 (or true/on/enforce) enforces credentials for every
 * club at once. Default off: RM Connect before 1.0.16, older rfid_bridge.py
 * downloads and readers hand-programmed with the ?clubId= facility URL send no
 * credential, so they keep working (and are logged) until the owner flips it.
 */
export function globalIngestEnforce(): boolean {
  const v = (process.env.TIMING_INGEST_ENFORCE ?? "").trim().toLowerCase();
  return v === "1" || v === "true" || v === "on" || v === "yes" || v === "enforce";
}

/**
 * Effective mode for a club. TIMING_INGEST_AUTH_OVERRIDE=off is a global kill
 * switch that restores the old open behavior without a database change; it wins
 * over TIMING_INGEST_ENFORCE so an emergency rollback is one variable.
 */
export async function timingIngestAuthMode(clubId: number | null): Promise<TimingIngestAuthMode> {
  if (process.env.TIMING_INGEST_AUTH_OVERRIDE === "off") return "off";
  if (globalIngestEnforce()) return "enforce";
  if (clubId === null) return "off";
  const cached = modeByClub.get(clubId);
  if (cached !== undefined) return cached;
  const [club] = await db
    .select({ mode: clubsTable.timingIngestAuth })
    .from(clubsTable)
    .where(eq(clubsTable.id, clubId));
  const mode: TimingIngestAuthMode = club?.mode === "warn" || club?.mode === "enforce" ? club.mode : "off";
  modeByClub.set(clubId, mode);
  return mode;
}

export function bearerToken(authorization: string | undefined): string | null {
  if (typeof authorization !== "string") return null;
  const match = /^Bearer\s+(\S+)\s*$/i.exec(authorization);
  return match ? match[1] : null;
}

/**
 * Resolve the caller. Returns "invalid_bearer" when an Authorization header is
 * present but is not a known reader token. It is never treated as a credential:
 * decideIngest handles it like a missing one (logged, and refused once enforced).
 */
export async function resolveIngestPrincipal(
  req: Request,
  res: Response,
): Promise<IngestPrincipal | "invalid_bearer"> {
  if (req.headers.authorization !== undefined) {
    const token = bearerToken(req.headers.authorization);
    const reader = token ? await findReaderByToken(token) : null;
    if (!reader) return "invalid_bearer";
    return { kind: "reader", readerId: reader.id, clubId: reader.clubId };
  }

  const userId = (req.session as any)?.userId;
  if (typeof userId === "number") {
    // accessControlMiddleware already loaded staff and checked permissions.
    const staffClubId = res.locals?.staffClubId;
    if (typeof staffClubId === "number") {
      return { kind: "user", userId, clubId: staffClubId, platformWide: false };
    }
    const [user] = await db
      .select({ role: usersTable.role, clubId: usersTable.clubId })
      .from(usersTable)
      .where(eq(usersTable.id, userId));
    if (user?.role === "super_admin") return { kind: "user", userId, clubId: user.clubId, platformWide: true };
    if (user?.clubId != null) return { kind: "user", userId, clubId: user.clubId, platformWide: false };
  }

  return { kind: "none" };
}

export type IngestDecision =
  | { allow: true }
  | { allow: false; status: 401 | 403; body: Record<string, unknown> };

/** Pure decision for a resolved principal; kept separate so it can be unit tested. */
export function decideIngest(
  principal: IngestPrincipal | "invalid_bearer",
  targetClubId: number | null,
  mode: TimingIngestAuthMode,
): IngestDecision {
  if (principal !== "invalid_bearer" && (principal.kind === "reader" || (principal.kind === "user" && !principal.platformWide))) {
    // A credential that names a club only reaches that club's motos/events/practice.
    if (targetClubId !== null && principal.clubId !== targetClubId) {
      return { allow: false, status: 403, body: { ok: false, error: "Forbidden: credential belongs to a different club" } };
    }
    return { allow: true };
  }
  if (principal !== "invalid_bearer" && principal.kind === "user") return { allow: true };
  // No credential, or one that didn't verify (unknown/rotated reader token).
  // Until enforcement is on this is no worse than sending nothing, so it is
  // accepted like a missing credential and logged as timing_ingest_unauthenticated.
  if (mode === "enforce") {
    return {
      allow: false,
      status: 401,
      body: principal === "invalid_bearer"
        ? { ok: false, error: "Invalid reader token" }
        : {
          ok: false,
          error: "This club requires a reader token for timing ingest",
          hint: "Use the per-reader URL from Reader Setup, or send Authorization: Bearer <reader token>.",
        },
    };
  }
  return { allow: true };
}

export type IngestHints = { motoId?: unknown; eventId?: unknown; practiceSessionId?: unknown };

// One warning per route/club/IP a minute, with a count of the ones folded in, so
// a reader posting several times a second can't flood the logs.
const UNAUTH_LOG_WINDOW_MS = 60_000;
const unauthLogState = new Map<string, { loggedAt: number; suppressed: number }>();

function shortText(v: unknown): string | undefined {
  return typeof v === "string" || typeof v === "number" ? String(v).slice(0, 60) : undefined;
}

/** What an unauthenticated reader says about itself: generic readerId, Impinj hostname, or bridge source. */
export function readerHint(body: unknown): { readerId?: string; source?: string } {
  if (!body || typeof body !== "object") return {};
  const b = body as Record<string, any>;
  const firstEvent = Array.isArray(b.events) ? b.events[0] : undefined;
  return {
    readerId: shortText(b.readerId) ?? shortText(b.reader_id) ?? shortText(firstEvent?.hostname) ?? shortText(b.hostname),
    source: shortText(b.source) ?? shortText(b.timeSource),
  };
}

function logUnauthenticatedIngest(
  req: Request,
  route: string,
  targetClubId: number | null,
  hints: IngestHints,
  reason: "no_credential" | "invalid_credential",
  enforced: boolean,
): void {
  const ip = req.ip ?? null;
  const key = `${route}|${targetClubId ?? "-"}|${ip ?? "-"}|${reason}|${enforced}`;
  const now = Date.now();
  const prev = unauthLogState.get(key);
  if (prev && now - prev.loggedAt < UNAUTH_LOG_WINDOW_MS) {
    prev.suppressed++;
    return;
  }
  if (unauthLogState.size > 5_000) unauthLogState.clear();
  unauthLogState.set(key, { loggedAt: now, suppressed: 0 });
  const num = (v: unknown) => (positiveId(v) ?? undefined);
  const reader = readerHint(req.body);
  logger.warn({
    event: "timing_ingest_unauthenticated",
    route,
    clubId: targetClubId,
    motoId: num(hints.motoId),
    eventId: num(hints.eventId),
    practiceSessionId: num(hints.practiceSessionId),
    // Which reader to update: its self-reported id/hostname/source (no credential to go by).
    readerId: reader.readerId,
    readerSource: reader.source,
    callerIp: ip,
    userAgent: typeof req.headers["user-agent"] === "string" ? req.headers["user-agent"].slice(0, 120) : undefined,
    reason,
    enforced,
    suppressedSinceLast: prev?.suppressed ?? 0,
  }, "timing_ingest_unauthenticated");
}

/**
 * Authorize an ingest request against the club it targets. Sends the error
 * response and returns false when the request is rejected.
 */
export async function authorizeIngest(
  req: Request,
  res: Response,
  targetClubId: number | null,
  route: string,
  hints: IngestHints = {},
): Promise<boolean> {
  const principal = await resolveIngestPrincipal(req, res);
  res.locals.ingestPrincipal = principal === "invalid_bearer" ? "invalid_bearer" : principal.kind;
  const unauthenticated = principal === "invalid_bearer" || principal.kind === "none";
  const mode = unauthenticated ? await timingIngestAuthMode(targetClubId) : "off";
  const decision = decideIngest(principal, targetClubId, mode);
  if (unauthenticated) {
    logUnauthenticatedIngest(req, route, targetClubId, hints,
      principal === "invalid_bearer" ? "invalid_credential" : "no_credential", !decision.allow);
  }
  if (!decision.allow) {
    res.status(decision.status).json(decision.body);
    return false;
  }
  return true;
}

/** True when this request was authorized by a reader token or an organizer session. */
export function ingestCallerIsAuthenticated(res: Response): boolean {
  return res.locals.ingestPrincipal === "reader" || res.locals.ingestPrincipal === "user";
}
