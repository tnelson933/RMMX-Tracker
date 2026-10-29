import test from "node:test";
import assert from "node:assert/strict";
import { computeEnduroOverall, pairEnduroRuns, rankEnduroTest } from "./enduroOverall";

const at = (s: number) => new Date(Date.UTC(2026, 9, 28, 16, 0, 0) + s * 1000);

test("runs pair start/finish in insertion order, trailing start stays open", () => {
  const { runs, open, numbered } = pairEnduroRuns([
    { id: 3, crossingTime: at(400) },
    { id: 1, crossingTime: at(0) },
    { id: 2, crossingTime: at(300) },
  ]);
  assert.deepEqual(runs.map((r) => r.elapsedMs), [300_000]);
  assert.equal(open?.id, 3);
  assert.deepEqual(numbered.map((n) => [n.crossing.id, n.runNumber, n.isFinish]), [[1, 1, false], [2, 1, true], [3, 2, false]]);
});

test("clock skew never makes a negative run", () => {
  const { runs } = pairEnduroRuns([{ id: 1, crossingTime: at(10) }, { id: 2, crossingTime: at(5) }]);
  assert.equal(runs[0].elapsedMs, 0);
});

test("test ranking uses total of completed runs, not the best run", () => {
  const pos = rankEnduroTest([
    { id: 1, raceClass: "A", runTimesMs: [100, 500] }, // best 100, total 600
    { id: 2, raceClass: "A", runTimesMs: [250, 250] }, // total 500
  ]);
  assert.equal(pos.get(2), 1);
  assert.equal(pos.get(1), 2);
});

test("fewer runs rank after more runs; DNF/DNS after finishers; per class", () => {
  const pos = rankEnduroTest([
    { id: 1, raceClass: "A", runTimesMs: [100] },
    { id: 2, raceClass: "A", runTimesMs: [300, 300] },
    { id: 3, raceClass: "A", runTimesMs: [50, 50], dnf: true },
    { id: 4, raceClass: "A", runTimesMs: [] },
    { id: 5, raceClass: "A", runTimesMs: [], dns: true },
    { id: 6, raceClass: "B", runTimesMs: [999] },
  ]);
  assert.deepEqual([1, 2, 3, 4, 5].map((id) => pos.get(id)), [2, 1, 4, 3, 5]);
  assert.equal(pos.get(6), 1);
});

test("only truly equal riders share a test position", () => {
  const pos = rankEnduroTest([
    { id: 1, raceClass: "A", runTimesMs: [100, 200] },
    { id: 2, raceClass: "A", runTimesMs: [150, 150] },
    { id: 3, raceClass: "A", runTimesMs: [301] },
    { id: 4, raceClass: "A", runTimesMs: [400] },
  ]);
  assert.deepEqual([1, 2, 3, 4].map((id) => pos.get(id)), [1, 1, 3, 4]);
});

const tests = [
  { motoId: 10, motoNumber: 1, requiredRuns: 2 },
  { motoId: 11, motoNumber: 2, requiredRuns: 1 },
];

test("overall = sum of test totals + penalties, lowest wins, per class", () => {
  const out = computeEnduroOverall(tests, [
    { motoId: 10, riderId: 1, runTimesMs: [100_000, 100_000] },
    { motoId: 11, riderId: 1, runTimesMs: [50_000] },
    { motoId: 10, riderId: 2, runTimesMs: [90_000, 90_000] },
    { motoId: 11, riderId: 2, runTimesMs: [60_000] },
    { motoId: 10, riderId: 3, runTimesMs: [200_000, 200_000] },
    { motoId: 11, riderId: 3, runTimesMs: [200_000] },
  ], [
    { riderId: 1, raceClass: "Open" },
    { riderId: 2, raceClass: "Open", penaltySeconds: 30 }, // 240 + 30 = 270 > 250
    { riderId: 3, raceClass: "Vet" },
  ]);
  assert.deepEqual(out.map((c) => c.raceClass), ["Open", "Vet"]);
  const open = out[0].riders;
  assert.deepEqual(open.map((r) => [r.riderId, r.position, r.totalMs]), [[1, 1, 250_000], [2, 2, 270_000]]);
  assert.equal(open[1].penaltyMs, 30_000);
  assert.equal(open[0].status, "classified");
  assert.equal(out[1].riders[0].position, 1);
});

