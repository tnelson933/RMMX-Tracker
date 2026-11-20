/**
 * Whole-chain scoring scenarios: crossings → finishing order → moto points →
 * event overall → series standings, through the same pure functions the API
 * uses (lapScoring, motoPoints, the shared event overall, seriesStandingsCore).
 */
import assert from "node:assert/strict";
import test from "node:test";
import { compareStandings, computeFinishAt, scoreRider, type ScoringMoto } from "./lapScoring";
import { AMA_POINTS, compareOverall, olympicPenalty, overallPositions } from "./overallOrder";
import { motoNeedsScoringAfterPush, scoreMotoRows, scoringFormatChanged, type MotoScoringSettings } from "./motoPoints";
import { buildSeriesStandings, orderSeriesRounds, type SeriesMotoRow, type SeriesResultRow } from "./seriesStandingsCore";
import { buildEventOverall } from "../../../../lib/api-zod/src/eventOverall";

// The website's own overall ranking (Report tab, widgets). Loaded by path so
// this package's typecheck doesn't pull in the website's sources.
const { finishedMotoOrder, rankClassOverall } = await import(
  new URL("../../../race-platform/src/lib/classOverall.ts", import.meta.url).href
) as {
  finishedMotoOrder(motos: Array<Record<string, unknown>>, raceClass: string): number[];
  rankClassOverall<T>(rows: T[], lowerIsBetter: boolean, motoOrder?: number[]): Array<{ result: T; total: number; position: number }>;
};

const rules = { compareOverall, overallPositions, olympicPenalty };
const AMA: MotoScoringSettings = { scoringMethod: "fallback", pointsScale: [], scoringFormula: null, mainEventOnly: false };
const OLYMPIC: MotoScoringSettings = { scoringMethod: "lowest_positions", pointsScale: [], scoringFormula: null, mainEventOnly: false };
const SUPERCROSS: MotoScoringSettings = { scoringMethod: "highest_points", pointsScale: AMA_POINTS, scoringFormula: null, mainEventOnly: true };

type Row = SeriesResultRow & { id: number; lapTimes: number[]; bibNumber: string | null };
let nextId = 1;

/**
 * A finished moto's result rows from a finishing order. Entries: a rider id
 * (finished), or [riderId, "dnf" | "dns"] or [riderId, laps] for a lap count.
 */
function moto(
  motoId: number,
  raceClass: string,
  order: Array<number | [number, "dnf" | "dns" | number]>,
  settings: MotoScoringSettings,
  motoType = "heat",
): Row[] {
  const rows: Row[] = order.map((entry, i) => {
    const [riderId, flag] = Array.isArray(entry) ? entry : [entry, undefined];
    const laps = typeof flag === "number" ? flag : flag ? 0 : 5;
    return {
      id: nextId++, motoId, riderId, raceClass, position: i + 1, points: null,
      dnf: flag === "dnf", dns: flag === "dns",
      lapTimes: Array.from({ length: laps }, () => 60_000), bibNumber: String(riderId),
      firstName: `Rider`, lastName: String(riderId),
    };
  });
  const scored = scoreMotoRows(rows, settings, motoType);
  for (const r of rows) r.points = scored.get(r.id)!;
  return rows;
}

const overall = (motoIds: number[], rows: Row[], lowerIsBetter = false) =>
  buildEventOverall(motoIds, rows, lowerIsBetter, rules).classes;
const placing = (cls: { riders: Array<{ riderId: number; position: number; totalPoints: number }> }) =>
  cls.riders.map(r => `${r.position}:${r.riderId}=${r.totalPoints}`);

// ── A race: crossings to finishing order ─────────────────────────────────────

const start = new Date("2026-11-20T18:00:00Z");
const at = (s: number) => new Date(start.getTime() + s * 1000);

function finishOrder(m: ScoringMoto, crossings: Record<number, Date[]>): Array<{ riderId: number; laps: number }> {
  const finishAt = computeFinishAt(m, Object.values(crossings));
  return Object.entries(crossings)
    .map(([riderId, times]) => {
      const s = scoreRider(m, times, finishAt);
      return { riderId: Number(riderId), laps: s.lapTimes.length, totalMs: s.totalMs };
    })
    .sort(compareStandings)
    .map(({ riderId, laps }) => ({ riderId, laps }));
}

