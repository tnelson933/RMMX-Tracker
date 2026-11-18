import { db, riderAccountsTable, riderAiUsageTable, riderStreamUsageTable, platformSettingsTable, riderMobileTokensTable, riderMobileSignoutsTable } from "@workspace/db";
import { and, count, eq, gt, gte, lt, min, sql } from "drizzle-orm";
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * RM Roost Premium for riders ($4.99/month or $49.99/year): past stats and
 * history, unlimited Rocky (coach and mechanic), and watching live streams.
 *
 * SET UP, SWITCHED OFF. Every gate below asks `premiumEnforced()` first, and
 * while that is false (the default: no platform_settings row) every rider gets
 * everything, exactly as before. A super admin turns it on in Admin → Clubs.
 * Riders buy it in the app (Apple / Google in-app purchase, storePurchases.ts)
 * or on the website (Stripe subscription, webPremium.ts). Either way Premium
 * belongs to the rider account, so it works in both places. A super admin can
 * also grant it to an account by email.
 *
 * Plans: Individual ($4.99/month or $49.99/year) unlocks Premium for ONE rider
 * profile the buyer picks, and lets 1 phone be signed in. Family ($79.99/year)
 * unlocks up to 4 rider profiles and lets up to 4 phones be signed in. Signing
 * in on one more phone signs out the oldest. Account-wide features (live
 * streams, Rocky without a rider) unlock with either plan.
 *
 * Free riders keep everything for race day: today's live laps and standings,
 * registration, check-in, 1 Rocky question every 72 hours, and 30 minutes of
 * live streaming in total (it never resets). There is no free trial: Premium is paid.
 */

export const PREMIUM_ENFORCED_KEY = "premium_enforced";
/** Rocky questions a free rider gets per rolling window once Premium is on: 1 every 72 hours. */
export const FREE_ROCKY_QUESTIONS = 1;
export const FREE_ROCKY_WINDOW_HOURS = 72;
const ROCKY_WINDOW_MS = FREE_ROCKY_WINDOW_HOURS * 3600 * 1000;
const DAY_MS = 24 * 3600 * 1000;

export async function premiumEnforced(): Promise<boolean> {
  const [row] = await db.select({ value: platformSettingsTable.value }).from(platformSettingsTable)
    .where(eq(platformSettingsTable.key, PREMIUM_ENFORCED_KEY));
  return row?.value === true;
}

export function premiumActive(premiumUntil: Date | null | undefined, now = new Date()): boolean {
  return !!premiumUntil && premiumUntil.getTime() > now.getTime();
}

export type PremiumPlan = "individual" | "family";
/** Rider profiles each plan unlocks. */
export const PLAN_RIDERS: Record<PremiumPlan, number> = { individual: 1, family: 4 };
/** Phones that can be signed in at once: 1 without Premium or on Individual, 4 on Family. */
export const PLAN_PHONES: Record<PremiumPlan | "none", number> = { none: 1, individual: 1, family: 4 };

export function validPlan(v: unknown): PremiumPlan | null {
  return v === "individual" || v === "family" ? v : null;
}

export interface AccountPremium {
  /** The account has paid or granted Premium right now. */
  active: boolean;
  plan: PremiumPlan | null;
  /** Rider profiles Premium unlocks (empty until the buyer picks). */
  riderIds: number[];
  until: Date | null;
  /** "apple" | "google" | "stripe" (website) | "admin". */
  source: string | null;
}

export async function accountPremium(riderAccountId: number | null | undefined): Promise<AccountPremium> {
  if (!riderAccountId) return { active: false, plan: null, riderIds: [], until: null, source: null };
  const [acct] = await db.select({ until: riderAccountsTable.premiumUntil, plan: riderAccountsTable.premiumPlan, riderIds: riderAccountsTable.premiumRiderIds, source: riderAccountsTable.premiumSource })
    .from(riderAccountsTable).where(eq(riderAccountsTable.id, riderAccountId));
  const active = premiumActive(acct?.until);
  const plan = validPlan(acct?.plan) ?? (active ? "individual" : null);
  const riderIds = Array.isArray(acct?.riderIds) ? acct!.riderIds.filter(n => Number.isInteger(n)).slice(0, plan ? PLAN_RIDERS[plan] : 0) : [];
  return { active, plan: active ? plan : null, riderIds: active ? riderIds : [], until: acct?.until ?? null, source: active ? acct?.source ?? null : null };
}

