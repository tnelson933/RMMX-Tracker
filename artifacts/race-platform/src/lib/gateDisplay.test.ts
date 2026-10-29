import assert from "node:assert/strict";
import test from "node:test";
// @ts-expect-error Node's type-stripping runner requires the explicit extension.
import { parseSecs, safeRiderName, sortResults, gapLabel, raceRemainingMs, clockOffsetMs, pickFeatured, pickEventId, type DisplayResult } from "./gateDisplay.ts";

test("parseSecs reads m:ss.cc before plain seconds", () => {
  assert.equal(parseSecs("1:23.45"), 83.45);
  assert.equal(parseSecs("58.4"), 58.4);
  assert.equal(parseSecs("1:02:03.5"), 3723.5);
  assert.equal(parseSecs(""), null);
  assert.equal(parseSecs("abc"), null);
  assert.equal(parseSecs("0"), null);
});

test("safeRiderName guards null names", () => {
  assert.equal(safeRiderName(null, "12"), "Rider #12");
  assert.equal(safeRiderName("null null"), "Unknown Rider");
  assert.equal(safeRiderName("Jo null"), "Jo");
});

const row = (p: Partial<DisplayResult>): DisplayResult => ({
  key: Math.random(), riderName: "x", bibNumber: null, position: null, laps: 0, totalSecs: null, bestSecs: null, dnf: false, dns: false, ...p,
});

test("sortResults puts DNF/DNS and missing positions last", () => {
  const sorted = sortResults([
    row({ key: "dns", dns: true, position: 1 }),
    row({ key: "none" }),
    row({ key: "p2", position: 2 }),
    row({ key: "dnf", dnf: true }),
    row({ key: "p1", position: 1 }),
  ]);
  assert.deepEqual(sorted.map((r) => r.key), ["p1", "p2", "none", "dnf", "dns"]);
});

test("gapLabel shows laps down instead of negative time", () => {
  const leader = row({ laps: 10, totalSecs: 900 });
  assert.equal(gapLabel(row({ laps: 8, totalSecs: 800 }), leader), "+2 laps");
  assert.equal(gapLabel(row({ laps: 9, totalSecs: 800 }), leader), "+1 lap");
  assert.equal(gapLabel(row({ laps: 10, totalSecs: 905.5 }), leader), "+5.500");
  assert.equal(gapLabel(row({ laps: 10, totalSecs: 800 }), leader), null);
});

test("raceRemainingMs leaves out red-flag time and freezes while paused", () => {
  const start = "2026-10-29T12:00:00.000Z";
  const now = Date.parse("2026-10-29T12:10:00.000Z");
  assert.equal(raceRemainingMs({ startedAt: start, timeLimitMs: 15 * 60_000, totalPausedMs: 0 }, now), 5 * 60_000);
  assert.equal(raceRemainingMs({ startedAt: start, timeLimitMs: 15 * 60_000, totalPausedMs: 60_000 }, now), 6 * 60_000);
  assert.equal(raceRemainingMs({ startedAt: start, timeLimitMs: 15 * 60_000, totalPausedMs: 0, pausedAt: "2026-10-29T12:05:00.000Z" }, now), 10 * 60_000);
});

test("clockOffsetMs uses the request midpoint", () => {
  assert.equal(clockOffsetMs("2026-10-29T12:00:10.000Z", Date.parse("2026-10-29T12:00:00.000Z"), Date.parse("2026-10-29T12:00:00.200Z")), 9_900);
  assert.equal(clockOffsetMs(null, 0, 0), null);
});

test("pickFeatured holds a finished race, then moves on", () => {
  const done = "2026-10-29T12:00:00.000Z";
  const motos = [
    { id: 1, status: "completed", completedAt: done },
    { id: 2, status: "scheduled", staggeredGroupId: 7, staggeredOrder: 1 },
    { id: 3, status: "scheduled", staggeredGroupId: 7, staggeredOrder: 2 },
    { id: 4, status: "scheduled" },
  ];
  const t = Date.parse(done);
  const held = pickFeatured(motos, t + 60_000);
  assert.equal(held.holding, true);
  assert.deepEqual(held.featured.map((m) => m.id), [1]);
  const next = pickFeatured(motos, t + 3 * 60_000);
  assert.deepEqual(next.featured.map((m) => m.id), [2, 3]);
  assert.deepEqual(next.upcoming.map((m) => m.id), [4]);
  const live = pickFeatured([{ ...motos[0] }, { ...motos[1], status: "in_progress" }, { ...motos[2], status: "in_progress" }, motos[3]], t + 60_000);
  assert.deepEqual(live.featured.map((m) => m.id), [2, 3]);
});

test("pickEventId only uses ids still racing today", () => {
  assert.equal(pickEventId([5, 6], 6, 5), 6);
  assert.equal(pickEventId([5, 6], 9, 9), 5);
  assert.equal(pickEventId([5, 6], null, 6), 6);
  assert.equal(pickEventId([], 6, 6), null);
});
