import assert from "node:assert/strict";
import test from "node:test";
// @ts-expect-error Node's type-stripping runner requires the explicit extension.
import { finishingPositions, initialReviewRows, reviewEntries } from "./motoReview.ts";

const lap = (v: string | number) => String(v);
const lineup = [
  { riderId: 1, bibNumber: "11", riderName: "Ann" },
  { riderId: 2, bibNumber: "22", riderName: "Bo" },
  { riderId: 3, bibNumber: "33", riderName: "Cy" },
  { riderId: 4, bibNumber: "44", riderName: "Di" },
];
const result = (riderId: number, position: number, extra: Record<string, unknown> = {}) =>
  ({ riderId, position, totalTime: "5:00.000", dnf: false, dns: false, lapTimes: [60000, 60000], bibNumber: null, riderName: null, ...extra });

test("a lineup rider with no laps in a timed race starts as DNS, not as a finisher", () => {
  // Riders 1-3 raced; rider 4 never left the pits.
  const stored = [result(2, 1), result(1, 2), result(3, 3)];
  const rows = initialReviewRows(reviewEntries(lineup, stored), stored, null, lap);
  assert.equal(rows[4].dns, true);
  assert.equal(rows[4].dnf, false);
  assert.equal(rows[4].pos, "");
  assert.equal(rows[2].pos, "1");
  assert.equal(rows[1].dns, false);
  // Saved: the three finishers 1-3, the no-show last.
  const positions = finishingPositions(reviewEntries(lineup, stored), rows);
  assert.deepEqual([2, 1, 3, 4].map(id => positions.get(id)), [1, 2, 3, 4]);
});

test("hand scoring (no results yet) starts everyone in lineup order as finishers", () => {
  const rows = initialReviewRows(reviewEntries(lineup, []), [], null, lap);
  assert.deepEqual(lineup.map(e => rows[e.riderId].pos), ["1", "2", "3", "4"]);
  assert.ok(lineup.every(e => !rows[e.riderId].dns && !rows[e.riderId].dnf));
});

test("a rider scored by their tag but missing from the lineup is still listed and saved", () => {
  const stored = [result(1, 1), result(9, 2, { bibNumber: "99", riderName: "Late Add" }), result(2, 3)];
  const entries = reviewEntries(lineup.slice(0, 2), stored);
  assert.deepEqual(entries.map(e => e.riderId), [1, 2, 9]);
  const rows = initialReviewRows(entries, stored, null, lap);
  assert.equal(rows[9].riderName, "Late Add");
  assert.equal(finishingPositions(entries, rows).get(9), 2);
});

test("a moto with results and no lineup lists its results (saving can't wipe them)", () => {
  const stored = [result(5, 2), result(6, 1)];
  const entries = reviewEntries([], stored);
  assert.deepEqual(entries.map(e => e.riderId), [6, 5]);
  assert.equal(finishingPositions(entries, initialReviewRows(entries, stored, null, lap)).size, 2);
});

test("marking a finisher DNF moves the riders behind them up a place", () => {
  const stored = [result(1, 1), result(2, 2), result(3, 3), result(4, 4)];
  const entries = reviewEntries(lineup, stored);
  const rows = initialReviewRows(entries, stored, null, lap);
  rows[2].dnf = true; // 2nd place is disqualified / didn't finish
  const positions = finishingPositions(entries, rows);
  assert.deepEqual([1, 3, 4, 2].map(id => positions.get(id)), [1, 2, 3, 4]);
});

test("DNF riders are placed ahead of DNS riders, and typed positions set the finishing order", () => {
  const stored = [result(1, 1), result(2, 2), result(3, 3, { dnf: true }), result(4, 4, { dns: true })];
  const entries = reviewEntries(lineup, stored);
  const rows = initialReviewRows(entries, stored, null, lap);
  rows[1].pos = "2"; rows[2].pos = "1"; // the organizer swaps the top two
  const positions = finishingPositions(entries, rows);
  assert.deepEqual([2, 1, 3, 4].map(id => positions.get(id)), [1, 2, 3, 4]);
});

test("stored laps are capped to a fixed-lap race's lap count", () => {
  const stored = [result(1, 1, { lapTimes: [1, 2, 3, 4] })];
  assert.deepEqual(initialReviewRows(reviewEntries(lineup, stored), stored, 3, lap)[1].laps, ["1", "2", "3"]);
  assert.deepEqual(initialReviewRows(reviewEntries(lineup, stored), stored, null, lap)[1].laps, ["1", "2", "3", "4"]);
});