export interface RiderAccess {
  /** Premium is switched on for RM Roost (false: everything is free). */
  enforced: boolean;
  /** This account has paid or granted Premium right now (any plan). */
  premium: boolean;
  premiumUntil: string | null;
  /**
   * True when Premium features are unlocked here: Premium is off, or the account
   * has it and (for a rider-specific feature) that rider is one of its Premium riders.
   */
  full: boolean;
}

/**
 * Access for an account, and for one of its rider profiles when the feature is
 * about a rider (history, stats, that rider's Rocky). Without riderId it's an
 * account-wide feature (live streams), unlocked by either plan.
 */
export async function riderAccess(riderAccountId: number | null | undefined, riderId?: number | null): Promise<RiderAccess> {
  const enforced = await premiumEnforced();
  const p = await accountPremium(riderAccountId);
  const coversRider = riderId == null ? p.active : p.active && p.riderIds.includes(riderId);
  return { enforced, premium: p.active, premiumUntil: p.until?.toISOString() ?? null, full: !enforced || coversRider };
}

/** What the rider app and website show about Premium (from /rider/auth/me and /rider/auth/mobile-me). */
export async function premiumSummary(riderAccountId: number) {
  const enforced = await premiumEnforced();
  const p = await accountPremium(riderAccountId);
  const plan = p.plan;
  return {
    enforced,
    active: p.active,
    until: p.until?.toISOString() ?? null,
    plan,
    /** Where it was bought, so each client shows the right place to manage it. */
    source: p.source,
    riderIds: p.riderIds,
    riderSlots: plan ? PLAN_RIDERS[plan] : 0,
    /** Premium is paid for but no rider (or not every slot) is picked yet. */
    needsRiderChoice: p.active && p.riderIds.length === 0,
    maxPhones: PLAN_PHONES[plan ?? "none"],
    freeRockyQuestions: FREE_ROCKY_QUESTIONS,
    freeRockyWindowHours: FREE_ROCKY_WINDOW_HOURS,
  };
}

// ── Phones signed in ────────────────────────────────────────────────────────

export const SIGNED_IN_ELSEWHERE = "signed_in_elsewhere";

export function phoneLimitMessage(maxPhones: number): string {
  return maxPhones > 1
    ? `You were signed out because your account signed in on another phone. RM Roost Family lets ${maxPhones} phones use one account at a time.`
    : "You were signed out because your account signed in on another phone. One phone can use an account at a time; the Family plan allows 4.";
}

/** Which of an account's tokens stay signed in: `keepToken` first, then the most recently used phones, up to `max`. */
export function phonesToKeep(tokens: Array<{ token: string; lastUsedAt: Date | null }>, max: number, keepToken: string | null): Set<string> {
  // Only tokens the app has used are phones (website sign-ins make tokens they never use).
  const used = tokens.filter(t => t.lastUsedAt != null && t.token !== keepToken)
    .sort((a, b) => b.lastUsedAt!.getTime() - a.lastUsedAt!.getTime());
  const keep = new Set<string>(keepToken ? [keepToken] : []);
  for (const t of used) { if (keep.size >= max) break; keep.add(t.token); }
  return keep;
}

/**
 * Once Premium is on, keep only as many phones signed in as the plan allows
 * (1, or 4 on Family) and sign out the rest, remembering why. Called after a
 * phone signs in (`keepToken` = that phone, which always stays), when a plan
 * ends, and for every account when Premium is switched on. Tokens the app
 * never used (website sign-ins) are just removed: they aren't phones. While
 * Premium is off nothing is signed out.
 */
