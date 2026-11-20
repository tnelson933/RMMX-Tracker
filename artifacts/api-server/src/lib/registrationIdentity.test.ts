import assert from "node:assert/strict";
import test from "node:test";
import { profileMatchingName } from "./registrationIdentity";

const kids = [
  { id: 4, firstName: "Ava", lastName: "Lee" },
  { id: 9, firstName: "Max", lastName: "Lee" },
];

test("the profile with the same name is reused, ignoring case and spacing", () => {
  assert.equal(profileMatchingName(kids, " max ", "LEE")?.id, 9);
  assert.equal(profileMatchingName(kids, "Ava", "Lee")?.id, 4);
});

test("a different name on the same email never lands on someone else's profile", () => {
  assert.equal(profileMatchingName(kids, "Zoe", "Lee"), null);
  assert.equal(profileMatchingName([kids[0]], "Max", "Lee"), null);
});

test("a missing name matches nothing", () => {
  assert.equal(profileMatchingName(kids, "", "Lee"), null);
  assert.equal(profileMatchingName(kids, undefined, undefined), null);
});

test("two profiles with the same name: the oldest", () => {
  assert.equal(profileMatchingName([{ id: 12, firstName: "Ava", lastName: "Lee" }, ...kids], "ava", "lee")?.id, 4);
});
