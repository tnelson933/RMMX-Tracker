import { Router } from "express";
import { db, usersTable, riderAccountsTable, riderAiUsageTable, ridersTable, platformSettingsTable } from "@workspace/db";
import { count, desc, eq, gt, gte, inArray, sql } from "drizzle-orm";
import { logger } from "../lib/logger";
import { PLAN_PHONES, PLAN_RIDERS, PREMIUM_ENFORCED_KEY, accountPremium, enforcePhoneLimit, enforcePhoneLimitEverywhere, premiumEnforced, premiumSummary, validPlan } from "../lib/premium";
import { validDeadline } from "../lib/stripePayments";
import { managedRiderIds } from "../lib/riderAccess";
import { requireRiderAuth } from "./rider-portal";
import { handleRevenueCatEvent, syncFromRevenueCat, webhookAuthorized } from "../lib/storePurchases";
import { createPremiumCheckout, premiumPortalUrl, refreshWebPremiumIfDue, syncCheckoutSession, webProduct, type WebProductKey } from "../lib/webPremium";
import { supportAppUrl as getAppUrl } from "../lib/supportTickets";

/**
 * RM Roost Premium (switched off by default: every rider gets everything).
 *
 * Super admins only (Admin → Clubs → RM Roost Premium): the on/off switch,
 * giving an account Premium (Individual: 1 rider, or Family: up to 4 riders)
 * for promotions or testing, and Rocky usage. Club organizers and staff are
 * refused: they can never give away Premium.
 *
 * Riders: GET /rider/premium and PUT /rider/premium/riders to pick which of
 * their rider profiles Premium unlocks (filling empty slots only).
 */
const router = Router();

async function superAdminId(req: any, res: any): Promise<number | null> {
  const userId = (req.session as any)?.userId;
  if (!userId) { res.status(401).json({ error: "You're signed out. Sign in again, then try once more." }); return null; }
  const [user] = await db.select({ role: usersTable.role }).from(usersTable).where(eq(usersTable.id, userId));
  if (user?.role !== "super_admin") { res.status(403).json({ error: "Only RM Roost admins can change Premium." }); return null; }
  return userId;
}

async function ridersByIds(ids: number[]) {
  if (ids.length === 0) return [];
  const rows = await db.select({ id: ridersTable.id, firstName: ridersTable.firstName, lastName: ridersTable.lastName })
    .from(ridersTable).where(inArray(ridersTable.id, ids));
  return rows.map(r => ({ id: r.id, name: `${r.firstName ?? ""} ${r.lastName ?? ""}`.trim() || `Rider ${r.id}` }));
}

router.get("/admin/premium", async (req, res) => {
  if (!(await superAdminId(req, res))) return;
  const now = new Date();
  const [accounts, [usage]] = await Promise.all([
    db.select({ email: riderAccountsTable.email, until: riderAccountsTable.premiumUntil, source: riderAccountsTable.premiumSource, plan: riderAccountsTable.premiumPlan, riderIds: riderAccountsTable.premiumRiderIds })
      .from(riderAccountsTable).where(gt(riderAccountsTable.premiumUntil, now))
      .orderBy(desc(riderAccountsTable.premiumUntil)).limit(100),
    db.select({ n: count() }).from(riderAiUsageTable).where(gte(riderAiUsageTable.createdAt, new Date(now.getTime() - 24 * 3600 * 1000))),
  ]);
  const names = new Map((await ridersByIds([...new Set(accounts.flatMap(a => a.riderIds ?? []))])).map(r => [r.id, r.name]));
  res.json({
    enforced: await premiumEnforced(),
    rockyQuestionsLast24h: Number(usage?.n ?? 0),
    accounts: accounts.map(a => ({
      email: a.email, until: a.until?.toISOString() ?? null, source: a.source, plan: validPlan(a.plan) ?? "individual",
      riders: (a.riderIds ?? []).map(id => names.get(id) ?? `Rider ${id}`),
    })),
  });
});

// GET /admin/premium/account?email= — the account's rider profiles, to pick who Premium covers.
router.get("/admin/premium/account", async (req, res) => {
  if (!(await superAdminId(req, res))) return;
  const email = String(req.query.email ?? "").trim().toLowerCase();
  if (!email) return res.status(400).json({ error: "Enter the rider account's email." });
  const [acct] = await db.select({ id: riderAccountsTable.id, email: riderAccountsTable.email })
    .from(riderAccountsTable).where(eq(sql`lower(${riderAccountsTable.email})`, email));
  if (!acct) return res.status(404).json({ error: `There's no rider account for ${email}.` });
  const p = await accountPremium(acct.id);
  return res.json({
    email: acct.email,
    riders: await ridersByIds(await managedRiderIds(acct)),
    premium: { active: p.active, plan: p.plan, riderIds: p.riderIds, until: p.until?.toISOString() ?? null },
  });
});

