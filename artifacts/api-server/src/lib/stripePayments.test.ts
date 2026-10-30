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
