import { db, riderAccountsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { logger } from "./logger";
import { PLAN_RIDERS, enforcePhoneLimit, type PremiumPlan } from "./premium";

/**
 * RM Roost Premium is sold only as Apple App Store and Google Play in-app
 * subscriptions, through RevenueCat (one SDK for both stores, which also
 * checks every receipt with Apple/Google). The rider app logs into RevenueCat
 * with the RM Roost rider account id, so a purchase belongs to that account.
 *
 * The server never trusts the app about a purchase: RevenueCat's webhook (and
 * a sync the app asks for right after buying) read the subscriber from
 * RevenueCat's API with the secret key, and only that sets premium_until,
 * premium_plan and premium_source. Whether Premium is enforced at all is still
 * the super admin switch (lib/premium.ts); while it's off, buying changes
 * nothing anyone can see.
 *
 * Set on the API server (Railway variables):
 *   REVENUECAT_SECRET_KEY      RevenueCat secret API key (v1, "sk_…")
 *   REVENUECAT_WEBHOOK_AUTH    the Authorization header value set on the webhook
 */

/** Store product ids → plan. Google's ids may carry a base plan ("id:base"). */
export const PREMIUM_PRODUCTS: Record<string, PremiumPlan> = {
  rmroost_premium_monthly: "individual",
  rmroost_premium_yearly: "individual",
  rmroost_family_yearly: "family",
};

export function planForProduct(productId: string | null | undefined): PremiumPlan | null {
  if (!productId) return null;
  return PREMIUM_PRODUCTS[productId.split(":")[0]] ?? null;
}

export type StoreName = "apple" | "google";

export function storeName(store: string | null | undefined): StoreName | null {
  if (store === "app_store" || store === "APP_STORE" || store === "mac_app_store" || store === "MAC_APP_STORE") return "apple";
  if (store === "play_store" || store === "PLAY_STORE") return "google";
  return null;
}

export interface StoreState {
  plan: PremiumPlan;
  expiresAt: Date;
  store: StoreName;
}

/** Of a subscriber's RevenueCat subscriptions, the one that runs longest (Family wins a tie). */
export function bestSubscription(subscriptions: Record<string, { expires_date?: string | null; store?: string; unsubscribe_detected_at?: string | null; refunded_at?: string | null }>, now = new Date()): StoreState | null {
  let best: StoreState | null = null;
  for (const [productId, sub] of Object.entries(subscriptions ?? {})) {
    const plan = planForProduct(productId);
    const store = storeName(sub.store);
    if (!plan || !store || !sub.expires_date || sub.refunded_at) continue;
    const expiresAt = new Date(sub.expires_date);
    if (Number.isNaN(expiresAt.getTime()) || expiresAt <= now) continue;
    const better = !best || expiresAt > best.expiresAt || (expiresAt.getTime() === best.expiresAt.getTime() && plan === "family");
    if (better) best = { plan, expiresAt, store };
  }
  return best;
}

/** Account id from RevenueCat's app user id (the rider app logs in with the account id). */
export function accountIdFromAppUser(appUserId: string | null | undefined): number | null {
  const n = Number(appUserId);
  return Number.isInteger(n) && n > 0 ? n : null;
}

/**
 * Save what the stores say. Admin grants are left alone unless a store
 * subscription is active (then it takes over); a lapsed store subscription
 * ends store-sourced Premium. Riders already picked stay, trimmed to the plan.
 */
export async function applyStoreState(riderAccountId: number, state: StoreState | null): Promise<void> {
  const [acct] = await db.select({ source: riderAccountsTable.premiumSource, riderIds: riderAccountsTable.premiumRiderIds, until: riderAccountsTable.premiumUntil })
    .from(riderAccountsTable).where(eq(riderAccountsTable.id, riderAccountId));
  if (!acct) return;
  if (state) {
    const riderIds = (acct.riderIds ?? []).slice(0, PLAN_RIDERS[state.plan]);
    await db.update(riderAccountsTable)
      .set({ premiumUntil: state.expiresAt, premiumPlan: state.plan, premiumSource: state.store, premiumRiderIds: riderIds })
      .where(eq(riderAccountsTable.id, riderAccountId));
    // Family → Individual allows fewer phones.
    await enforcePhoneLimit(riderAccountId).catch(() => {});
    return;
  }
  if (acct.source === "apple" || acct.source === "google") {
    // The store subscription ended (expired, refunded or cancelled and run out).
    await db.update(riderAccountsTable)
      .set({ premiumUntil: acct.until && acct.until < new Date() ? acct.until : new Date() })
      .where(eq(riderAccountsTable.id, riderAccountId));
    await enforcePhoneLimit(riderAccountId).catch(() => {});
  }
}

/** Ask RevenueCat for this account's subscriptions and save the result. False when not configured. */
export async function syncFromRevenueCat(riderAccountId: number): Promise<boolean> {
  const key = process.env.REVENUECAT_SECRET_KEY;
  if (!key) return false;
  const res = await fetch(`https://api.revenuecat.com/v1/subscribers/${encodeURIComponent(String(riderAccountId))}`, {
    headers: { Authorization: `Bearer ${key}`, Accept: "application/json" },
  });
  if (!res.ok) throw new Error(`RevenueCat ${res.status}`);
  const body = await res.json() as { subscriber?: { subscriptions?: Record<string, { expires_date?: string | null; store?: string; refunded_at?: string | null }> } };
  await applyStoreState(riderAccountId, bestSubscription(body.subscriber?.subscriptions ?? {}));
  return true;
}

/** RevenueCat webhook event: re-read the subscriber from RevenueCat (the source of truth). */
export async function handleRevenueCatEvent(event: { type?: string; app_user_id?: string; original_app_user_id?: string; aliases?: string[]; transferred_from?: string[]; transferred_to?: string[] }): Promise<"synced" | "ignored"> {
  const ids = [event.app_user_id, event.original_app_user_id, ...(event.aliases ?? []), ...(event.transferred_from ?? []), ...(event.transferred_to ?? [])].map(accountIdFromAppUser).filter((n): n is number => n != null);
  // Every account named in the event (a TRANSFER moves a purchase between two).
  const accountIds = [...new Set(ids)];
  if (accountIds.length === 0 || event.type === "TEST") return "ignored";
  for (const accountId of accountIds) await syncFromRevenueCat(accountId);
  logger.info({ riderAccountIds: accountIds, type: event.type }, "Store purchase event synced");
  return "synced";
}

/** Constant-time check of the webhook's Authorization header. */
export function webhookAuthorized(header: string | undefined): boolean {
  const expected = process.env.REVENUECAT_WEBHOOK_AUTH;
  if (!expected || !header) return false;
  const a = Buffer.from(header), b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}
