import test from "node:test";
import assert from "node:assert/strict";
import { computeRiderSectors, bestSectors, sectorNames } from "./sectors";

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

test("a moto with no recorded start leaves lap 1's first sector blank", () => {
  const [lap] = computeRiderSectors({
    startedAt: null,
    splitCount: 1,
    laps: [{ lapNumber: 1, crossingTime: t(100) }],
    splits: [{ lapNumber: 1, splitSequence: 1, crossingTime: t(40) }],
  });
  assert.deepEqual(lap.sectorsMs, [null, 60_000]);
});