test("lap race with a lapped rider: positions, then AMA points in finishing order", () => {
  const m: ScoringMoto = { startedAt: start, lapCount: 3, timeLimitMs: null, plusLaps: null, timeExpiredAt: null };
  const order = finishOrder(m, {
    1: [at(60), at(120), at(180)],            // wins
    2: [at(62), at(124), at(186)],            // 2nd, same lap
    3: [at(95), at(190), at(285)],            // lapped: flagged at 190 with 2 laps; 285 is a cool-down lap
  });
  assert.deepEqual(order, [{ riderId: 1, laps: 3 }, { riderId: 2, laps: 3 }, { riderId: 3, laps: 2 }]);
  const rows = moto(1, "250 B", order.map(o => [o.riderId, o.laps] as [number, number]), AMA);
  assert.deepEqual(rows.map(r => r.points), [25, 22, 20]);
});

test("timed race + 1 extra lap: the leader at the flag takes one more lap, the rest finish on their next crossing", () => {
  const m: ScoringMoto = { startedAt: start, lapCount: null, timeLimitMs: 300_000, plusLaps: 1, timeExpiredAt: at(300) };
  const order = finishOrder(m, {
    1: [at(100), at(200), at(290), at(385), at(480)], // leader at the flag (3 laps); finishes at 385; 480 doesn't count
    2: [at(110), at(215), at(320), at(425)],           // 320 is before the leader's finish, so they finish at 425
    3: [at(150), at(310), at(470)],                    // a lap down: finishes at 470
  });
  assert.deepEqual(order, [{ riderId: 1, laps: 4 }, { riderId: 2, laps: 4 }, { riderId: 3, laps: 3 }]);
});

// ── Moto points ──────────────────────────────────────────────────────────────

test("DNF and DNS score 0 on a points table; the finishers behind a DNF are not affected", () => {
  const rows = moto(1, "250 B", [1, 2, 3, [4, "dnf"], [5, "dns"]], AMA);
  assert.deepEqual(rows.map(r => r.points), [25, 22, 20, 0, 0]);
});

test("Auto DNF: under 75% of the leader's laps scores 0 but keeps the position", () => {
  const settings = { ...AMA, autoDnfEnabled: true, autoDnfThreshold: 75 };
  const rows = moto(1, "250 B", [[1, 8], [2, 8], [3, 6], [4, 5]], settings);
  // 75% of 8 laps = 6: six laps still scores, five doesn't.
  assert.deepEqual(rows.map(r => r.points), [25, 22, 20, 0]);
  assert.deepEqual(rows.map(r => r.position), [1, 2, 3, 4]);
});

test("Supercross (main event only): heats score nothing, the main scores", () => {
  assert.deepEqual(moto(1, "450", [1, 2, 3], SUPERCROSS, "heat").map(r => r.points), [0, 0, 0]);
  assert.deepEqual(moto(2, "450", [2, 1, 3], SUPERCROSS, "main").map(r => r.points), [25, 22, 20]);
});

test("per-rider and formula tables scale with the starters, not the no-shows", () => {
  const perRider = { ...AMA, scoringMethod: "per_rider" };
  assert.deepEqual(moto(1, "65", [1, 2, 3, [4, "dns"]], perRider).map(r => r.points), [3, 2, 1, 0]);
  const formula = { ...AMA, scoringMethod: "formula", scoringFormula: "riders - position + 1" };
  assert.deepEqual(moto(2, "65", [1, 2, 3, [4, "dns"]], formula).map(r => r.points), [3, 2, 1, 0]);
});

// ── Event overall ────────────────────────────────────────────────────────────

test("two motos, tie on points: the better second moto wins the overall", () => {
  const rows = [...moto(1, "250 B", [1, 2, 3], AMA), ...moto(2, "250 B", [2, 1, 3], AMA)];
  const [cls] = overall([1, 2], rows);
  assert.deepEqual(placing(cls), ["1:2=47", "2:1=47", "3:3=40"]);
});