export async function enforcePhoneLimit(riderAccountId: number, keepToken: string | null = null): Promise<number> {
  if (!(await premiumEnforced())) return 0;
  const p = await accountPremium(riderAccountId);
  const max = PLAN_PHONES[p.plan ?? "none"];
  const tokens = await db.select({ token: riderMobileTokensTable.token, lastUsedAt: riderMobileTokensTable.lastUsedAt, createdAt: riderMobileTokensTable.createdAt })
    .from(riderMobileTokensTable).where(eq(riderMobileTokensTable.riderAccountId, riderAccountId));
  const keep = phonesToKeep(tokens, max, keepToken);
  // A token made in the last few minutes may be a phone that hasn't made its first request yet.
  const fresh = Date.now() - 5 * 60_000;
  const unused = tokens.filter(t => !keep.has(t.token) && t.lastUsedAt == null);
  for (const t of unused) {
    if (t.createdAt.getTime() < fresh) await db.delete(riderMobileTokensTable).where(eq(riderMobileTokensTable.token, t.token));
  }
  const drop = tokens.filter(t => !keep.has(t.token) && t.lastUsedAt != null).map(t => t.token);
  for (const token of drop) {
    await db.insert(riderMobileSignoutsTable).values({ token, riderAccountId, reason: SIGNED_IN_ELSEWHERE }).onConflictDoNothing();
    await db.delete(riderMobileTokensTable).where(eq(riderMobileTokensTable.token, token));
  }
  // Old sign-out notes aren't needed after a month.
  await db.delete(riderMobileSignoutsTable).where(lt(riderMobileSignoutsTable.createdAt, new Date(Date.now() - 30 * DAY_MS))).catch(() => {});
  return drop.length;
}

/** When Premium is switched on: apply the phone limit to every account signed in on more than one phone. */
export async function enforcePhoneLimitEverywhere(): Promise<number> {
  const rows = await db.select({ id: riderMobileTokensTable.riderAccountId, n: count() }).from(riderMobileTokensTable)
    .groupBy(riderMobileTokensTable.riderAccountId).having(gt(count(), 1));
  let signedOut = 0;
  for (const r of rows) signedOut += await enforcePhoneLimit(r.id).catch(() => 0);
  return signedOut;
}

/** Note that the app used this token (at most once an hour). */
export function touchMobileToken(row: { token: string; lastUsedAt: Date | null }): void {
  if (row.lastUsedAt && Date.now() - row.lastUsedAt.getTime() < 3600_000) return;
  void db.update(riderMobileTokensTable).set({ lastUsedAt: new Date() }).where(eq(riderMobileTokensTable.token, row.token)).catch(() => {});
}

/** Why a phone's token stopped working, when it was signed out by the phone limit. */
export async function signedOutElsewhere(token: string): Promise<{ error: string; code: string } | null> {
  const [row] = await db.select({ accountId: riderMobileSignoutsTable.riderAccountId }).from(riderMobileSignoutsTable)
    .where(eq(riderMobileSignoutsTable.token, token));
  if (!row) return null;
  const p = await accountPremium(row.accountId);
  return { error: phoneLimitMessage(PLAN_PHONES[p.plan ?? "none"]), code: SIGNED_IN_ELSEWHERE };
}

/** The error body clients show when a Premium feature is locked (HTTP 402). */
export function premiumRequired(feature: string, extra: Record<string, unknown> = {}) {
  return { error: `${feature} is part of RM Roost Premium.`, code: "premium_required", ...extra };
}

// ── Rocky questions ─────────────────────────────────────────────────────────

export type RockyKind = "mechanic_chat" | "training_plan" | "maintenance_plan";

/**
 * Whether the rider may ask Rocky now. Free riders (only once Premium is on)
 * get FREE_ROCKY_QUESTIONS in any rolling 72 hours; `nextFreeAt` says
 * when the next one unlocks.
 */
export async function rockyQuestionAllowed(riderAccountId: number, riderId?: number | null, now = new Date()): Promise<{ allowed: true } | { allowed: false; nextFreeAt: string }> {
  // About a rider (their bike, their training): unlimited when that rider has Premium.
  const access = await riderAccess(riderAccountId, riderId);
  if (access.full) return { allowed: true };
  const since = new Date(now.getTime() - ROCKY_WINDOW_MS);
  const [row] = await db.select({ n: count(), first: min(riderAiUsageTable.createdAt) }).from(riderAiUsageTable)
    .where(and(eq(riderAiUsageTable.riderAccountId, riderAccountId), gte(riderAiUsageTable.createdAt, since)));
  if (Number(row?.n ?? 0) < FREE_ROCKY_QUESTIONS) return { allowed: true };
  const first = row?.first ? new Date(row.first) : now;
  return { allowed: false, nextFreeAt: new Date(first.getTime() + ROCKY_WINDOW_MS).toISOString() };
}

