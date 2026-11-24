import assert from "node:assert/strict";
import test from "node:test";
// @ts-expect-error Node's type-stripping runner requires the explicit extension.
import { displayTime, firstRaceTime, mapLink, money, placeLine, registrationIsOpen } from "./eventInfo.ts";

test("map link prefers coordinates, then the address, else none", () => {
  assert.equal(mapLink({ trackLat: 40.1, trackLng: -111.7 }), "https://www.google.com/maps/search/?api=1&query=40.1,-111.7");
  assert.equal(
    mapLink({ trackName: "West Mountain", location: "Payson", state: "UT" }),
    "https://www.google.com/maps/search/?api=1&query=West%20Mountain%2C%20Payson%2C%20UT",
  );
  assert.equal(mapLink({ state: "UT" }), null);
  assert.equal(mapLink({}), null);
});

test("place line joins track and town without repeating the state", () => {
  assert.equal(placeLine({ trackName: "West Mountain", location: "Payson", state: "UT" }), "West Mountain · Payson, UT");
  assert.equal(placeLine({ location: "Payson, UT", state: "UT" }), "Payson, UT");
  assert.equal(placeLine({ state: "UT" }), "UT");
});

test("first race time skips practice and untimed motos", () => {
  assert.equal(firstRaceTime([
    { type: "practice", scheduledTime: "7:00 AM", motoNumber: 1 },
    { type: "heat", scheduledTime: "", motoNumber: 2 },
    { type: "heat", scheduledTime: "9:15 AM", motoNumber: 4 },
    { type: "heat", scheduledTime: "8:30 AM", motoNumber: 3 },
  ]), "8:30 AM");
  assert.equal(firstRaceTime([]), null);
  assert.equal(displayTime("Gate drop 9"), "Gate drop 9");
  assert.equal(displayTime(null), null);
});

test("registration is open only inside its window", () => {
  const now = new Date("2026-11-20T12:00:00Z");
  assert.equal(registrationIsOpen({ status: "registration_open" }, now), true);
  assert.equal(registrationIsOpen({ status: "registration_open", registrationClose: "2026-11-19T00:00:00Z" }, now), false);
  assert.equal(registrationIsOpen({ status: "registration_open", registrationOpen: "2026-11-21T00:00:00Z" }, now), false);
  assert.equal(registrationIsOpen({ status: "registration_closed" }, now), false);
});

test("money drops .00 only for whole dollars", () => {
  assert.equal(money(45), "$45");
  assert.equal(money(42.5), "$42.50");
});
