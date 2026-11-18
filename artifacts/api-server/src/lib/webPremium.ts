import type Stripe from "stripe";
import { db, riderAccountsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { getUncachableStripeClient } from "../stripeClient";
import { logger } from "./logger";
import { PLAN_RIDERS, enforcePhoneLimit, validPlan, type PremiumPlan } from "./premium";

/**
 * RM Roost Premium bought on the website: a Stripe subscription on RM Roost's
 * own Stripe account (not a club's). Premium belongs to the rider account, so
 * buying here unlocks the app too, and buying in the app (Apple / Google, see
 * storePurchases.ts) unlocks the website.
 *
 * Checkout uses inline prices, so no products need creating in Stripe. The
 * subscription's metadata carries the rider account and plan. Stripe is the
 * source of truth: the webhook, the return from checkout and a refresh when
 * the paid period runs out all re-read the subscription from Stripe.
 */

export const WEB_PRODUCTS = {
  individualMonthly: { plan: "individual" as PremiumPlan, cents: 499, interval: "month" as const, name: "RM Roost Premium (monthly)" },
  individualYearly: { plan: "individual" as PremiumPlan, cents: 4999, interval: "year" as const, name: "RM Roost Premium (yearly)" },
  familyYearly: { plan: "family" as PremiumPlan, cents: 7999, interval: "year" as const, name: "RM Roost Premium Family (yearly)" },
};
export type WebProductKey = keyof typeof WEB_PRODUCTS;

export function webProduct(key: unknown): (typeof WEB_PRODUCTS)[WebProductKey] | null {
  return typeof key === "string" && key in WEB_PRODUCTS ? WEB_PRODUCTS[key as WebProductKey] : null;
}

const PREMIUM_TYPE = "rider_premium";
/** Stripe retries a failed renewal for a while; keep Premium through a short grace. */
const GRACE_MS = 2 * 24 * 3600 * 1000;

/** When the paid period ends (the field moved to subscription items in newer Stripe API versions). */
export function periodEnd(sub: Stripe.Subscription): Date | null {
  const top = (sub as unknown as { current_period_end?: number }).current_period_end;
  const item = (sub.items?.data?.[0] as unknown as { current_period_end?: number } | undefined)?.current_period_end;
  const secs = top ?? item;
  return typeof secs === "number" ? new Date(secs * 1000) : null;
}

/** Premium runs while the subscription is active (or retrying a payment), to the period end. */
export function premiumUntilFor(sub: Stripe.Subscription, now = new Date()): Date | null {
  const end = periodEnd(sub);
  if (!end) return null;
  if (sub.status === "active" || sub.status === "trialing") return end > now ? end : null;
  if (sub.status === "past_due") { const g = new Date(end.getTime() + GRACE_MS); return g > now ? g : null; }
  return null;
}

/** Start a Stripe Checkout for a Premium subscription; returns the page to send the rider to. */
export async function createPremiumCheckout(account: { id: number; email: string }, key: WebProductKey, appUrl: string): Promise<string> {
  const stripe = await getUncachableStripeClient();
  const p = WEB_PRODUCTS[key];
  const [row] = await db.select({ customer: riderAccountsTable.premiumStripeCustomerId }).from(riderAccountsTable).where(eq(riderAccountsTable.id, account.id));
  const metadata = { type: PREMIUM_TYPE, riderAccountId: String(account.id), plan: p.plan, product: key };
  const session = await stripe.checkout.sessions.create({
    mode: "subscription",
    line_items: [{ quantity: 1, price_data: { currency: "usd", unit_amount: p.cents, recurring: { interval: p.interval }, product_data: { name: p.name } } }],
    ...(row?.customer ? { customer: row.customer } : { customer_email: account.email }),
    client_reference_id: String(account.id),
    metadata,
    subscription_data: { metadata },
    success_url: `${appUrl}/rider/premium?paid=1&session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${appUrl}/rider/premium`,
  });
  if (!session.url) throw new Error("Stripe returned no checkout page");
  return session.url;
}

/** Save what a Stripe subscription says for its rider account. */
export async function applyStripeSubscription(sub: Stripe.Subscription): Promise<number | null> {
  if (sub.metadata?.type !== PREMIUM_TYPE) return null;
  const accountId = Number(sub.metadata.riderAccountId);
  const plan = validPlan(sub.metadata.plan);
  if (!Number.isInteger(accountId) || !plan) return null;
  const [acct] = await db.select({ source: riderAccountsTable.premiumSource, riderIds: riderAccountsTable.premiumRiderIds, subId: riderAccountsTable.premiumStripeSubscriptionId })
    .from(riderAccountsTable).where(eq(riderAccountsTable.id, accountId));
  if (!acct) return null;
  // An older, replaced subscription must not end a newer one.
  if (acct.subId && acct.subId !== sub.id && sub.status !== "active" && sub.status !== "trialing") return accountId;
  const until = premiumUntilFor(sub);
  const customer = typeof sub.customer === "string" ? sub.customer : sub.customer?.id ?? null;
  if (until) {
    await db.update(riderAccountsTable).set({
      premiumUntil: until, premiumPlan: plan, premiumSource: "stripe",
      premiumRiderIds: (acct.riderIds ?? []).slice(0, PLAN_RIDERS[plan]),
      premiumStripeCustomerId: customer, premiumStripeSubscriptionId: sub.id,
    }).where(eq(riderAccountsTable.id, accountId));
  } else if (acct.source === "stripe") {
    // Cancelled and run out, or unpaid: website-bought Premium ends now.
    await db.update(riderAccountsTable).set({ premiumUntil: new Date(), premiumStripeCustomerId: customer })
      .where(eq(riderAccountsTable.id, accountId));
  }
  await enforcePhoneLimit(accountId).catch(() => {});
  return accountId;
}

/** After returning from checkout: read the session's subscription and save it (only the buyer's own). */
export async function syncCheckoutSession(accountId: number, sessionId: string): Promise<boolean> {
  if (!/^cs_[A-Za-z0-9_]+$/.test(sessionId)) return false;
  const stripe = await getUncachableStripeClient();
  const session = await stripe.checkout.sessions.retrieve(sessionId, { expand: ["subscription"] });
  if (session.metadata?.type !== PREMIUM_TYPE || session.metadata.riderAccountId !== String(accountId)) return false;
  const sub = session.subscription as Stripe.Subscription | null;
  if (!sub || typeof sub === "string") return false;
  await applyStripeSubscription(sub);
  return true;
}

/**
 * Website-bought Premium whose paid period has run out: ask Stripe whether it
 * renewed (covers a missed webhook). Cheap: one DB read unless it's due.
 */
export async function refreshWebPremiumIfDue(accountId: number): Promise<void> {
  const [acct] = await db.select({ source: riderAccountsTable.premiumSource, until: riderAccountsTable.premiumUntil, subId: riderAccountsTable.premiumStripeSubscriptionId })
    .from(riderAccountsTable).where(eq(riderAccountsTable.id, accountId));
  if (!acct || acct.source !== "stripe" || !acct.subId) return;
  // Checked from an hour before the period ends, and at most for a month after it.
  const until = acct.until?.getTime() ?? 0;
  if (until - Date.now() > 3600_000 || Date.now() - until > 31 * 24 * 3600_000) return;
  try {
    const stripe = await getUncachableStripeClient();
    await applyStripeSubscription(await stripe.subscriptions.retrieve(acct.subId));
  } catch (err) {
    logger.warn({ err: err instanceof Error ? err.message : String(err), accountId }, "Couldn't refresh website Premium from Stripe");
  }
}

/** Stripe's page where the rider updates their card or cancels. */
export async function premiumPortalUrl(accountId: number, appUrl: string): Promise<string | null> {
  const [acct] = await db.select({ customer: riderAccountsTable.premiumStripeCustomerId }).from(riderAccountsTable).where(eq(riderAccountsTable.id, accountId));
  if (!acct?.customer) return null;
  const stripe = await getUncachableStripeClient();
  const portal = await stripe.billingPortal.sessions.create({ customer: acct.customer, return_url: `${appUrl}/rider/premium` });
  return portal.url;
}

/** Stripe webhook events about Premium subscriptions (others are ignored). */
export async function handlePremiumStripeEvent(event: { type?: string; data?: { object?: { id?: string; object?: string; subscription?: string | null; mode?: string; metadata?: Record<string, string> | null } } }): Promise<void> {
  const obj = event.data?.object;
  if (!event.type || !obj?.id) return;
  const stripe = await getUncachableStripeClient();
  let subId: string | null = null;
  if (event.type.startsWith("customer.subscription.") && obj.object === "subscription") subId = obj.id;
  else if (event.type === "checkout.session.completed" && obj.mode === "subscription" && obj.metadata?.type === PREMIUM_TYPE) subId = obj.subscription ?? null;
  else if ((event.type === "invoice.paid" || event.type === "invoice.payment_failed") && obj.subscription) subId = obj.subscription;
  if (!subId) return;
  // Re-read from Stripe rather than trusting the payload.
  const accountId = await applyStripeSubscription(await stripe.subscriptions.retrieve(subId));
  if (accountId) logger.info({ riderAccountId: accountId, type: event.type }, "Website Premium subscription synced");
}