test("riders missing runs rank after complete riders: more runs first, then time", () => {
  const out = computeEnduroOverall(tests, [
    { motoId: 10, riderId: 1, runTimesMs: [500_000, 500_000] },
    { motoId: 11, riderId: 1, runTimesMs: [500_000] },
    { motoId: 10, riderId: 2, runTimesMs: [10_000, 10_000] }, // 2 of 3 runs
    { motoId: 10, riderId: 3, runTimesMs: [5_000] },           // 1 of 3 runs
    { motoId: 10, riderId: 4, runTimesMs: [1_000, 1_000] },
    { motoId: 11, riderId: 4, runTimesMs: [1_000], dnf: true }, // DNF: test not counted
    { motoId: 10, riderId: 5, runTimesMs: [] },
  ], [1, 2, 3, 4, 5].map((riderId) => ({ riderId, raceClass: "A" })));
  const rows = out[0].riders;
  assert.deepEqual(rows.map((r) => r.riderId), [1, 4, 2, 3, 5]);
  assert.deepEqual(rows.map((r) => r.status), ["classified", "incomplete", "incomplete", "incomplete", "no_time"]);
  assert.equal(rows.find((r) => r.riderId === 4)!.tests[1].timeMs, null);
});

test("overall tie goes to the better time in the latest test both completed", () => {
  const out = computeEnduroOverall(tests, [
    { motoId: 10, riderId: 1, runTimesMs: [60_000, 60_000] },
    { motoId: 11, riderId: 1, runTimesMs: [80_000] },
    { motoId: 10, riderId: 2, runTimesMs: [70_000, 70_000] },
    { motoId: 11, riderId: 2, runTimesMs: [60_000] },
  ], [{ riderId: 1, raceClass: "A" }, { riderId: 2, raceClass: "A" }]);
  assert.deepEqual(out[0].riders.map((r) => [r.riderId, r.position]), [[2, 1], [1, 2]]);
});

test("truly equal riders share an overall position; DQ ranks last", () => {
  const out = computeEnduroOverall(tests, [
    { motoId: 10, riderId: 1, runTimesMs: [60_000, 60_000] },
    { motoId: 11, riderId: 1, runTimesMs: [60_000] },
    { motoId: 10, riderId: 2, runTimesMs: [60_000, 60_000] },
    { motoId: 11, riderId: 2, runTimesMs: [60_000] },
    { motoId: 10, riderId: 3, runTimesMs: [1_000, 1_000] },
    { motoId: 11, riderId: 3, runTimesMs: [1_000] },
    { motoId: 10, riderId: 4, runTimesMs: [90_000, 90_000] },
    { motoId: 11, riderId: 4, runTimesMs: [90_000] },
  ], [
    { riderId: 1, raceClass: "A" },
    { riderId: 2, raceClass: "A" },
    { riderId: 3, raceClass: "A", disqualified: true },
    { riderId: 4, raceClass: "A" },
  ]);
  assert.deepEqual(out[0].riders.map((r) => [r.riderId, r.position]), [[1, 1], [2, 1], [4, 3], [3, 4]]);
});

test("extra runs beyond the test's lapCount are ignored", () => {
  const out = computeEnduroOverall([{ motoId: 10, motoNumber: 1, requiredRuns: 1 }], [
    { motoId: 10, riderId: 1, runTimesMs: [10_000, 10_000] },
  ], [{ riderId: 1, raceClass: "A" }]);
  assert.equal(out[0].riders[0].totalMs, 10_000);
  assert.equal(out[0].riders[0].status, "classified");
});
