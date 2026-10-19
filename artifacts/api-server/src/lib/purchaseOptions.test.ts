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
