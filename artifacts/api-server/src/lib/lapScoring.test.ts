import assert from "node:assert/strict";
import test from "node:test";
import {
  compareStandings,
  computeFinishAt,
  everyoneFinished,
  finishGraceMs,
  flagTimeFor,
  scoreRider,
// @ts-expect-error Node's type-stripping runner requires the explicit extension.
} from "./lapScoring.ts";

const start = new Date("2026-10-29T15:00:00Z");
const at = (s: number) => new Date(start.getTime() + s * 1000);
const fixed = (lapCount: number) => ({ startedAt: start, lapCount, timeLimitMs: null, plusLaps: null, timeExpiredAt: null });

test("a missed read entered by hand fits into the rider's laps in time order", () => {
  // Tag laps at 120, 240, 360; manual at 480 (missed read); tag at 600.
  const s = scoreRider(fixed(10), [at(120), at(240), at(360), at(600), at(480)], null);
  assert.deepEqual(s.lapTimes, [120_000, 120_000, 120_000, 120_000, 120_000]);
  assert.equal(s.totalMs, 600_000);
});

test("crossings before the start don't count", () => {
  assert.equal(scoreRider(fixed(5), [at(-3), at(100)], null).counted.length, 1);
});

test("fixed-lap race: the leader's last lap ends it; lapped riders finish on their next crossing", () => {
  const leader = [at(100), at(200), at(300)];
  const lapped = [at(150), at(310), at(460)];
  const moto = fixed(3);
  const finishAt = computeFinishAt(moto, [leader, lapped]);
  assert.equal(finishAt?.getTime(), at(300).getTime());
  const l = scoreRider(moto, [...leader, at(400)], finishAt);
  assert.equal(l.counted.length, 3, "cool-down lap after the flag doesn't count");
  const p = scoreRider(moto, lapped, finishAt);
  assert.equal(p.counted.length, 2, "lapped rider finishes on the first crossing after the leader");
  assert.equal(p.finished, true);
});

test("timed race + 1 lap: everyone behind the leader still gets their last lap", () => {
  const moto = { startedAt: start, lapCount: null, timeLimitMs: 600_000, plusLaps: 1, timeExpiredAt: at(600) };
  const leader = [at(110), at(220), at(330), at(440), at(550), at(660)];
  const second = [at(112), at(224), at(336), at(448), at(560), at(663), at(780)];
  const finishAt = computeFinishAt(moto, [leader, second]);
  assert.equal(finishAt?.getTime(), at(660).getTime(), "leader's first crossing after the flag");
  const s2 = scoreRider(moto, second, finishAt);
  assert.equal(s2.counted.length, 6, "3 s behind the leader still counts; the cool-down doesn't");
  assert.equal(s2.finished, true);
  assert.ok(everyoneFinished([{ score: scoreRider(moto, leader, finishAt), out: false }, { score: s2, out: false }]));
});

test("timed race leader is decided at the flag, not by whoever crosses first after it", () => {
  const moto = { startedAt: start, lapCount: null, timeLimitMs: 600_000, plusLaps: 1, timeExpiredAt: at(600) };
  const leader = [at(150), at(300), at(450), at(590), at(700)];
  const lappedAhead = [at(200), at(400), at(605)]; // crosses first after the flag, but a lap down
  assert.equal(computeFinishAt(moto, [leader, lappedAhead])?.getTime(), at(700).getTime());
});

test("no extra laps: each rider finishes on their first crossing after the flag", () => {
  const moto = { startedAt: start, lapCount: null, timeLimitMs: 600_000, plusLaps: 0, timeExpiredAt: at(600) };
  const finishAt = computeFinishAt(moto, [[at(590), at(700)]]);
  assert.equal(finishAt?.getTime(), at(600).getTime());
  assert.equal(scoreRider(moto, [at(590), at(700), at(800)], finishAt).counted.length, 2);
});

test("the race isn't over until riders still racing have crossed", () => {
  const moto = fixed(2);
  const finishAt = computeFinishAt(moto, [[at(100), at(200)], [at(110)]]);
  const done = { score: scoreRider(moto, [at(100), at(200)], finishAt), out: false };
  const racing = { score: scoreRider(moto, [at(110)], finishAt), out: false };
  const dnf = { score: scoreRider(moto, [at(120)], finishAt), out: true };
  assert.equal(everyoneFinished([done, racing]), false);
  assert.equal(everyoneFinished([done, dnf]), true, "a DNF isn't waited for");
});

test("standings: laps, then time; DNF last", () => {
  const rows = [
    { id: "dnf", laps: 5, totalMs: 100, out: true },
    { id: "b", laps: 4, totalMs: 500 },
    { id: "a", laps: 4, totalMs: 400 },
  ].sort(compareStandings);
  assert.deepEqual(rows.map(r => r.id), ["a", "b", "dnf"]);
});

test("the flag falls at start + limit + red-flag time, never while paused", () => {
  const moto = { startedAt: start, timeLimitMs: 600_000, totalPausedMs: 30_000, pausedAt: null };
  assert.equal(flagTimeFor(moto, at(620).getTime()), null);
  assert.equal(flagTimeFor(moto, at(631).getTime())?.getTime(), at(630).getTime());
  assert.equal(flagTimeFor({ ...moto, pausedAt: at(500) }, at(700).getTime()), null);
});

test("grace after the leader's finish scales with lap length", () => {
  assert.equal(finishGraceMs([30_000, 20_000, 20_000]), 60_000);
  assert.equal(finishGraceMs([130_000, 120_000, 120_000]), 180_000);
  assert.equal(finishGraceMs([]), 180_000);
});
