import assert from "node:assert/strict";
import test from "node:test";
import { checkoutUiParams, paymentIntentAsPaid } from "./stripePayments";
import { checkStatesCode } from "./cardReaderInput";

test("embedded checkout stays in our page; hosted keeps the return URLs", () => {
  assert.deepEqual(checkoutUiParams(true, { success_url: "a", cancel_url: "b" }), { ui_mode: "embedded", redirect_on_completion: "never" });
  assert.deepEqual(checkoutUiParams(false, { success_url: "a", cancel_url: "b" }), { success_url: "a", cancel_url: "b" });
});

test("a card-reader payment reads like a paid checkout once it succeeds", () => {
  const pi = (status: string) => ({ id: "pi_1", status, amount: 2500, amount_received: status === "succeeded" ? 2500 : 0, metadata: { registrationId: "7", type: "transponder_rental" } }) as any;
  assert.deepEqual(paymentIntentAsPaid(pi("succeeded")), { id: "pi_1", payment_status: "paid", amount_total: 2500, metadata: { registrationId: "7", type: "transponder_rental" } });
  assert.equal(paymentIntentAsPaid(pi("requires_payment_method")).payment_status, "unpaid");
  assert.equal(paymentIntentAsPaid(pi("requires_payment_method")).amount_total, 2500);
});

test("reader location state codes", () => {
  assert.ok(checkStatesCode("ut"));
  assert.ok(!checkStatesCode("Utah"));
});

test("clubs on their own Stripe account are charged directly; older Express clubs by transfer", async () => {
  const { clubStripeOf, onClub, transferTo, browserAccount, onClubOrPlatform } = await import("./stripePayments");
  const own = clubStripeOf({ stripeAccountId: "acct_own", stripeDirectCharges: true })!;
  const express = clubStripeOf({ stripeAccountId: "acct_exp", stripeDirectCharges: false })!;
  assert.deepEqual(onClub(own), { stripeAccount: "acct_own" });
  assert.deepEqual(transferTo(own), {});
  assert.equal(browserAccount(own), "acct_own");
  assert.equal(onClub(express), undefined);
  assert.deepEqual(transferTo(express), { transfer_data: { destination: "acct_exp" } });
  assert.equal(browserAccount(express), null);
  assert.equal(clubStripeOf({ stripeAccountId: null, stripeDirectCharges: true }), null);

  // Lookups: the club's account first; payments from before the switch fall back to RM Roost's.
  const calls: Array<string | undefined> = [];
  const found = await onClubOrPlatform(own, async o => {
    calls.push(o?.stripeAccount);
    if (o?.stripeAccount) throw Object.assign(new Error("No such checkout.session"), { code: "resource_missing" });
    return "platform";
  });
  assert.equal(found, "platform");
  assert.deepEqual(calls, ["acct_own", undefined]);
  await assert.rejects(onClubOrPlatform(own, async () => { throw Object.assign(new Error("boom"), { code: "api_error" }); }), /boom/);
});
