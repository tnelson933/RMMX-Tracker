import assert from "node:assert/strict";
import test from "node:test";
import { accountIdFromAppUser, bestSubscription, planForProduct, storeName, webhookAuthorized } from "./storePurchases";

test("store products map to plans (Google base plans too)", () => {
  assert.equal(planForProduct("rmroost_premium_monthly"), "individual");
  assert.equal(planForProduct("rmroost_premium_yearly"), "individual");
  assert.equal(planForProduct("rmroost_family_yearly"), "family");
  assert.equal(planForProduct("rmroost_family_yearly:yearly"), "family");
  assert.equal(planForProduct("something_else"), null);
  assert.equal(storeName("app_store"), "apple");
  assert.equal(storeName("PLAY_STORE"), "google");
  assert.equal(storeName("stripe"), null);
});

test("the longest-running active subscription wins; expired and refunded ones don't count", () => {
  const now = new Date("2026-11-18T12:00:00Z");
  assert.equal(bestSubscription({}, now), null);
  assert.equal(bestSubscription({ rmroost_premium_monthly: { expires_date: "2026-11-01T00:00:00Z", store: "app_store" } }, now), null);
  assert.equal(bestSubscription({ rmroost_premium_yearly: { expires_date: "2027-11-01T00:00:00Z", store: "app_store", refunded_at: "2026-11-10T00:00:00Z" } }, now), null);
  const best = bestSubscription({
    rmroost_premium_monthly: { expires_date: "2026-12-18T00:00:00Z", store: "app_store" },
    "rmroost_family_yearly:yearly": { expires_date: "2027-11-18T00:00:00Z", store: "play_store" },
  }, now);
  assert.deepEqual(best, { plan: "family", expiresAt: new Date("2027-11-18T00:00:00Z"), store: "google" });
});

test("RevenueCat app user ids are rider account ids; the webhook needs the shared header", () => {
  assert.equal(accountIdFromAppUser("42"), 42);
  assert.equal(accountIdFromAppUser("$RCAnonymousID:abc"), null);
  const saved = process.env.REVENUECAT_WEBHOOK_AUTH;
  process.env.REVENUECAT_WEBHOOK_AUTH = "Bearer test-secret";
  assert.equal(webhookAuthorized("Bearer test-secret"), true);
  assert.equal(webhookAuthorized("Bearer wrong-secret"), false);
  assert.equal(webhookAuthorized(undefined), false);
  delete process.env.REVENUECAT_WEBHOOK_AUTH;
  assert.equal(webhookAuthorized("Bearer test-secret"), false);
  if (saved !== undefined) process.env.REVENUECAT_WEBHOOK_AUTH = saved;
});
