import assert from "node:assert/strict";
import test from "node:test";
import { applicationFee, deadlinePassed, validDeadline, checkoutUiParams, paymentIntentAsPaid, registrationFeeFor, serviceFeeLineItem, validFeeCents } from "./stripePayments";
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

test("service fee: one per paid entry, added on top of the entry", () => {
  assert.equal(registrationFeeFor(1, 100), 100);
  assert.equal(registrationFeeFor(3, 50), 150);
  assert.equal(registrationFeeFor(0, 100), 0);       // no paid entry (add-ons only, comp)
  assert.equal(registrationFeeFor(2, 0), 0);         // fee off
  assert.deepEqual(serviceFeeLineItem(125, 2), {
    price_data: { currency: "usd", product_data: { name: "Service fee" }, unit_amount: 125 }, quantity: 2,
  });
  assert.deepEqual(applicationFee(0), {});
  assert.deepEqual(applicationFee(75), { application_fee_amount: 75 });
});

test("registration fee settings accept whole cents from $0 to $20 only", () => {
  assert.equal(validFeeCents(50), 50);
  assert.equal(validFeeCents("100"), 100);
  assert.equal(validFeeCents(0), 0);
  assert.equal(validFeeCents(2001), null);
  assert.equal(validFeeCents(-1), null);
  assert.equal(validFeeCents(1.5), null);
  assert.equal(validFeeCents(""), null);
  assert.equal(validFeeCents(null), null);
});

test("switch deadline: the deadline day still counts; the day after is overdue", () => {
  assert.equal(deadlinePassed(null), false);
  assert.equal(deadlinePassed("2026-12-31", new Date("2026-12-31T23:00:00Z")), false);
  assert.equal(deadlinePassed("2026-12-31", new Date("2027-01-01T00:00:01Z")), true);
  assert.equal(validDeadline("2026-12-31"), "2026-12-31");
  assert.equal(validDeadline("12/31/2026"), null);
  assert.equal(validDeadline(""), null);
});