// PUT /admin/premium { enforced }: switch Premium on (gates apply) or off (everything free).
router.put("/admin/premium", async (req, res) => {
  const adminId = await superAdminId(req, res);
  if (!adminId) return;
  if (typeof req.body?.enforced !== "boolean") return res.status(400).json({ error: "Choose on or off." });
  const enforced = req.body.enforced as boolean;
  await db.insert(platformSettingsTable)
    .values({ key: PREMIUM_ENFORCED_KEY, value: enforced, updatedBy: adminId, updatedAt: new Date() })
    .onConflictDoUpdate({ target: platformSettingsTable.key, set: { value: sql`excluded.value`, updatedBy: adminId, updatedAt: new Date() } });
  // Switching on: accounts already signed in on more phones than their plan allows are trimmed now.
  const signedOut = enforced ? await enforcePhoneLimitEverywhere().catch(() => 0) : 0;
  logger.info({ adminId, enforced, signedOut }, "Rider Premium switched");
  return res.json({ enforced, phonesSignedOut: signedOut });
});

// PUT /admin/premium/grant { email, until: "YYYY-MM-DD" | null, plan, riderIds }:
// give (or remove, with until null) Premium for one rider account.
router.put("/admin/premium/grant", async (req, res) => {
  const adminId = await superAdminId(req, res);
  if (!adminId) return;
  const email = String(req.body?.email ?? "").trim().toLowerCase();
  if (!email) return res.status(400).json({ error: "Enter the rider account's email." });
  const [acct] = await db.select({ id: riderAccountsTable.id, email: riderAccountsTable.email })
    .from(riderAccountsTable).where(eq(sql`lower(${riderAccountsTable.email})`, email));
  if (!acct) return res.status(404).json({ error: `There's no rider account for ${email}.` });

  const raw = req.body?.until;
  if (raw === null || raw === "") {
    await db.update(riderAccountsTable).set({ premiumUntil: null, premiumSource: null, premiumPlan: null, premiumRiderIds: [] })
      .where(eq(riderAccountsTable.id, acct.id));
    await enforcePhoneLimit(acct.id).catch(() => {});
    logger.info({ adminId, riderAccountId: acct.id }, "Rider Premium removed by admin");
    return res.json({ email, until: null });
  }
  const day = validDeadline(raw);
  if (!day) return res.status(400).json({ error: "Pick the date Premium ends." });
  const plan = validPlan(req.body?.plan);
  if (!plan) return res.status(400).json({ error: "Choose Individual (1 rider) or Family (up to 4 riders)." });
  const wanted = Array.isArray(req.body?.riderIds) ? [...new Set((req.body.riderIds as unknown[]).map(Number).filter(Number.isInteger))] : [];
  if (wanted.length > PLAN_RIDERS[plan]) {
    return res.status(400).json({ error: plan === "individual" ? "Individual Premium covers 1 rider. Pick one, or choose Family." : "Family Premium covers up to 4 riders." });
  }
  const allowed = new Set(await managedRiderIds(acct));
  if (wanted.some(id => !allowed.has(id))) return res.status(400).json({ error: "Pick riders on this account." });
  // Premium runs to the end of the chosen day (UTC).
  const until = new Date(`${day}T23:59:59Z`);
  await db.update(riderAccountsTable)
    .set({ premiumUntil: until, premiumSource: "admin", premiumPlan: plan, premiumRiderIds: wanted })
    .where(eq(riderAccountsTable.id, acct.id));
  await enforcePhoneLimit(acct.id).catch(() => {});
  logger.info({ adminId, riderAccountId: acct.id, until, plan, riders: wanted.length }, "Rider Premium granted by admin");
  return res.json({ email, until: until.toISOString(), plan, riderIds: wanted });
});

// GET /rider/premium — this account's Premium: plan, riders covered, phones allowed.
router.get("/rider/premium", requireRiderAuth, async (req, res) => {
  const accountId = (req.session as any).riderAccountId as number;
  await refreshWebPremiumIfDue(accountId);
  const summary = await premiumSummary(accountId);
  return res.json({ ...summary, riders: await ridersByIds(summary.riderIds) });
});

// POST /rider/premium/sync — right after buying or restoring in the app: read
// this account's store subscriptions from RevenueCat and save them.
router.post("/rider/premium/sync", requireRiderAuth, async (req, res) => {
  const accountId = (req.session as any).riderAccountId as number;
  try {
    await syncFromRevenueCat(accountId);
  } catch (err) {
    req.log?.warn({ err, accountId }, "Premium sync failed");
    return res.status(502).json({ error: "Couldn't check your purchase with the app store. It can take a minute; pull down to refresh." });
  }
  const summary = await premiumSummary(accountId);
  return res.json({ ...summary, riders: await ridersByIds(summary.riderIds) });
});

