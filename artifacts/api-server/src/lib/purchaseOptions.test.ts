import assert from "node:assert/strict";
import test from "node:test";
import { resolvePurchaseOptions } from "./purchaseOptions";

const configured = [
  { id: "pit", name: "Pit pass", amount: 15 },
  { id: "camp", name: "Camping", amount: 25, categoryId: 3 },
];

test("prices come from the event, not the client", () => {
  const out = resolvePurchaseOptions([{ id: "pit", name: "Pit pass", amount: -9999 }, { id: "camp", amount: 0 }], configured);
  assert.deepEqual(out.map(o => [o.id, o.amount]), [["pit", 15], ["camp", 25]]);
  assert.equal(out[1].categoryId, 3);
});

test("accepts plain ids and drops unknown or duplicate options", () => {
  const out = resolvePurchaseOptions(["camp", "camp", { id: "nope", amount: 1 }, null, 42], configured);
  assert.deepEqual(out.map(o => o.id), ["camp"]);
});

test("non-array input yields no options", () => {
  assert.deepEqual(resolvePurchaseOptions("pit", configured), []);
  assert.deepEqual(resolvePurchaseOptions(undefined, configured), []);
  assert.deepEqual(resolvePurchaseOptions(["pit"], null), []);
});

test("saving keeps only id, name and amount and fixes the RM TrackR", async () => {
  const { normalizeEventPurchaseOptions } = await import("./rmTrackr");
  const out = normalizeEventPurchaseOptions([
    { id: "pit", name: " Pit pass ", amount: "15", categoryId: 3, extra: "x" },
    { id: "rm-trackr", name: "Cheap", amount: 1, categoryId: 2 },
    { id: "rm-trackr", name: "Again", amount: 1 },
    { name: "No id", amount: 5 },
  ]);
  assert.deepEqual(out[0], { id: "pit", name: "Pit pass", amount: 15 });
  assert.deepEqual(out[1], { id: "rm-trackr", name: "RM TrackR Transponder", amount: 40 });
  assert.equal(out.length, 3);
  assert.ok(out[2].id.length > 0);
  assert.equal(out[2].name, "No id");
  // The club's Sell Items price, or the price the event already had.
  assert.equal(normalizeEventPurchaseOptions([{ id: "rm-trackr", amount: 1 }], 55)[0].amount, 55);
});

test("event purchase options need a name, a sane price and unique ids", async () => {
  const { checkPurchaseOptions } = await import("./validateInput");
  assert.equal(checkPurchaseOptions(undefined), null);
  assert.equal(checkPurchaseOptions([{ id: "a", name: "Pit", amount: 0 }, { id: "rm-trackr" }]), null);
  assert.match(checkPurchaseOptions("x") ?? "", /list/);
  assert.match(checkPurchaseOptions([{ id: "a", name: "  ", amount: 5 }]) ?? "", /name/);
  assert.match(checkPurchaseOptions([{ id: "a", name: "Pit", amount: -1 }]) ?? "", /\$0 or more/);
  assert.match(checkPurchaseOptions([{ id: "a", name: "Pit", amount: Number.NaN }]) ?? "", /\$0 or more/);
  assert.match(checkPurchaseOptions([{ id: "a", name: "Pit", amount: 100_001 }]) ?? "", /too large/);
  assert.match(checkPurchaseOptions([{ id: "a", name: "Pit", amount: 1 }, { id: "a", name: "Camp", amount: 2 }]) ?? "", /unique/);
});

test("event dates must be in order", async () => {
  const { checkEventDateOrder } = await import("./validateInput");
  const ok = { date: "2026-06-14", registrationOpen: "2026-05-01T08:00:00.000Z", registrationClose: "2026-06-13T18:00:00.000Z", earlyBirdEndsAt: "2026-05-20", earlyBirdFee: 30, entryFee: 40 };
  assert.equal(checkEventDateOrder(ok), null);
  // Evening close on race day in Mountain time is the next day in UTC.
  assert.equal(checkEventDateOrder({ ...ok, registrationClose: "2026-06-15T02:00:00.000Z" }), null);
  assert.match(checkEventDateOrder({ ...ok, registrationClose: "2026-04-30T08:00:00.000Z" }) ?? "", /close after it opens/);
  assert.match(checkEventDateOrder({ ...ok, registrationClose: "2026-06-20T08:00:00.000Z" }) ?? "", /last race day/);
  assert.equal(checkEventDateOrder({ ...ok, endDate: "2026-06-21", registrationClose: "2026-06-20T08:00:00.000Z" }), null);
  assert.match(checkEventDateOrder({ ...ok, earlyBirdEndsAt: "2026-06-15" }) ?? "", /early sign-up period/);
  assert.match(checkEventDateOrder({ ...ok, earlyBirdFee: 40 }) ?? "", /less than the entry fee/);
});
