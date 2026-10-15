/**
 * Timing ingest authorization (Phase 1 of docs/timing-ingest-auth-plan.md).
 *
 * Every crossing ingest request resolves to a principal:
 *   - reader: a registered reader's token, from the URL path or
 *             `Authorization: Bearer <readerToken>`
 *   - user:   an organizer/admin/staff session (staff permissions are already
 *             enforced by staffPermissionMiddleware)
 *   - none:   legacy unauthenticated hardware and bridges
 *
 * A reader or user principal from a different club than the request targets is
 * rejected with 403. A request with no principal is handled by the target club's
 * `timing_ingest_auth` setting: off (accept), warn (accept and log) or enforce
 * (401). Clubs default to off, so callers working today keep working.
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
 * Effective mode for a club. TIMING_INGEST_AUTH_OVERRIDE=off is a global kill
 * switch that restores the old open behavior without a database change.
 */
export async function timingIngestAuthMode(clubId: number | null): Promise<TimingIngestAuthMode> {
  if (process.env.TIMING_INGEST_AUTH_OVERRIDE === "off") return "off";
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
 * present but is not a known reader token: a credential that was presented and
 * failed is rejected, never silently downgraded to "none".
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
    // staffPermissionMiddleware already loaded staff and checked permissions.
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
  if (principal === "invalid_bearer") {
    return { allow: false, status: 401, body: { ok: false, error: "Invalid reader token" } };
  }
  if (principal.kind === "reader" || (principal.kind === "user" && !principal.platformWide)) {
    if (targetClubId !== null && principal.clubId !== targetClubId) {
      return { allow: false, status: 403, body: { ok: false, error: "Forbidden: credential belongs to a different club" } };
    }
    return { allow: true };
  }
  if (principal.kind === "user") return { allow: true };
  if (mode === "enforce") {
    return {
      allow: false,
      status: 401,
      body: {
        ok: false,
        error: "This club requires a reader token for timing ingest",
        hint: "Use the per-reader URL from Reader Setup, or send Authorization: Bearer <reader token>.",
      },
    };
  }
  return { allow: true };
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
): Promise<boolean> {
  const principal = await resolveIngestPrincipal(req, res);
  res.locals.ingestPrincipal = principal === "invalid_bearer" ? "invalid_bearer" : principal.kind;
  const mode = principal !== "invalid_bearer" && principal.kind === "none"
    ? await timingIngestAuthMode(targetClubId)
    : "off";
  const decision = decideIngest(principal, targetClubId, mode);
  if (!decision.allow) {
    res.status(decision.status).json(decision.body);
    return false;
  }
  if (mode === "warn") {
    logger.warn({ route, clubId: targetClubId }, "Unauthenticated timing ingest accepted (club is in warn mode)");
  }
  return true;
}
