import assert from "node:assert/strict";
import test from "node:test";
import { periodEnd, premiumUntilFor, webProduct } from "./webPremium";

const sub = (status: string, end: number, onItem = false) => ({
  status, ...(onItem ? {} : { current_period_end: end }), items: { data: [onItem ? { current_period_end: end } : {}] },
}) as any;

test("website plans match the app's prices", () => {
  assert.deepEqual([webProduct("individualMonthly")?.cents, webProduct("individualYearly")?.cents, webProduct("familyYearly")?.cents], [499, 4999, 7999]);
  assert.equal(webProduct("familyYearly")?.plan, "family");
  assert.equal(webProduct("lifetime"), null);
});

test("Premium runs to the paid period's end; a failed renewal gets a short grace; cancelled ends", () => {
  const now = new Date("2026-11-18T12:00:00Z");
  const end = Date.parse("2026-12-18T12:00:00Z") / 1000;
  assert.equal(periodEnd(sub("active", end))?.toISOString(), "2026-12-18T12:00:00.000Z");
  assert.equal(periodEnd(sub("active", end, true))?.toISOString(), "2026-12-18T12:00:00.000Z");
  assert.equal(premiumUntilFor(sub("active", end), now)?.toISOString(), "2026-12-18T12:00:00.000Z");
  const lapsed = Date.parse("2026-11-17T12:00:00Z") / 1000;
  assert.equal(premiumUntilFor(sub("past_due", lapsed), now)?.toISOString(), "2026-11-19T12:00:00.000Z");
  assert.equal(premiumUntilFor(sub("canceled", end), now), null);
  assert.equal(premiumUntilFor(sub("unpaid", lapsed), now), null);
});
