// Racer profile extras: big wins, tracks and states, history filters, who to
// follow, and how bike and sponsors are shown.
import assert from "node:assert/strict";
import test from "node:test";
import {
  BIG_WIN_FIELD, bikeLabel, computeProfileExtras, filterHistory, historyFilterOptions, pickSuggestions, sponsorList,
  type ExtrasMoto,
} from "./riderProfilePlus";

let nextMoto = 1;
const moto = (o: Partial<ExtrasMoto>): ExtrasMoto => ({
  motoId: nextMoto++, motoType: "heat", motoName: "Moto 1", position: 1, dnf: false, dns: false,
  eventId: 1, eventName: "Round 1", eventDate: "2026-05-01", raceClass: "250 A", track: "Rocky Ridge", state: "UT", ...o,
});

test("a big win is a race won against 10 or more starters; biggest field first", () => {
  const small = moto({ eventId: 1 }), big = moto({ eventId: 2, eventName: "State Champs" }), huge = moto({ eventId: 3, eventName: "Regional" });
  const second = moto({ eventId: 4, position: 2 }), dnf = moto({ eventId: 5, position: 1, dnf: true });
  const starters = new Map([[small.motoId, BIG_WIN_FIELD - 1], [big.motoId, BIG_WIN_FIELD], [huge.motoId, 31], [second.motoId, 40], [dnf.motoId, 40]]);
  const e = computeProfileExtras([small, big, huge, second, dnf], starters);
  assert.deepEqual(e.bigWins.map(w => [w.eventName, w.fieldSize]), [["Regional", 31], ["State Champs", 10]]);
});

test("events, top-10s, tracks and states count what was actually raced", () => {
  const e = computeProfileExtras([
    moto({ eventId: 1, position: 4 }), moto({ eventId: 1, position: 12 }),
    moto({ eventId: 2, position: 10, track: "Dry Lake", state: "nv" }),
    moto({ eventId: 3, position: 1, dns: true, track: "Never Raced", state: "CA" }), // DNS: not raced
    moto({ eventId: 4, position: 1, motoType: "practice", track: "Practice Only", state: "ID" }),
    moto({ eventId: 5, position: 3, track: null, state: "Utah" }), // no track; a state that isn't a code
  ], new Map());
  assert.equal(e.events, 3);
  assert.equal(e.top10s, 3);
  assert.deepEqual(e.tracks, [{ name: "Dry Lake", events: 1 }, { name: "Rocky Ridge", events: 1 }]);
  assert.deepEqual(e.states, [{ code: "NV", events: 1 }, { code: "UT", events: 1 }]);
});

test("a finish of 999 (live timing placeholder) is not a top-10 or a win", () => {
  const m = moto({ position: 999 });
  const e = computeProfileExtras([m], new Map([[m.motoId, 30]]));
  assert.deepEqual([e.top10s, e.bigWins.length], [0, 0]);
});

const history = [
  { eventId: 1, eventDate: "2026-06-01", raceClass: "250 A", track: "Rocky Ridge" },
  { eventId: 2, eventDate: "2026-04-01", raceClass: "450 A", track: "Dry Lake" },
  { eventId: 3, eventDate: "2025-09-01", raceClass: "250 A", track: null },
];

test("history filter options list years (newest first), classes and tracks", () => {
  assert.deepEqual(historyFilterOptions(history), { years: ["2026", "2025"], classes: ["250 A", "450 A"], tracks: ["Dry Lake", "Rocky Ridge"] });
});

test("history filters combine; an empty filter returns everything", () => {
  assert.equal(filterHistory(history, {}).length, 3);
  assert.deepEqual(filterHistory(history, { year: "2026" }).map(i => i.eventId), [1, 2]);
  assert.deepEqual(filterHistory(history, { year: "2026", raceClass: "250 a" }).map(i => i.eventId), [1]);
  assert.deepEqual(filterHistory(history, { track: "dry lake" }).map(i => i.eventId), [2]);
  assert.deepEqual(filterHistory(history, { raceClass: "85cc" }), []);
});

test("suggestions: strongest first, never your own or followed riders, each once", () => {
  const candidates = [{ riderId: 5, weight: 2 }, { riderId: 7, weight: 9 }, { riderId: 8, weight: 9 }, { riderId: 9, weight: 4 }, { riderId: 7, weight: 1 }];
  assert.deepEqual(pickSuggestions(candidates, new Set([9]), 3), [7, 8, 5]);
  assert.deepEqual(pickSuggestions(candidates, new Set(), 2), [7, 8]);
  assert.deepEqual(pickSuggestions([], new Set(), 5), []);
});

test("bike and sponsors show cleanly", () => {
  assert.equal(bikeLabel({ year: "2024", make: "KTM", model: "250 SX-F" }), "2024 KTM 250 SX-F");
  assert.equal(bikeLabel({ year: "2024", make: " ", model: "" }), null); // a year alone isn't a bike
  assert.equal(bikeLabel({ make: "Yamaha" }), "Yamaha");
  assert.deepEqual(sponsorList("Fox, Dunlop | Bell; Fox\nRocky Mountain ATV/MC"), ["Fox", "Dunlop", "Bell", "Rocky Mountain ATV/MC"]);
  assert.deepEqual(sponsorList(null), []);
});