test("a missed second moto: the rider keeps moto 1's points and loses the tie", () => {
  const rows = [...moto(1, "250 B", [1, 2, 3], AMA), ...moto(2, "250 B", [3, 2], AMA)];
  const [cls] = overall([1, 2], rows);
  // 2: 22+22=44, 3: 20+25=45, 1: 25 (missed moto 2).
  assert.deepEqual(placing(cls), ["1:3=45", "2:2=44", "3:1=25"]);
});

test("a rider in two classes is scored separately in each", () => {
  const rows = [
    ...moto(1, "250 B", [1, 2], AMA), ...moto(2, "250 B", [1, 2], AMA),
    ...moto(3, "Open", [3, 1], AMA), ...moto(4, "Open", [1, 3], AMA),
  ];
  const classes = overall([1, 2, 3, 4], rows);
  assert.deepEqual(classes.map(c => c.raceClass), ["250 B", "Open"]);
  assert.deepEqual(placing(classes[0]), ["1:1=50", "2:2=44"]);
  assert.deepEqual(placing(classes[1]), ["1:1=47", "2:3=47"]); // tie: rider 1 won the last moto
});

test("Olympic: lowest total wins, DNF = 20, a missed moto = riders + 30, last moto breaks ties", () => {
  const rows = [
    ...moto(1, "85", [1, 2, 3, [4, "dnf"]], OLYMPIC),
    ...moto(2, "85", [2, 1, 4], OLYMPIC), // rider 3 misses moto 2
  ];
  assert.deepEqual(rows.slice(0, 4).map(r => r.points), [1, 2, 3, 20]);
  const [cls] = overall([1, 2], rows, true);
  // 1: 1+2=3, 2: 2+1=3 (won the last moto), 4: 20+3=23, 3: 3+(3 riders+30)=36.
  assert.deepEqual(placing(cls), ["1:2=3", "2:1=3", "3:4=23", "4:3=36"]);
});

test("a reopened and re-finished race is scored from its new order only", () => {
  const first = moto(1, "250 B", [1, 2, 3], AMA);
  // Reopened: a missed lap for rider 2 is added, they win; the same rows are re-scored.
  const reordered = [first[1], first[0], first[2]].map((r, i) => ({ ...r, position: i + 1 }));
  const scored = scoreMotoRows(reordered, AMA, "heat");
  assert.deepEqual(reordered.map(r => [r.riderId, scored.get(r.id)]), [[2, 25], [1, 22], [3, 20]]);
});

test("results edited after finalize: marking the winner DNF re-scores the moto and the overall", () => {
  const m1 = moto(1, "250 B", [1, 2, 3], AMA);
  // Review & finalize saves finishers 1..n, then the DNF (see race-platform lib/motoReview.ts).
  const m2 = moto(2, "250 B", [2, 3, [1, "dnf"]], AMA);
  assert.deepEqual(m2.map(r => r.points), [25, 22, 0]);
  const [cls] = overall([1, 2], [...m1, ...m2]);
  assert.deepEqual(placing(cls), ["1:2=47", "2:3=42", "3:1=25"]);
});

test("the website's overall (Report tab, widgets) matches the server's for the same results", () => {
  const cases: Array<{ rows: Row[]; ids: number[]; lower: boolean }> = [
    { rows: [...moto(1, "A", [1, 2, 3, [4, "dnf"]], AMA), ...moto(2, "A", [2, 1, 4], AMA)], ids: [1, 2], lower: false },
    { rows: [...moto(3, "A", [1, 2, 3, [4, "dnf"]], OLYMPIC), ...moto(4, "A", [2, 1, 4, [5, "dns"]], OLYMPIC)], ids: [3, 4], lower: true },
    // Supercross heats before the main: no points yet, ordered by best finish.
    { rows: [...moto(5, "A", [1, 2], SUPERCROSS, "heat"), ...moto(6, "A", [3, 4], SUPERCROSS, "heat")], ids: [5, 6], lower: false },
  ];
  for (const c of cases) {
    const server = overall(c.ids, c.rows, c.lower)[0].riders.map(r => `${r.position}:${r.riderId}=${r.totalPoints}`);
    const site = rankClassOverall(c.rows, c.lower, c.ids).map(e => `${e.position}:${e.result.riderId}=${e.total}`);
    assert.deepEqual(site.sort(), server.sort());
  }
});

