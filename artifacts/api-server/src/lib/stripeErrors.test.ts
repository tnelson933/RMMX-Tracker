import assert from "node:assert/strict";
import test from "node:test";
import { isStripeAccountUnreachable, organizerCardError, ORGANIZER_STRIPE_UNREACHABLE, riderCardError } from "./stripeErrors";

test("a club Stripe account RM Roost can't use is recognized", () => {
  assert.equal(isStripeAccountUnreachable({ type: "StripeInvalidRequestError", code: "resource_missing", message: "No such destination: 'acct_1ABC'" }), true);
  assert.equal(isStripeAccountUnreachable({ message: "No such account: 'acct_1ABC'" }), true);
  assert.equal(isStripeAccountUnreachable({ type: "StripePermissionError", message: "The provided key does not have access to account 'acct_1ABC'" }), true);
  assert.equal(isStripeAccountUnreachable({ type: "StripeCardError", message: "Your card was declined." }), false);
  assert.equal(isStripeAccountUnreachable(null), false);
});

test("organizers are told how to fix it; raw Stripe text never shows", () => {
  const msg = organizerCardError({ message: "No such destination: 'acct_1ABC'" });
  assert.equal(msg, ORGANIZER_STRIPE_UNREACHABLE);
  assert.ok(!msg.includes("acct_"));
  assert.match(organizerCardError(new Error("socket hang up")), /Try again/);
});

test("riders are pointed to the organizer", () => {
  assert.match(riderCardError({ message: "No such destination: 'acct_1'" }, "x"), /contact the event organizer/);
  assert.equal(riderCardError(new Error("boom"), "fallback"), "fallback");
});
