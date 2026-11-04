// Run from scripts/: ./node_modules/.bin/tsx --test ../lib/rider-insights/src/season.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  finishTakeaway, lapSpreadMs, ordinal, paceTakeaway, pointsTakeaway, seasonClasses, seasonRounds,
  seasonYears, spreadTakeaway, type SeasonEvent, type SeasonRound,
} from "./season";

const moto = (position: number, laps: string[], winnerAvgLapMs: number | null, extra: Partial<SeasonEvent["motos"][number]> = {}) =>
  ({ position, dnf: false, dns: false, lapTimes: laps, points: 20, winnerAvgLapMs, ...extra });

const events: SeasonEvent[] = [
  { eventId: 2, eventName: "Snake River", eventDate: "2026-06-06", raceClass: "450 A", raceStyle: "motocross", totalPoints: 36,
    motos: [moto(5, ["2:10.0", "2:00.0", "2:02.0", "2:01.0"], 118000), moto(3, ["2:08.0", "1:59.0", "2:00.0", "2:00.0"], 118000)] },
  { eventId: 1, eventName: "Spring Thaw", eventDate: "2026-04-12", raceClass: "450 A", raceStyle: "motocross", totalPoints: 30,
    motos: [moto(6, ["2:10.0", "2:03.0", "2:06.0", "2:04.0"], 120000), moto(8, [], null, { dnf: true })] },
  { eventId: 3, eventName: "Old", eventDate: "2025-09-01", raceClass: "250 B", raceStyle: "motocross", totalPoints: 10, motos: [] },
  { eventId: 4, eventName: "Vet day", eventDate: "2026-05-01", raceClass: "Vet 30+", raceStyle: "motocross", totalPoints: 5, motos: [] },
];

test("years and classes", () => {
  assert.deepEqual(seasonYears(events), ["2026", "2025"]);
  assert.deepEqual(seasonClasses(events, "2026"), ["450 A", "Vet 30+"]);
});

test("rounds are chronological with averages, pace and spread", () => {
  const r = seasonRounds(events, "2026", "450 A");
  assert.deepEqual(r.map(x => x.eventName), ["Spring Thaw", "Snake River"]);
  assert.equal(r[0].avgFinish, 6); // the DNF moto is left out
  assert.equal(r[1].avgFinish, 4);
  // Spring Thaw: avg of 2:03, 2:06, 2:04 = 124.333 s vs the winner's 120 s → 3.6%.
  assert.equal(r[0].pacePct, 3.6);
  // Snake River: 121.0 s and 119.667 s vs 118 s → 2.5% and 1.4% → 2.0% (rounded from the mean).
  assert.equal(r[1].pacePct, 2);
  assert.equal(r[0].spreadMs, 3000);
  assert.equal(r[1].spreadMs, 1500);
});

test("lap spread ignores crash laps and needs 3 laps", () => {
  assert.equal(lapSpreadMs([120000, 121000, 180000, 122000]), 2000);
  assert.equal(lapSpreadMs([120000, 121000]), null);
});

const round = (name: string, avgFinish: number | null, points: number, pacePct: number | null, spreadMs: number | null): SeasonRound =>
  ({ eventId: 0, eventName: name, eventDate: "", avgFinish, points, pacePct, spreadMs });

test("finish takeaway", () => {
  assert.equal(finishTakeaway([round("A", 9, 0, null, null), round("B", 4, 0, null, null), round("C", 2, 0, null, null), round("D", 3.4, 0, null, null)]), "Top 5 in your last 3 races.");
  assert.equal(finishTakeaway([round("A", 6, 0, null, null), round("B", 4, 0, null, null)]), "Average finish improved from P6 to P4.");
  assert.equal(finishTakeaway([round("A", 4, 0, null, null), round("B", 7, 0, null, null)]), "Average finish slipped from P4 to P7.");
  assert.equal(finishTakeaway([round("A", 3.5, 0, null, null)]), "Averaged P4 at A.");
  assert.equal(finishTakeaway([]), null);
});

test("points takeaway, with and without a series", () => {
  const r = [round("Spring Thaw", 6, 30, null, null), round("Snake River", 4, 36, null, null)];
  assert.equal(pointsTakeaway(r), "66 points in 2 races. Best: 36 at Snake River.");
  assert.equal(pointsTakeaway(r, { seriesName: "Snake River Series", position: 3, totalPoints: 72 }), "3rd in Snake River Series with 72 series points.");
});

test("pace takeaway", () => {
  assert.equal(paceTakeaway([round("A", null, 0, 3.6, null), round("B", null, 0, 2.0, null)]), "2.0% off the winner's pace, your best this season.");
  assert.equal(paceTakeaway([round("A", null, 0, 1.5, null), round("B", null, 0, 2.4, null)]), "2.4% off the winner's pace. Best: 1.5% at A.");
  assert.equal(paceTakeaway([round("A", null, 0, 0, null)]), "Matched the winner's pace in your last race.");
});

test("spread takeaway", () => {
  assert.equal(spreadTakeaway([round("A", null, 0, null, 4100), round("B", null, 0, null, 1900)]), "Lap spread down from 4.1 s to 1.9 s. More consistent.");
  assert.equal(spreadTakeaway([round("A", null, 0, null, 2000)]), "Your laps were within 2.0 s of each other.");
});

test("ordinal", () => {
  assert.deepEqual([1, 2, 3, 4, 11, 12, 13, 21, 22].map(ordinal), ["1st", "2nd", "3rd", "4th", "11th", "12th", "13th", "21st", "22nd"]);
});
