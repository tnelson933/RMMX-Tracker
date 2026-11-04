// Run from scripts/: ./node_modules/.bin/tsx --test ../artifacts/rider-app/lib/career.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { finishSpread, lapsLedTakeaway, spreadTakeaway, startTakeaway, type CareerNumbers } from "./career";

const base: CareerNumbers = {
  starts: 10, finishes: 9, dnfs: 1, wins: 1, podiums: 3, top5s: 6, totalLaps: 60, lapsLed: 5, pctLapsLed: 8.3,
  avgLap1Position: 5.2, avgFinish: 4.6, avgPositionsGained: 0.6,
};

test("finish spread splits finishes without double counting", () => {
  assert.deepEqual(finishSpread(base).map(s => s.count), [1, 2, 3, 3, 1]);
  assert.equal(finishSpread({ ...base, dnfs: undefined }).at(-1)!.count, 1);
});

test("spread takeaway", () => {
  assert.equal(spreadTakeaway(base), "Won 11% and podiumed 33% of finished motos.");
  assert.equal(spreadTakeaway({ ...base, wins: 0 }), "On the podium in 33% of finished motos.");
  assert.equal(spreadTakeaway({ ...base, wins: 0, podiums: 0 }), "Top 5 in 67% of finished motos.");
  assert.equal(spreadTakeaway({ ...base, wins: 0, podiums: 0, top5s: 0 }), "9 motos finished. Average finish P5.");
  assert.equal(spreadTakeaway({ ...base, finishes: 0 }), "10 starts, no finishes yet.");
});

test("start vs finish takeaway", () => {
  assert.equal(startTakeaway(base), "You gain 0.6 places per moto after lap 1.");
  assert.equal(startTakeaway({ ...base, avgPositionsGained: -1.25 }), "You lose 1.3 places per moto after lap 1. Your starts are strong.");
  assert.equal(startTakeaway({ ...base, avgPositionsGained: 0.1 }), "You finish about where you are after lap 1.");
  assert.equal(startTakeaway({ ...base, avgLap1Position: null }), null);
});

test("laps led takeaway", () => {
  assert.equal(lapsLedTakeaway(base), "Led 5 of 60 laps (8.3%).");
  assert.equal(lapsLedTakeaway({ ...base, lapsLed: 0 }), "No laps led yet. Average position after lap 1: P5.");
  assert.equal(lapsLedTakeaway({ ...base, totalLaps: 0 }), null);
});
