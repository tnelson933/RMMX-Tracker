// Run from scripts/: ./node_modules/.bin/tsx --test ../artifacts/rider-app/lib/practice.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { sessionSummary, sessionTakeaway, sessionTrend, trendTakeaway, type PracticeSession } from "./practice";

const laps = (...ms: Array<number | null>) => ms.map((lapTimeMs, i) => ({ lapNumber: i + 1, lapTimeMs }));

test("session summary sorts laps, drops empty ones, and skips motocross lap 1", () => {
  const s = sessionSummary([{ lapNumber: 3, lapTimeMs: 61_000 }, { lapNumber: 1, lapTimeMs: 75_000 }, { lapNumber: 2, lapTimeMs: 60_000 }, { lapNumber: 4, lapTimeMs: null }], "motocross");
  assert.deepEqual(s.laps, [75_000, 60_000, 61_000]);
  assert.equal(s.firstCounted, 1);
  assert.equal(s.bestIndex, 1);
  assert.equal(sessionTakeaway(s), "Fastest on lap 2. Last lap was 1.0 s slower.");
  assert.equal(sessionSummary(laps(62_000, 60_000), null).firstCounted, 0);
});

test("a session's first crossing has no time: lap numbers stay real", () => {
  const s = sessionSummary(laps(null, 62_000, 61_100, 60_600, 61_400, 62_300), null);
  assert.deepEqual(s.lapNumbers, [2, 3, 4, 5, 6]);
  assert.equal(sessionTakeaway(s), "Fastest on lap 4. Last lap was 1.7 s slower.");
});

const session = (key: string, startedAt: string, ...ms: number[]): PracticeSession =>
  ({ key, label: key, startedAt, raceStyle: null, myLaps: laps(...ms) });

test("trend orders sessions by start time with best and average", () => {
  const t = sessionTrend([session("B", "2026-06-02T10:00:00Z", 61_000, 63_000), session("A", "2026-06-01T10:00:00Z", 64_000, 66_000)]);
  assert.deepEqual(t.map(x => [x.key, x.bestMs, x.avgMs]), [["A", 64_000, 65_000], ["B", 61_000, 62_000]]);
});

test("trend takeaways", () => {
  const pt = (bestMs: number) => ({ key: String(bestMs), label: "", bestMs, avgMs: bestMs, laps: 5 });
  assert.equal(trendTakeaway([pt(64_000), pt(62_000), pt(61_600)], "Example MX"), "New best at Example MX: 1:01.6, 2.4 s faster than your first session.");
  assert.equal(trendTakeaway([pt(64_000), pt(61_000), pt(62_000)], "X"), "Best lap down 3.0 s since your first session. Latest is 1.0 s off it.");
  assert.equal(trendTakeaway([pt(61_000), pt(63_000)], "X"), "Latest best is 2.0 s slower than your first session here.");
  assert.equal(trendTakeaway([pt(61_000), pt(61_050)], "X"), "Best laps steady at about 1:01.0.");
  assert.equal(trendTakeaway([pt(61_000)], "X"), null);
});
