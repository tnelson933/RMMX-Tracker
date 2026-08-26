import assert from "node:assert/strict";
import test from "node:test";

import {
  buildTimingIdentityResolver,
  crossingBelongsToRider,
  isValidActiveTransponderIdentifier,
  normalizeActiveTransponderIdentifier,
  normalizeTimingIdentifier,
  resolveCrossingRiderId,
  type TimingAssignmentIdentityRow,
  type TimingRegistrationIdentityRow,
  type TimingRiderIdentityRow,
} from "./riderTimingIdentity";

const assignments: TimingAssignmentIdentityRow[] = [
  {
    eventId: 10,
    assignmentId: 4,
    riderId: 44,
    firstName: "Primary",
    lastName: "Assignment",
    bibNumber: "44",
    timingIdentifier: "assignment-conflict",
  },
  {
    eventId: 10,
    assignmentId: 5,
    riderId: 55,
    firstName: "Assignment",
    lastName: "Only",
    bibNumber: "55",
    timingIdentifier: "assignment-only",
  },
];

const registrations: TimingRegistrationIdentityRow[] = [
  {
    eventId: 10,
    registrationId: 2,
    riderId: 22,
    firstName: "Event",
    lastName: "Assignment",
    registrationBibNumber: "22",
    riderBibNumber: null,
    registrationTransponderNumber: "registration-conflict",
    profileRfidNumber: null,
    profileActiveTransponderNumber: "profile-22",
  },
  {
    eventId: 10,
    registrationId: 1,
    riderId: 11,
    firstName: "Profile",
    lastName: "Owner",
    registrationBibNumber: null,
    riderBibNumber: "11",
    registrationTransponderNumber: null,
    profileRfidNumber: "passive-11",
    profileActiveTransponderNumber: "registration-conflict",
  },
];

const riders: TimingRiderIdentityRow[] = [
  {
    riderId: 22,
    firstName: "Event",
    lastName: "Assignment",
    bibNumber: "22",
    profileRfidNumber: null,
    profileActiveTransponderNumber: "profile-22",
  },
  {
    riderId: 11,
    firstName: "Profile",
    lastName: "Owner",
    bibNumber: "11",
    profileRfidNumber: "PASSIVE-11",
    profileActiveTransponderNumber: "1A42006F",
  },
  {
    riderId: 33,
    firstName: "Global",
    lastName: "Fallback",
    bibNumber: "33",
    profileRfidNumber: null,
    profileActiveTransponderNumber: "global-33",
  },
  {
    riderId: 66,
    firstName: "Profile",
    lastName: "Conflict",
    bibNumber: "66",
    profileRfidNumber: null,
    profileActiveTransponderNumber: "assignment-conflict",
  },
];

test("normalizes active timing identifiers case-insensitively", () => {
  assert.equal(normalizeTimingIdentifier(" 1A42006F "), "1a42006f");
  assert.equal(normalizeTimingIdentifier("  "), null);
});

test("accepts Feibot hexadecimal and legacy numeric active identifiers", () => {
  assert.equal(normalizeActiveTransponderIdentifier(" 1a420074 "), "1a420074");
  assert.equal(normalizeActiveTransponderIdentifier("1A420074"), "1a420074");
  assert.equal(normalizeActiveTransponderIdentifier("401234567"), "401234567");
  assert.equal(isValidActiveTransponderIdentifier("abcdef"), true);
});

test("rejects empty and malformed active identifiers", () => {
  for (const value of ["", "   ", "1a42007g", "1a-420074", "1234567890"]) {
    assert.equal(isValidActiveTransponderIdentifier(value), false, value);
    assert.equal(normalizeActiveTransponderIdentifier(value), null, value);
  }
  assert.equal(isValidActiveTransponderIdentifier(null), false);
  assert.equal(isValidActiveTransponderIdentifier(undefined), false);
});

test("matches timing processor precedence across assignments, registrations, and profiles", () => {
  const resolve = buildTimingIdentityResolver(assignments, registrations, riders);
  assert.equal(resolve(10, "ASSIGNMENT-CONFLICT")?.riderId, 44);
  assert.equal(resolve(10, "assignment-only")?.riderId, 55);
  assert.equal(resolve(10, "registration-conflict")?.riderId, 22);
  assert.equal(resolve(10, "PROFILE-22")?.riderId, 22);
  assert.equal(resolve(10, "passive-11")?.riderId, 11);
});

test("falls back to global rider active identifiers for unregistered riders", () => {
  const resolve = buildTimingIdentityResolver(assignments, registrations, riders);
  assert.equal(resolve(10, "GLOBAL-33")?.riderId, 33);
  assert.equal(resolve(10, "unknown"), null);
});

test("keeps a stored rider link authoritative over duplicate identifiers", () => {
  const resolve = buildTimingIdentityResolver(assignments, registrations, riders);
  assert.equal(resolveCrossingRiderId(99, 10, "registration-conflict", resolve), 99);
  assert.equal(crossingBelongsToRider(99, 10, "registration-conflict", 22, resolve), false);
  assert.equal(crossingBelongsToRider(null, 10, "REGISTRATION-CONFLICT", 22, resolve), true);
});

test("treats SQL wildcard characters as literal identifier content", () => {
  const resolve = buildTimingIdentityResolver(assignments, registrations, riders);
  assert.equal(resolve(10, "%"), null);
  assert.equal(resolve(10, "_"), null);
});