import { db, riderAccountsTable, riderAiUsageTable, platformSettingsTable } from "@workspace/db";
import { and, count, eq, gte, min } from "drizzle-orm";
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * RM Roost Premium for riders ($4.99/month or $49.99/year): past stats and
 * history, unlimited Rocky (coach and mechanic), and watching live streams.
 *
 * SET UP, SWITCHED OFF. Every gate below asks `premiumEnforced()` first, and
 * while that is false (the default: no platform_settings row) every rider gets
 * everything, exactly as before. A super admin turns it on in Admin → Clubs.
 * Before turning it on, billing must exist (Stripe on the website, Apple and
 * Google in the app) so riders can actually buy it; until then an admin can
 * grant Premium to an account by email.
 *
 * Free riders keep everything for race day: today's live laps and standings,
 * registration, check-in, and 1 Rocky question every 24 hours.
 */

export const PREMIUM_ENFORCED_KEY = "premium_enforced";
/** Rocky questions a free rider gets per rolling 24 hours once Premium is on. */
export const FREE_ROCKY_QUESTIONS_PER_DAY = 1;
const DAY_MS = 24 * 3600 * 1000;

export async function premiumEnforced(): Promise<boolean> {
  const [row] = await db.select({ value: platformSettingsTable.value }).from(platformSettingsTable)
    .where(eq(platformSettingsTable.key, PREMIUM_ENFORCED_KEY));
  return row?.value === true;
}

export function premiumActive(premiumUntil: Date | null | undefined, now = new Date()): boolean {
  return !!premiumUntil && premiumUntil.getTime() > now.getTime();
}

export interface RiderAccess {
  /** Premium is switched on for RM Roost (false: everything is free). */
  enforced: boolean;
  /** This account has paid or granted Premium right now. */
  premium: boolean;
  premiumUntil: string | null;
  /** True when the rider can use Premium features: Premium is off, or they have it. */
  full: boolean;
}

export async function riderAccess(riderAccountId: number | null | undefined): Promise<RiderAccess> {
  const enforced = await premiumEnforced();
  let premiumUntil: Date | null = null;
  if (riderAccountId) {
    const [acct] = await db.select({ until: riderAccountsTable.premiumUntil }).from(riderAccountsTable)
      .where(eq(riderAccountsTable.id, riderAccountId));
    premiumUntil = acct?.until ?? null;
  }
  const premium = premiumActive(premiumUntil);
  return { enforced, premium, premiumUntil: premiumUntil?.toISOString() ?? null, full: !enforced || premium };
}

/** What the rider app and website show about Premium (from /rider/auth/me and /rider/auth/mobile-me). */
export async function premiumSummary(riderAccountId: number) {
  const a = await riderAccess(riderAccountId);
  return { enforced: a.enforced, active: a.premium, until: a.premiumUntil, freeRockyQuestionsPerDay: FREE_ROCKY_QUESTIONS_PER_DAY };
}

/** The error body clients show when a Premium feature is locked (HTTP 402). */
export function premiumRequired(feature: string, extra: Record<string, unknown> = {}) {
  return { error: `${feature} is part of RM Roost Premium. Upgrade to Premium to unlock it.`, code: "premium_required", ...extra };
}

// ── Rocky questions ─────────────────────────────────────────────────────────

export type RockyKind = "mechanic_chat" | "training_plan" | "maintenance_plan";

/**
 * Whether the rider may ask Rocky now. Free riders (only once Premium is on)
 * get FREE_ROCKY_QUESTIONS_PER_DAY in any rolling 24 hours; `nextFreeAt` says
 * when the next one unlocks.
 */
export async function rockyQuestionAllowed(riderAccountId: number, now = new Date()): Promise<{ allowed: true } | { allowed: false; nextFreeAt: string }> {
  const access = await riderAccess(riderAccountId);
  if (access.full) return { allowed: true };
  const since = new Date(now.getTime() - DAY_MS);
  const [row] = await db.select({ n: count(), first: min(riderAiUsageTable.createdAt) }).from(riderAiUsageTable)
    .where(and(eq(riderAiUsageTable.riderAccountId, riderAccountId), gte(riderAiUsageTable.createdAt, since)));
  if (Number(row?.n ?? 0) < FREE_ROCKY_QUESTIONS_PER_DAY) return { allowed: true };
  const first = row?.first ? new Date(row.first) : now;
  return { allowed: false, nextFreeAt: new Date(first.getTime() + DAY_MS).toISOString() };
}

/** Record one answered Rocky question (always, so usage and AI cost can be watched). */
export async function recordRockyQuestion(riderAccountId: number, kind: RockyKind): Promise<void> {
  await db.insert(riderAiUsageTable).values({ riderAccountId, kind });
}

export function rockyLimitBody(nextFreeAt: string) {
  return premiumRequired("More than one Rocky question a day", { nextFreeAt });
}

// ── History ─────────────────────────────────────────────────────────────────

/** Practice sessions a free rider still sees once Premium is on: the last 24 hours. */
export function isRecentPractice(startedAt: string | null, now = new Date()): boolean {
  return !!startedAt && now.getTime() - Date.parse(startedAt) < DAY_MS;
}

// ── Live stream tickets ─────────────────────────────────────────────────────
//
// Once Premium is on, the video relay only accepts viewers carrying a ticket
// from GET /video/watch-access/:eventId, which checks the rider's Premium.
// While Premium is off, no ticket is needed.

const ticketSecret = process.env.SESSION_SECRET || randomBytes(32).toString("hex");
const WATCH_TICKET_TTL_MS = 5 * 60_000;

function sign(payload: string): string {
  return createHmac("sha256", ticketSecret).update(`video-watch:${payload}`).digest("base64url");
}

export function createWatchTicket(eventId: number, riderAccountId: number, now = Date.now()): string {
  const payload = `${eventId}.${riderAccountId}.${now + WATCH_TICKET_TTL_MS}`;
  return `${payload}.${sign(payload)}`;
}

export function verifyWatchTicket(ticket: string | null | undefined, eventId: number, now = Date.now()): boolean {
  if (!ticket) return false;
  const parts = ticket.split(".");
  if (parts.length !== 4) return false;
  const [ev, acct, exp, sig] = parts;
  const expected = sign(`${ev}.${acct}.${exp}`);
  const a = Buffer.from(sig), b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return false;
  return Number(ev) === eventId && Number(exp) > now;
}
