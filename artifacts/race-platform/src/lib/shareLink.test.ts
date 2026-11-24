import assert from "node:assert/strict";
import test from "node:test";
import { riderFromSearch, riderResultUrl } from "./shareLink";

test("rider result links match the server's shared path", () => {
  assert.equal(riderResultUrl("https://www.rmroost.com/", 42, 9), "https://www.rmroost.com/results/42?rider=9");
});

test("?rider= is read as a positive id only", () => {
  assert.equal(riderFromSearch("?rider=9"), 9);
  assert.equal(riderFromSearch("?x=1&rider=123"), 123);
  assert.equal(riderFromSearch(""), null);
  assert.equal(riderFromSearch("?rider=0"), null);
  assert.equal(riderFromSearch("?rider=9abc"), null);
  assert.equal(riderFromSearch("?rider=-3"), null);
  assert.equal(riderFromSearch("?rider=1234567890"), null);
});