test("the website counts finished races in running order and leaves practice out", () => {
  const motos = [
    { id: 9, motoNumber: 1, status: "completed", type: "practice", raceClass: "A" },
    { id: 8, motoNumber: 3, status: "completed", type: "heat", raceClass: "A" },
    { id: 7, motoNumber: 4, status: "in_progress", type: "heat", raceClass: "A" },
    { id: 12, motoNumber: 2, status: "completed", type: "heat", raceClass: "A" }, // created later, run earlier
    { id: 5, motoNumber: 1, status: "completed", type: "heat", raceClass: "B" },
  ];
  assert.deepEqual(finishedMotoOrder(motos, "A"), [12, 8]);
});

// ── Series ───────────────────────────────────────────────────────────────────

function season(rounds: Array<{ eventId: number; motos: Row[][] }>, scoring = AMA, finalized = true) {
  const motos: SeriesMotoRow[] = [];
  const results: SeriesResultRow[] = [];
  for (const round of rounds) {
    round.motos.forEach((rows, i) => {
      motos.push({ id: rows[0].motoId, eventId: round.eventId, type: "heat", raceClass: rows[0].raceClass, motoNumber: i + 1, resultsFinalizedAt: finalized ? new Date() : null });
      results.push(...rows);
    });
  }
  return buildSeriesStandings({
    eventIds: rounds.map(r => r.eventId),
    eventNames: new Map(rounds.map(r => [r.eventId, `Round ${r.eventId}`])),
    eligibleClasses: new Map(rounds.map(r => [r.eventId, null])),
    motos,
    results,
    scoring,
  });
}
const table = (rows: Array<{ position: number; riderId: number; totalScore: number }>) =>
  rows.map(r => `${r.position}:${r.riderId}=${r.totalScore}`);

test("series over three rounds: totals add up, a missed round scores nothing and shows as not attended", () => {
  const standings = season([
    { eventId: 1, motos: [moto(101, "250 B", [1, 2, 3], AMA), moto(102, "250 B", [1, 2, 3], AMA)] },
    { eventId: 2, motos: [moto(201, "250 B", [2, 3], AMA), moto(202, "250 B", [2, 3], AMA)] }, // rider 1 away
    { eventId: 3, motos: [moto(301, "250 B", [1, 2, 3], AMA), moto(302, "250 B", [3, 1, 2], AMA)] },
  ]);
  // 2: 44+50+42=136, 3: 40+44+45=129, 1: 50+0+47=97.
  assert.deepEqual(table(standings), ["1:2=136", "2:3=129", "3:1=97"]);
  const rider1 = standings.find(s => s.riderId === 1)!;
  assert.equal(rider1.eventsEntered, 2);
  assert.deepEqual(rider1.events.map(e => e.attended), [true, false, true]);
});

test("series tie: most moto wins first, then 2nds, then the final moto of the last round", () => {
  // Riders 1 and 2 swap 1st/2nd evenly (two wins each); rider 2 wins the very last moto.
  const standings = season([
    { eventId: 1, motos: [moto(101, "250 B", [1, 2], AMA), moto(102, "250 B", [2, 1], AMA)] },
    { eventId: 2, motos: [moto(201, "250 B", [1, 2], AMA), moto(202, "250 B", [2, 1], AMA)] },
  ]);
  assert.deepEqual(table(standings), ["1:2=94", "2:1=94"]);
  // More wins beats a better last moto: 1-1-3 (70) vs 2-2-1... make totals equal with a custom scale.
  const scale: MotoScoringSettings = { scoringMethod: "highest_points", pointsScale: [10, 7, 4], scoringFormula: null, mainEventOnly: false };
  const byWins = season([
    { eventId: 1, motos: [moto(301, "A", [1, 2, 3], scale), moto(302, "A", [1, 3, 2], scale)] },   // 1: 20, 2: 11, 3: 11
    { eventId: 2, motos: [moto(401, "A", [3, 2, 1], scale), moto(402, "A", [2, 3, 1], scale)] },   // 1: 8, 2: 17, 3: 17
  ], scale);
  // All on 28. Rider 1 has two wins; riders 2 and 3 one win each, rider 2 has two 2nds to rider 3's one.
  assert.deepEqual(table(byWins), ["1:1=28", "2:2=28", "3:3=28"]);
});

