/**
 * Rules added 2026-11-20: a race must be scored like its series, combined
 * starts, change-only results notifications, and a rider's best series.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { AMA_POINTS } from "./overallOrder";
import { scoreMotoRows, scoringStylesMatch, type ScoringStyle } from "./motoPoints";
import { fingerprintsByRider, resultsFingerprint, ridersToNotify } from "./resultsNotifyCore";
import { riderSeriesEntries, sortRiderSeries } from "./riderSeriesCore";
import { buildSeriesStandings } from "./seriesStandingsCore";
import { combineProblem, motoRounds, planCombinedStarts, type CombineCandidate } from "../../../../lib/api-zod/src/combinedStarts";

// ── A race must be scored like the series it counts toward ───────────────────

const style = (scoringMethod: string, pointsScale: number[] = [], extra: Partial<ScoringStyle> = {}): ScoringStyle =>
  ({ scoringMethod, pointsScale, scoringFormula: null, mainEventOnly: false, ...extra });

test("scoring styles match only when every finish would score the same", () => {
  const none = style("fallback");
  // No table is the AMA scale: it matches a Highest Points table holding that scale.
  assert.equal(scoringStylesMatch(none, style("highest_points", AMA_POINTS)), true);
  assert.equal(scoringStylesMatch(none, style("highest_points", [...AMA_POINTS, 0, 0])), true);
  assert.equal(scoringStylesMatch(none, none), true);
  // Olympic against a points series: the mismatch that ranked a series upside-down.
  assert.equal(scoringStylesMatch(style("lowest_positions"), none), false);
  assert.equal(scoringStylesMatch(style("lowest_positions"), style("highest_points", AMA_POINTS)), false);
  // Same method, different points.
  assert.equal(scoringStylesMatch(style("highest_points", [25, 20, 16]), style("highest_points", [25, 22, 20])), false);
  // Supercross (main event only) against the same scale scoring every moto.
  assert.equal(scoringStylesMatch(style("highest_points", AMA_POINTS, { mainEventOnly: true }), none), false);
  assert.equal(scoringStylesMatch(style("per_rider"), style("per_rider", [1, 2, 3])), true); // the scale isn't used
  assert.equal(scoringStylesMatch(style("per_rider"), none), false);
  assert.equal(scoringStylesMatch(style("formula", [], { scoringFormula: "riders - position + 1" }), style("formula", [], { scoringFormula: "riders-position+1" })), true);
  assert.equal(scoringStylesMatch(style("formula", [], { scoringFormula: "100 / position" }), style("formula", [], { scoringFormula: "riders - position" })), false);
});

test("the desktop's copy of the scoring-style rule and message matches the website's", () => {
  const cloud = readFileSync(new URL("./motoPoints.ts", import.meta.url), "utf8");
  const local = readFileSync(new URL("../../../local-server/src/lib/scoringStyle.ts", import.meta.url), "utf8");
  const body = (src: string) => src.slice(src.indexOf("const norm = (s: ScoringStyle)"), src.indexOf("return norm(a) === norm(b);"))
    .replace(/FALLBACK_POINTS/g, "AMA_POINTS");
  assert.ok(body(cloud).length > 100);
  assert.equal(body(local), body(cloud));
  const message = (path: string) => /SCORING_STYLE_MISMATCH =\s*"([^"]+)"/.exec(readFileSync(new URL(path, import.meta.url), "utf8"))?.[1];
  assert.equal(message("../../../local-server/src/lib/scoringStyle.ts"), message("./seriesScoringMatch.ts"));
  assert.equal(message("./seriesScoringMatch.ts"),
    "This points scoring style does not match the series you have selected. Please update the points scoring style or remove the series this race is tied to.");
});

// ── Combined starts ──────────────────────────────────────────────────────────

let nextRider = 1;
const cand = (id: number, raceClass: string, riders: number, motoNumber: number, extra: Partial<CombineCandidate> = {}): CombineCandidate => ({
  id, raceClass, type: "heat", motoNumber, status: "scheduled", grouped: false,
  riderIds: Array.from({ length: riders }, () => nextRider++), ...extra,
});

test("combine starts for smaller classes: two classes of 6 share a 15-spot gate; a full class runs alone", () => {
  const motos = [cand(1, "65", 6, 1), cand(2, "85", 6, 2), cand(3, "250 B", 14, 3), cand(4, "Vet", 4, 4)];
  // 65 + 85 = 12 riders; Vet's 4 would make 16, so Vet has nobody to pair with.
  assert.deepEqual(planCombinedStarts(motos, 15), [[1, 2]]);
  // 16 spots: all three small classes fit together.
  assert.deepEqual(planCombinedStarts(motos, 16), [[1, 2, 4]]);
  assert.deepEqual(planCombinedStarts(motos, 5), []);
});

test("combined starts pair Moto 1s with Moto 1s, never a class with itself or a race already run or grouped", () => {
  const motos = [
    cand(1, "65", 5, 1), cand(2, "85", 5, 2),
    cand(3, "65", 5, 3), cand(4, "85", 5, 4),
    cand(5, "Vet", 4, 5, { status: "completed" }), cand(6, "Mini", 3, 6, { grouped: true }),
  ];
  assert.deepEqual(planCombinedStarts(motos, 15), [[1, 2], [3, 4]]);
  assert.deepEqual([...motoRounds(motos)].slice(0, 4), [[1, 1], [2, 1], [3, 2], [4, 2]]);
});

test("a rider entered in both classes keeps them apart", () => {
  const a = cand(1, "250 B", 5, 1);
  const b = cand(2, "Open", 5, 2, { riderIds: [a.riderIds[0], 901, 902] });
  assert.deepEqual(planCombinedStarts([a, b], 20), []);
  assert.match(combineProblem([a, b]) ?? "", /entered in both 250 B and Open/);
  const c = cand(3, "Vet", 5, 3);
  assert.equal(combineProblem([a, c]), null);
  assert.match(combineProblem([a, c], 8) ?? "", /10 riders together, more than the 8 gate spots/);
  assert.match(combineProblem([a, { ...c, status: "in_progress" }]) ?? "", /haven't started/);
  assert.match(combineProblem([a, { ...c, type: "practice" }]) ?? "", /Practice/);
});

test("classes that share a gate are still scored separately", () => {
  // 65 and 85 race together; overall across the line is 85#1, 65#1, 85#2, 65#2. Each class has its own moto.
  const settings = { scoringMethod: "fallback", pointsScale: [], scoringFormula: null, mainEventOnly: false };
  const row = (id: number, position: number) => ({ id, position, dnf: false, dns: false, lapTimes: [1, 2, 3] });
  const c65 = scoreMotoRows([row(1, 1), row(2, 2)], settings, "heat");
  const c85 = scoreMotoRows([row(3, 1), row(4, 2)], settings, "heat");
  assert.deepEqual([c65.get(1), c65.get(2), c85.get(3), c85.get(4)], [25, 22, 25, 22]);
});

// ── Results notifications: only riders whose results changed hear again ──────

const res = (riderId: number, motoId: number, position: number, lapTimes: number[], extra: Record<string, unknown> = {}) =>
  ({ riderId, motoId, position, dnf: false, dns: false, lapTimes, ...extra });

test("first finalize tells everyone; a re-finalize tells only riders whose place or laps changed", () => {
  const first = [res(1, 10, 1, [60000, 61000]), res(2, 10, 2, [62000, 63000]), res(3, 10, 3, [64000, 65000])];
  const sentNothing = new Map<number, string>();
  const before = fingerprintsByRider(first);
  assert.deepEqual(ridersToNotify(before, sentNothing), { first: [1, 2, 3], changed: [] });

  // Nothing edited, finalized again: nobody.
  assert.deepEqual(ridersToNotify(fingerprintsByRider(first), before), { first: [], changed: [] });

  // Riders 2 and 3 swap places; rider 1 is untouched.
  const swapped = [first[0], { ...first[1], position: 3 }, { ...first[2], position: 2 }];
  assert.deepEqual(ridersToNotify(fingerprintsByRider(swapped), before), { first: [], changed: [2, 3] });

  // One lap time corrected for rider 1 only.
  const lapFixed = [{ ...first[0], lapTimes: [60000, 60500] }, first[1], first[2]];
  assert.deepEqual(ridersToNotify(fingerprintsByRider(lapFixed), before), { first: [], changed: [1] });

  // A rider added to the results afterwards hears for the first time.
  assert.deepEqual(ridersToNotify(fingerprintsByRider([...first, res(4, 10, 4, [70000])]), before), { first: [4], changed: [] });
});

test("points alone don't count as a change; a DNF mark does; row order doesn't matter", () => {
  const a = [res(1, 10, 1, [60000]), res(1, 11, 2, [61000])];
  assert.equal(resultsFingerprint([a[1], a[0]]), resultsFingerprint(a));
  assert.equal(resultsFingerprint(a.map(r => ({ ...r, points: 99 }))), resultsFingerprint(a));
  assert.notEqual(resultsFingerprint([{ ...a[0], dnf: true }, a[1]]), resultsFingerprint(a));
});

// ── The rider app: the series a rider ranks highest in ───────────────────────

function standings(motoOrders: number[][], cls = "250 B") {
  const settings = { scoringMethod: "fallback", pointsScale: [], scoringFormula: null, mainEventOnly: false };
  let id = 1;
  const motos = motoOrders.map((_, i) => ({ id: i + 1, eventId: Math.floor(i / 2) + 1, type: "heat", raceClass: cls, motoNumber: (i % 2) + 1, resultsFinalizedAt: new Date() }));
  const results = motoOrders.flatMap((order, i) => {
    const rows = order.map((riderId, p) => ({ id: id++, motoId: i + 1, riderId, firstName: "R", lastName: String(riderId), position: p + 1, points: null as number | null, dnf: false, dns: false, raceClass: cls, lapTimes: [1] }));
    const scored = scoreMotoRows(rows, settings, "heat");
    for (const r of rows) r.points = scored.get(r.id)!;
    return rows;
  });
  const eventIds = [...new Set(motos.map(m => m.eventId))];
  return buildSeriesStandings({ eventIds, eventNames: new Map(eventIds.map(e => [e, `Round ${e}`])), eligibleClasses: new Map(eventIds.map(e => [e, null])), motos, results, scoring: settings });
}

test("a rider's series entry carries place, points and stats from the official standings", () => {
  // Rider 7: 2nd, 1st, then away for round 2.
  const rows = standings([[1, 7, 3], [7, 1, 3], [1, 3], [3, 1]]);
  const [entry] = riderSeriesEntries({ id: 5, name: "Summer Series", season: 2026, eventIds: [1, 2] }, rows, [7]);
  assert.equal(entry.seriesName, "Summer Series");
  assert.equal(entry.totalPoints, 47);
  assert.equal(entry.position, 3);          // 1: 94, 3: 87, 7: 47
  assert.equal(entry.ridersInClass, 3);
  assert.deepEqual([entry.wins, entry.podiums, entry.motosFinished, entry.bestFinish], [1, 2, 2, 1]);
  assert.deepEqual([entry.roundsRaced, entry.roundsRun], [1, 2]);
  assert.equal(entry.gapToLeader, 47);
  assert.equal(riderSeriesEntries({ id: 5, name: "x", season: null, eventIds: [] }, rows, [99]).length, 0);
});

test("the tiles show the series the rider ranks highest in; 2nd of 30 beats 2nd of 3", () => {
  const entry = (seriesName: string, position: number, ridersInClass: number) =>
    ({ seriesId: 1, seriesName, season: 2026, eventIds: [], raceClass: "A", riderId: 7, riderName: "R", totalPoints: 10, position, ridersInClass,
      lowerIsBetter: false, official: true, wins: 0, podiums: 0, motosFinished: 0, bestFinish: null, roundsRaced: 1, roundsRun: 1, gapToLeader: 0 });
  const sorted = sortRiderSeries([entry("Club", 4, 20), entry("Small", 2, 3), entry("State", 2, 30), entry("Regional", 9, 40)]);
  assert.deepEqual(sorted.map(e => e.seriesName), ["State", "Small", "Club", "Regional"]);
});

// ── Desktop uploads: a complete finishing order is kept as sent ──────────────

test("a complete order from the desktop is kept; an unfinished one is worked out again", async () => {
  const { positionsNeedSorting } = await import("./motoPoints");
  assert.equal(positionsNeedSorting([1, 2, 3, 4]), false);
  assert.equal(positionsNeedSorting([3, 1, 2]), false);        // any row order
  assert.equal(positionsNeedSorting([]), false);
  assert.equal(positionsNeedSorting([1, 2, 999]), true);       // live timing's placeholder
  assert.equal(positionsNeedSorting([1, 2, 2]), true);         // a repeated place
  assert.equal(positionsNeedSorting([1, 3, 4]), true);         // a gap
});
