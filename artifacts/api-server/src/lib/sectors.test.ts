import test from "node:test";
import assert from "node:assert/strict";
import { computeRiderSectors, bestSectors, sectorNames, riderTimingPoints, latestSplitGaps, fieldBestSectors } from "./sectors";

const t = (s: number) => new Date(Date.UTC(2026, 9, 28, 18, 0, 0) + s * 1000);

test("sector names run finish → splits → finish", () => {
  assert.deepEqual(sectorNames([{ label: "Halfway" }]), ["Finish → Halfway", "Halfway → Finish"]);
  assert.deepEqual(sectorNames([]), ["Finish → Finish"]);
});

test("sectors split each lap at the course points", () => {
  const laps = computeRiderSectors({
    startedAt: t(0),
    splitCount: 2,
    laps: [{ lapNumber: 1, crossingTime: t(100) }, { lapNumber: 2, crossingTime: t(190) }],
    splits: [
      { lapNumber: 1, splitSequence: 1, crossingTime: t(30) },
      { lapNumber: 1, splitSequence: 2, crossingTime: t(70) },
      { lapNumber: 2, splitSequence: 1, crossingTime: t(128) },
      { lapNumber: 2, splitSequence: 2, crossingTime: t(160) },
      { lapNumber: 3, splitSequence: 1, crossingTime: t(220) },
    ],
  });
  assert.deepEqual(laps, [
    { lapNumber: 1, sectorsMs: [30_000, 40_000, 30_000], complete: true },
    { lapNumber: 2, sectorsMs: [28_000, 32_000, 30_000], complete: true },
    // Lap in progress: first sector known, the rest not yet.
    { lapNumber: 3, sectorsMs: [30_000, null, null], complete: false },
  ]);
  assert.deepEqual(bestSectors(laps, 3), [28_000, 32_000, 30_000]);
});

test("a missed split blanks only the sectors around it; the lap still counts", () => {
  const [lap] = computeRiderSectors({
    startedAt: t(0),
    splitCount: 2,
    laps: [{ lapNumber: 1, crossingTime: t(100) }],
    splits: [{ lapNumber: 1, splitSequence: 2, crossingTime: t(70) }],
  });
  assert.deepEqual(lap, { lapNumber: 1, sectorsMs: [null, null, 30_000], complete: true });
});

test("gaps at each rider's latest timing point, to the leader and the rider ahead", () => {
  const pts = (laps: Array<[number, number]>, splits: Array<[number, number, number]>) =>
    riderTimingPoints({ splitCount: 1, laps: laps.map(([lapNumber, s]) => ({ lapNumber, crossingTime: t(s) })), splits: splits.map(([lapNumber, splitSequence, s]) => ({ lapNumber, splitSequence, crossingTime: t(s) })) });
  const byRider = new Map([
    // Leader: lap 1 split at 30 s, finish at 60 s, lap 2 split at 90 s.
    [1, pts([[1, 60]], [[1, 1, 30], [2, 1, 90]])],
    // Second: lap 2 split at 92.5 s (2.5 s down there).
    [2, pts([[1, 61]], [[1, 1, 31], [2, 1, 92.5]])],
    // Third: only reached lap 1's finish so far, 1.5 s behind second there.
    [3, pts([[1, 62.5]], [[1, 1, 33]])],
  ]);
  const gaps = latestSplitGaps([1, 2, 3], byRider);
  assert.deepEqual(gaps.get(1), { lap: 2, point: 1, gapToLeaderMs: 0, gapToAheadMs: null });
  assert.deepEqual(gaps.get(2), { lap: 2, point: 1, gapToLeaderMs: 2_500, gapToAheadMs: 2_500 });
  assert.deepEqual(gaps.get(3), { lap: 1, point: 2, gapToLeaderMs: 2_500, gapToAheadMs: 1_500 });
});

test("the race's best sector times across every rider", () => {
  const a = { laps: [{ lapNumber: 1, sectorsMs: [30_000, 31_000], complete: true }] };
  const b = { laps: [{ lapNumber: 1, sectorsMs: [29_000, null], complete: true }] };
  assert.deepEqual(fieldBestSectors([a, b], 2), [29_000, 31_000]);
});

test("a moto with no recorded start leaves lap 1's first sector blank", () => {
  const [lap] = computeRiderSectors({
    startedAt: null,
    splitCount: 1,
    laps: [{ lapNumber: 1, crossingTime: t(100) }],
    splits: [{ lapNumber: 1, splitSequence: 1, crossingTime: t(40) }],
  });
  assert.deepEqual(lap.sectorsMs, [null, 60_000]);
});