test("series rounds run in date order, however the events were added to the series", () => {
  // Round 2's event was created (and listed) before round 1's.
  assert.deepEqual(orderSeriesRounds([
    { id: 5, date: "2026-06-20" }, { id: 9, date: "2026-05-02" }, { id: 7, date: "2026-05-02" },
  ]), [7, 9, 5]);
  // Equal totals, equal count-back: the final moto of the LAST round decides.
  const may = { eventId: 9, motos: [moto(901, "A", [1, 2], AMA), moto(902, "A", [2, 1], AMA)] };
  const june = { eventId: 5, motos: [moto(501, "A", [2, 1], AMA), moto(502, "A", [1, 2], AMA)] };
  const dated = orderSeriesRounds([{ id: 5, date: "2026-06-20" }, { id: 9, date: "2026-05-02" }]);
  const rounds = dated.map(id => (id === 9 ? may : june));
  assert.deepEqual(table(season(rounds)), ["1:1=94", "2:2=94"]); // rider 1 won June's last moto
  // In listed order (June first) May's last moto would have decided it the other way.
  assert.deepEqual(table(season([june, may])), ["1:2=94", "2:1=94"]);
});

test("Olympic series: lowest total wins, a missed moto is a DNS, non-finishers rank last", () => {
  const standings = season([
    { eventId: 1, motos: [moto(101, "85", [1, 2, 3], OLYMPIC), moto(102, "85", [2, 1, 3], OLYMPIC)] },
    { eventId: 2, motos: [moto(201, "85", [1, 2], OLYMPIC)] }, // rider 3 misses round 2
  ], OLYMPIC);
  // 1: 1+2+1=4, 2: 2+1+2=5, 3: 3+3+(2 riders+30)=38.
  assert.deepEqual(table(standings), ["1:1=4", "2:2=5", "3:3=38"]);
  assert.ok(standings.every(s => s.lowerIsBetter));
});

test("series standings are unofficial until every counted race is finalized", () => {
  const rounds = [{ eventId: 1, motos: [moto(101, "A", [1, 2], AMA)] }];
  assert.equal(season(rounds, AMA, false)[0].official, false);
  assert.equal(season(rounds, AMA, true)[0].official, true);
});

test("results uploaded from the desktop with no points are scored once the race is finished", () => {
  assert.equal(motoNeedsScoringAfterPush({ type: "heat", status: "completed" }), true);
  assert.equal(motoNeedsScoringAfterPush({ type: "main", status: "completed" }), true);
  assert.equal(motoNeedsScoringAfterPush({ type: "enduro_test", status: "completed" }), true);
  assert.equal(motoNeedsScoringAfterPush({ type: "heat", status: "in_progress" }), false);
  assert.equal(motoNeedsScoringAfterPush({ type: "practice", status: "completed" }), false);
  assert.equal(motoNeedsScoringAfterPush(undefined), false);
  // Uploaded rows carry no points: before scoring the overall has none to rank by.
  const uploaded = moto(1, "A", [1, 2, 3], AMA).map(r => ({ ...r, points: null }));
  assert.equal(buildEventOverall([1], uploaded, false, rules).hasPoints, false);
  const scored = scoreMotoRows(uploaded, AMA, "heat");
  assert.deepEqual(uploaded.map(r => scored.get(r.id)), [25, 22, 20]);
});

test("changing an event's Scoring Format is noticed (so its finished races are re-scored)", () => {
  assert.equal(scoringFormatChanged(null, 4), true);
  assert.equal(scoringFormatChanged(4, 7), true);
  assert.equal(scoringFormatChanged(4, null), true);
  assert.equal(scoringFormatChanged(4, "4"), false);
  assert.equal(scoringFormatChanged(null, ""), false);
  assert.equal(scoringFormatChanged(undefined, null), false);
});
