import assert from "node:assert/strict";
import test from "node:test";
import { buildRegistrationPrefill, type PrefillEntry, type PrefillRider } from "./registrationPrefill";

const rider = (over: Partial<PrefillRider> = {}): PrefillRider => ({
  id: 7, firstName: "Kai", lastName: "Rider", email: "kai@example.test", phone: "555-0100", dateOfBirth: "2001-05-02",
  emergencyContact: "Pat", emergencyPhone: "555-0101", streetAddress: "1 Main", city: "Provo", homeState: "UT", zip: "84601",
  bibNumber: null, amaNumber: null, bikeManufacturer: null, bikeModel: null, bikeYear: null, sponsors: null,
  mylapsTransponderId: null, rfidNumber: null, ...over,
});

let nextId = 1;
const entry = (over: Partial<PrefillEntry>): PrefillEntry => ({
  eventId: 1, raceClass: "250 B", status: "confirmed", paymentStatus: "paid", createdAt: "2026-06-01T00:00:00Z", id: nextId++,
  bibNumber: null, amaNumber: null, clubIdNumber: null, bikeBrand: null, bikeModel: null, bikeYear: null, sponsors: null,
  statsEmailOptIn: false, transponderRental: false, myLapsTransponderNumber: null, rmTrackrTransponder: null, ...over,
});

const event = { id: 9, raceClasses: ["250 B", "Vet 30+", "450 A"] };
const today = "2026-11-20";

test("profile fields come first; the last entry fills what the profile lacks", () => {
  const p = buildRegistrationPrefill(rider({ bibNumber: "22", bikeManufacturer: "KTM" }), [
    entry({ createdAt: "2026-05-01T00:00:00Z", amaNumber: "OLD", clubIdNumber: "C-1" }),
    entry({ createdAt: "2026-06-01T00:00:00Z", amaNumber: "A123", clubIdNumber: "C-2", bibNumber: "99", bikeBrand: "Honda", bikeModel: "CRF250R", statsEmailOptIn: true }),
  ], [], event, today);
  assert.equal(p.bibNumber, "22");
  assert.equal(p.bikeBrand, "KTM");
  assert.equal(p.bikeModel, "CRF250R");
  assert.equal(p.amaNumber, "A123");
  assert.equal(p.clubIdNumber, "C-2");
  assert.equal(p.statsEmailOptIn, true);
  assert.equal(p.hasRaced, true);
});

test("a rented transponder is never offered as the rider's own", () => {
  const p = buildRegistrationPrefill(rider(), [
    entry({ createdAt: "2026-06-01T00:00:00Z", transponderRental: true, myLapsTransponderNumber: "ABC123" }),
  ], [{ trackrChoice: "rent", trackrNumber: "DEF456", rfidNumber: null }], event, today);
  assert.equal(p.transponderNumber, "");
  const own = buildRegistrationPrefill(rider(), [
    entry({ createdAt: "2026-06-01T00:00:00Z", transponderRental: true, myLapsTransponderNumber: "ABC123" }),
    entry({ createdAt: "2026-05-01T00:00:00Z", myLapsTransponderNumber: "F00D" }),
  ], [], event, today);
  assert.equal(own.transponderNumber, "f00d");
  const bought = buildRegistrationPrefill(rider(), [entry({ rmTrackrTransponder: "BEEF1" })], [], event, today);
  assert.equal(bought.transponderNumber, "beef1");
});

test("usual classes: last event's classes this event offers, minus ones already held", () => {
  const p = buildRegistrationPrefill(rider(), [
    entry({ eventId: 3, raceClass: "250 B", createdAt: "2026-06-01T00:00:00Z" }),
    entry({ eventId: 3, raceClass: "vet 30+", createdAt: "2026-06-01T00:00:00Z" }),
    entry({ eventId: 2, raceClass: "450 A", createdAt: "2026-04-01T00:00:00Z" }),
    entry({ eventId: 9, raceClass: "250 B", createdAt: "2026-11-01T00:00:00Z" }),
  ], [], event, today);
  assert.deepEqual(p.registeredClasses, ["250 B"]);
  assert.deepEqual(p.usualClasses, ["Vet 30+"]);
});

test("usual classes fall back to the most-raced offered class; void entries don't count", () => {
  const p = buildRegistrationPrefill(rider(), [
    entry({ eventId: 5, raceClass: "Pee Wee", createdAt: "2026-07-01T00:00:00Z" }),
    entry({ eventId: 4, raceClass: "450 A", createdAt: "2026-06-01T00:00:00Z" }),
    entry({ eventId: 3, raceClass: "450 A", createdAt: "2026-05-01T00:00:00Z" }),
    entry({ eventId: 2, raceClass: "250 B", createdAt: "2026-04-01T00:00:00Z" }),
    entry({ eventId: 8, raceClass: "Vet 30+", status: "void", createdAt: "2026-08-01T00:00:00Z" }),
  ], [], event, today);
  assert.deepEqual(p.usualClasses, ["450 A"]);
});

test("a first-time rider gets the profile only", () => {
  const p = buildRegistrationPrefill(rider({ dateOfBirth: "2012-01-01" }), [], [], event, today);
  assert.deepEqual(p.usualClasses, []);
  assert.equal(p.hasRaced, false);
  assert.equal(p.isMinor, true);
  assert.equal(p.firstName, "Kai");
});

test("a rider with several RM TrackRs gets them all to pick from, the primary first", () => {
  const p = buildRegistrationPrefill(rider({ mylapsTransponderId: "AAA1", trackrNumbers: ["aaa1", "bbb2", "ccc3"] }), [], [], event, today);
  assert.equal(p.transponderNumber, "aaa1");
  assert.deepEqual(p.transponderOptions, ["aaa1", "bbb2", "ccc3"]);
  const none = buildRegistrationPrefill(rider(), [], [], event, today);
  assert.deepEqual(none.transponderOptions, []);
});