// POST /rider/premium/checkout { product } — buy Premium on the website: a
// Stripe subscription on RM Roost's own Stripe account. Returns Stripe's page.
router.post("/rider/premium/checkout", requireRiderAuth, async (req, res) => {
  const accountId = (req.session as any).riderAccountId as number;
  const product = webProduct(req.body?.product);
  if (!product) return res.status(400).json({ error: "Choose a Premium plan." });
  if (!(await premiumEnforced())) return res.status(409).json({ error: "Every feature is free right now, so there's nothing to buy yet." });
  if ((await accountPremium(accountId)).active) {
    return res.status(409).json({ error: "This account already has Premium. To change plans, cancel the current one where you bought it, then choose the new plan when it ends." });
  }
  const [acct] = await db.select({ id: riderAccountsTable.id, email: riderAccountsTable.email }).from(riderAccountsTable).where(eq(riderAccountsTable.id, accountId));
  if (!acct) return res.status(401).json({ error: "You're signed out. Sign in again, then try once more." });
  try {
    return res.json({ url: await createPremiumCheckout(acct, req.body.product as WebProductKey, getAppUrl()) });
  } catch (err) {
    req.log?.error({ err: err instanceof Error ? err.message : String(err), accountId }, "Premium checkout failed");
    return res.status(502).json({ error: "Couldn't open the payment page. Try again in a minute." });
  }
});

// POST /rider/premium/web-sync { sessionId } — back from Stripe Checkout: save the new subscription now.
router.post("/rider/premium/web-sync", requireRiderAuth, async (req, res) => {
  const accountId = (req.session as any).riderAccountId as number;
  try {
    if (typeof req.body?.sessionId === "string") await syncCheckoutSession(accountId, req.body.sessionId);
    else await refreshWebPremiumIfDue(accountId);
  } catch (err) {
    req.log?.warn({ err: err instanceof Error ? err.message : String(err), accountId }, "Premium web sync failed");
  }
  const summary = await premiumSummary(accountId);
  return res.json({ ...summary, riders: await ridersByIds(summary.riderIds) });
});

// POST /rider/premium/portal — Stripe's page to update the card or cancel (website purchases).
router.post("/rider/premium/portal", requireRiderAuth, async (req, res) => {
  const accountId = (req.session as any).riderAccountId as number;
  try {
    const url = await premiumPortalUrl(accountId, getAppUrl());
    if (!url) return res.status(404).json({ error: "This Premium wasn't bought on the website. Manage it where you bought it." });
    return res.json({ url });
  } catch (err) {
    req.log?.error({ err: err instanceof Error ? err.message : String(err), accountId }, "Premium portal failed");
    return res.status(502).json({ error: "Couldn't open the subscription page. Try again in a minute, or contact RM Roost support." });
  }
});

// POST /store/revenuecat-webhook — RevenueCat tells us a subscription changed
// (bought, renewed, cancelled, expired, refunded). Checked by the shared
// Authorization header; the subscriber is then re-read from RevenueCat.
router.post("/store/revenuecat-webhook", async (req, res) => {
  if (!webhookAuthorized(req.headers.authorization as string | undefined)) return res.status(401).json({ error: "Not authorized" });
  try {
    const result = await handleRevenueCatEvent(req.body?.event ?? {});
    return res.json({ ok: true, result });
  } catch (err) {
    logger.error({ err }, "RevenueCat webhook failed");
    // A 5xx makes RevenueCat retry later.
    return res.status(500).json({ error: "Try again" });
  }
});

// PUT /rider/premium/riders { riderIds } — pick which of the account's riders
// Premium unlocks. Fills empty slots only (1 on Individual, 4 on Family);
// swapping a rider who already has it goes through RM Roost support.
router.put("/rider/premium/riders", requireRiderAuth, async (req, res) => {
  const accountId = (req.session as any).riderAccountId as number;
  const [acct] = await db.select({ id: riderAccountsTable.id, email: riderAccountsTable.email }).from(riderAccountsTable).where(eq(riderAccountsTable.id, accountId));
  if (!acct) return res.status(401).json({ error: "You're signed out. Sign in again, then try once more." });
  const p = await accountPremium(accountId);
  if (!p.active || !p.plan) return res.status(402).json({ error: "This account doesn't have Premium.", code: "premium_required" });
  const wanted = Array.isArray(req.body?.riderIds) ? [...new Set((req.body.riderIds as unknown[]).map(Number).filter(Number.isInteger))] : [];
  const slots = PLAN_RIDERS[p.plan];
  if (wanted.length === 0 || wanted.length > slots) {
    return res.status(400).json({ error: p.plan === "individual" ? "Individual Premium covers 1 rider. Pick one, or upgrade to Family for up to 4." : "Family Premium covers up to 4 riders." });
  }
  if (p.riderIds.some(id => !wanted.includes(id))) {
    return res.status(409).json({ error: "A rider who already has Premium can't be swapped here. Contact RM Roost support to change who it covers." });
  }
  const allowed = new Set(await managedRiderIds(acct));
  if (wanted.some(id => !allowed.has(id))) return res.status(400).json({ error: "Pick riders on your account." });
  await db.update(riderAccountsTable).set({ premiumRiderIds: wanted }).where(eq(riderAccountsTable.id, accountId));
  const summary = await premiumSummary(accountId);
  return res.json({ ...summary, riders: await ridersByIds(summary.riderIds), maxPhones: PLAN_PHONES[p.plan] });
});

export default router;
