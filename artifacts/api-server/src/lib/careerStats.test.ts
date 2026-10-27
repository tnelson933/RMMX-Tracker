import assert from "node:assert/strict";
import test from "node:test";
import { computeCareerStats, cumulativeMs, lapPositions, parseLapMs, type CareerMotoInput } from "./careerStats";

const moto = (over: Partial<CareerMotoInput>): CareerMotoInput => ({
  motoId: 1, motoType: "heat", position: 1, dnf: false, dns: false, lapTimes: [],
  eventId: 10, eventName: "Spring MX", motoName: "250 B Moto 1", ...over,
});

test("lap values parse from every stored shape", () => {
  assert.equal(parseLapMs(61_500), 61_500);
  assert.equal(parseLapMs("1:01.5"), 61_500);
  assert.equal(parseLapMs("1:01.234"), 61_234);
  assert.equal(parseLapMs("59.9"), 59_900);
  assert.equal(parseLapMs("118336"), 118_336); // ms stored as text
  assert.equal(parseLapMs("62"), 62_000);       // whole seconds
  assert.equal(parseLapMs({ time: "2:00.000" }), 120_000);
  assert.equal(parseLapMs(""), null);
  assert.equal(parseLapMs(0), null);
  assert.equal(cumulativeMs([1000, "bad"]), null);
  assert.deepEqual(cumulativeMs([1000, 2000]), [1000, 3000]);
});

test("running positions rank cumulative time per lap", () => {
  const a = [60, 120, 180], b = [62, 118, 185], c = [70, 130];
  assert.deepEqual(lapPositions(a, [a, b, c]), [1, 2, 1]);
  assert.deepEqual(lapPositions(b, [a, b, c]), [2, 1, 2]);
  assert.deepEqual(lapPositions(c, [a, b, c]), [3, 3]);
});

test("career stats: wins, laps led, lap-1 leads and positions gained", () => {
  // Moto 1: rider is 2nd on lap 1, leads laps 2-3, wins.
  const me1 = [61_000, 60_000, 60_000], rival1 = [60_000, 62_000, 62_000];
  // Moto 2: rider leads lap 1, fades to 3rd.
  const me2 = [59_000, 70_000, 70_000], r2a = [60_000, 60_000, 60_000], r2b = [61_000, 61_000, 61_000];
  const field = new Map<number, number[][]>([
    [1, [cumulativeMs(me1)!, cumulativeMs(rival1)!]],
    [2, [cumulativeMs(me2)!, cumulativeMs(r2a)!, cumulativeMs(r2b)!]],
  ]);
  const s = computeCareerStats([
    moto({ motoId: 1, position: 1, lapTimes: me1 }),
    moto({ motoId: 2, position: 3, lapTimes: me2, motoName: "250 B Moto 2" }),
    moto({ motoId: 3, position: 999, dns: true }),
    moto({ motoId: 4, position: 4, dnf: true, lapTimes: [65_000] }),
    moto({ motoId: 5, motoType: "practice", position: 1, lapTimes: [50_000] }),
  ], field);

  assert.equal(s.starts, 3);          // DNS and practice excluded
  assert.equal(s.finishes, 2);
  assert.equal(s.dnfs, 1);
  assert.equal(s.wins, 1);
  assert.equal(s.podiums, 2);
  assert.equal(s.avgFinish, 2);
  assert.equal(s.totalLaps, 7);       // 3 + 3 + 1 (DNF lap still counts)
  assert.equal(s.lapsLed, 4);         // moto1 laps 2-3, moto2 lap 1, DNF solo lap 1
  assert.equal(s.lap1Leads, 2);       // moto2 + the solo DNF moto
  assert.equal(s.positionsGained, -1); // moto1: 2 -> 1 (+1), moto2: 1 -> 3 (-2)
  assert.equal(s.bestLap?.ms, 59_000); // practice lap of 50s is ignored
  assert.equal(s.bestLap?.motoName, "250 B Moto 2");
});

test("motocross best lap ignores lap 1 (gate start)", () => {
  const s = computeCareerStats([moto({ raceStyle: "motocross", lapTimes: [40_000, 61_000, 60_000] })], new Map());
  assert.equal(s.bestLap?.ms, 60_000);
});

test("no races gives empty stats", () => {
  const s = computeCareerStats([], new Map());
  assert.equal(s.starts, 0);
  assert.equal(s.avgFinish, null);
  assert.equal(s.pctLapsLed, null);
  assert.equal(s.bestLap, null);
});
