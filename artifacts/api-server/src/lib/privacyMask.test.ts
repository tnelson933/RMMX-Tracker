import assert from "node:assert/strict";
import test from "node:test";
import { isMasked, maskDateOfBirth, maskName, maskPhone, maskStreet, maskZip } from "./privacyMask";

test("contact details are partly hidden", () => {
  assert.equal(maskPhone("(602) 555-0100"), "***-***-0100");
  assert.equal(maskPhone(""), "");
  assert.equal(maskName("Jane Smith"), "J*** S****");
  assert.equal(maskName("Al"), "A**");
  assert.equal(maskDateOfBirth("2008-04-12"), "**/**/2008");
  assert.equal(maskDateOfBirth("04/12/2008"), "**/**/2008");
  assert.equal(maskStreet("8648 S 5200 W"), "**** S **** W");
  assert.equal(maskZip("84651"), "84***");
});

test("hidden values are recognized when sent back", () => {
  assert.equal(isMasked("***-***-0100"), true);
  assert.equal(isMasked("602-555-0100"), false);
  assert.equal(isMasked(undefined), false);
});
