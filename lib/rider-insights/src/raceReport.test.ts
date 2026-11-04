// Run from scripts/: ./node_modules/.bin/tsx --test ../lib/rider-insights/src/raceReport.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  fmtLapShort, gapTakeaway, lapTakeaway, niceTicks, parseLap, positionTakeaway,
  sectorLosses, sectorTakeaway, summarizeLaps, teamTakeaway,
} from "./raceReport";

test("parseLap reads m:ss.mmm, seconds and a trailing s", () => {
  assert.equal(parseLap("1:55.732"), 115732);
  assert.equal(parseLap("58.41"), 58410);
  assert.equal(parseLap("58.41s"), 58410);
  assert.equal(parseLap("129934"), 129934);
  assert.equal(parseLap(""), null);
  assert.equal(parseLap("DNF"), null);
});

test("fmtLapShort rounds to tenths without showing 60 seconds", () => {
  assert.equal(fmtLapShort(115732), "1:55.7");
  assert.equal(fmtLapShort(119960), "2:00.0");
  assert.equal(fmtLapShort(58410), "58.4");
});

test("lap takeaway: fastest lap and the fade after it (motocross skips lap 1)", () => {
  const s = summarizeLaps(["2:14.8", "1:58.4", "1:56.9", "1:55.7", "1:57.2", "1:58.9", "2:00.3"], true);
  assert.equal(s.bestIndex, 3);
  assert.equal(lapTakeaway(s), "Fastest on lap 4. Last lap was 4.6 s slower.");
});

test("lap takeaway: fastest last lap, and steady laps", () => {
  assert.equal(lapTakeaway(summarizeLaps(["2:00.0", "1:59.0", "1:58.0"], false)), "Fastest on the last lap. Strong finish.");
  assert.equal(lapTakeaway(summarizeLaps(["1:58.0", "1:57.5", "1:58.2"], false)), "Fastest on lap 2. Laps stayed within 0.7 s.");
  assert.equal(lapTakeaway(summarizeLaps(["2:14.8"], true)), null);
});

test("gap takeaway covers leading, losing after the closest point, and gaining", () => {
  assert.equal(gapTakeaway([0, 0, 0]), "Led every lap.");
  assert.equal(gapTakeaway([1200, 0, 0]), "Took the lead on lap 2 and kept it.");
  assert.equal(gapTakeaway([3200, 5100, 6000, 6400, 8100, 10900, 14200]), "3.2 s back on lap 1, then lost 11.0 s more.");
  assert.equal(gapTakeaway([5000, 3000, 2000, 6000]), "2.0 s back on lap 3, then lost 4.0 s more.");
  assert.equal(gapTakeaway([10621, 12904, 19333, 18234, 25980, 15607]), "Gap peaked at 26.0 s on lap 5, then you closed 10.4 s.");
  assert.equal(gapTakeaway([0, 500, 2500]), "Led on lap 1, finished 2.5 s behind the leader.");
  assert.equal(gapTakeaway([2770, 0, 5660, 10734, 16328, 13940]), "Led on lap 2, finished 13.9 s behind the leader.");
  assert.equal(gapTakeaway([6000, 4000, 3000]), "Gained 3.0 s on the leader after lap 1.");
  assert.equal(gapTakeaway([3000, 3200]), "Finished 3.2 s behind the leader.");
  assert.equal(gapTakeaway([null, null]), null);
});

test("position takeaway", () => {
  assert.equal(positionTakeaway([9, 7, 5, 4]), "P9 after lap 1, finished P4: up 5.");
  assert.equal(positionTakeaway([2, 3, 4]), "P2 after lap 1, finished P4: down 2.");
  assert.equal(positionTakeaway([1, 1, 1]), "Led from lap 1 to the flag.");
  assert.equal(positionTakeaway([3, 2, 3]), "Held P3 from lap 1 to the finish.");
});

test("sector losses and takeaway", () => {
  const rows = sectorLosses(["Start", "Whoops", "Sand"], [35440, 45020, 35240], [35040, 43420, 34540]);
  assert.deepEqual(rows.map(r => r.lossMs), [400, 1600, 700]);
  assert.equal(sectorTakeaway(rows), "Whoops costs you most: 1.6 s off the fastest.");
  assert.equal(sectorTakeaway(sectorLosses(["A"], [30000], [29950])), "Within 0.1 s of the fastest rider in every sector.");
  assert.equal(sectorTakeaway([]), null);
});

test("team takeaway compares best laps by first name", () => {
  const you = { name: "Sam Rider", isYou: true, lapTimes: ["2:01.2", "1:59.8"] };
  const mate = { name: "Alex Example", isYou: false, lapTimes: ["1:59.0", "1:58.1"] };
  assert.equal(teamTakeaway([you, mate]), "Alex's best lap was 1.7 s quicker than yours.");
  assert.equal(teamTakeaway([{ ...you, lapTimes: ["1:57.0"] }, mate]), "Your best lap was 1.1 s quicker than Alex's.");
  assert.equal(teamTakeaway([mate]), null);
});

test("niceTicks", () => {
  assert.deepEqual(niceTicks(0, 15, 3), [0, 5, 10, 15]);
  assert.deepEqual(niceTicks(114.5, 121.5, 3), [115, 120]);
  assert.deepEqual(niceTicks(114.5, 121.5, 4), [116, 118, 120]);
});