/** Record one answered Rocky question (always, so usage and AI cost can be watched). */
export async function recordRockyQuestion(riderAccountId: number, kind: RockyKind): Promise<void> {
  await db.insert(riderAiUsageTable).values({ riderAccountId, kind });
}

export function rockyLimitBody(nextFreeAt: string) {
  return premiumRequired("More than one Rocky question every 72 hours", { nextFreeAt });
}

// ── History ─────────────────────────────────────────────────────────────────

/** Practice sessions a free rider still sees once Premium is on: the last 24 hours. */
export function isRecentPractice(startedAt: string | null, now = new Date()): boolean {
  return !!startedAt && now.getTime() - Date.parse(startedAt) < DAY_MS;
}

// ── Live streams: tickets and the free hour ─────────────────────────────────
//
// Once Premium is on, the video relay only accepts viewers carrying a ticket
// from GET /video/watch-access/:eventId. A ticket says who is watching and
// until when: Premium riders and the event's own club staff without limit, a
// free rider until their 30 free minutes (in total, across all events) run out
// (the relay then tells the player and closes). While Premium is off, no ticket is needed.

/** Free live-stream time per rider account, in total across all events and never reset, once Premium is on. */
export const FREE_STREAM_SECONDS = 30 * 60;
/** "No limit" for Premium riders and club staff. */
export const NO_LIMIT = 8_640_000_000_000_000;

const ticketSecret = process.env.SESSION_SECRET || randomBytes(32).toString("hex");
const WATCH_TICKET_TTL_MS = 5 * 60_000;

function sign(payload: string): string {
  return createHmac("sha256", ticketSecret).update(`video-watch:${payload}`).digest("base64url");
}

export interface WatchGrant {
  riderAccountId: number;
  /** Epoch ms when this viewer must stop (NO_LIMIT for Premium and staff). */
  allowUntil: number;
  /** Watching on the free minutes: the relay records the time watched. */
  free: boolean;
}

export function createWatchTicket(eventId: number, grant: WatchGrant, now = Date.now()): string {
  const payload = `${eventId}.${grant.riderAccountId}.${now + WATCH_TICKET_TTL_MS}.${grant.allowUntil}.${grant.free ? 1 : 0}`;
  return `${payload}.${sign(payload)}`;
}

/** The grant in a valid, unexpired ticket for this event, or null. */
export function verifyWatchTicket(ticket: string | null | undefined, eventId: number, now = Date.now()): WatchGrant | null {
  if (!ticket) return null;
  const parts = ticket.split(".");
  if (parts.length !== 6) return null;
  const [ev, acct, exp, until, free, sig] = parts;
  const expected = sign(`${ev}.${acct}.${exp}.${until}.${free}`);
  const a = Buffer.from(sig), b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  if (Number(ev) !== eventId || Number(exp) <= now) return null;
  return { riderAccountId: Number(acct), allowUntil: Number(until), free: free === "1" };
}

/** Free stream seconds this rider has left, in total across every event (never resets). */
export async function freeStreamSecondsLeft(riderAccountId: number): Promise<number> {
  const [row] = await db.select({ seconds: sql<number>`coalesce(sum(${riderStreamUsageTable.seconds}), 0)` })
    .from(riderStreamUsageTable).where(eq(riderStreamUsageTable.riderAccountId, riderAccountId));
  return Math.max(0, FREE_STREAM_SECONDS - Number(row?.seconds ?? 0));
}

/** Add watched seconds to a rider's free time (kept per event, counted in total). */
export async function recordStreamSeconds(riderAccountId: number, eventId: number, seconds: number): Promise<void> {
  const s = Math.max(0, Math.round(seconds));
  if (!riderAccountId || s === 0) return;
  await db.insert(riderStreamUsageTable).values({ riderAccountId, eventId, seconds: s })
    .onConflictDoUpdate({
      target: [riderStreamUsageTable.riderAccountId, riderStreamUsageTable.eventId],
      set: { seconds: sql`${riderStreamUsageTable.seconds} + ${s}`, updatedAt: new Date() },
    });
}
