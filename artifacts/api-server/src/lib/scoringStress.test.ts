// Scoring stress test: the owner's edge-case datasets (3-way series ties, a
// 25-rider gate for Olympic penalties, the 21st-place floor, DNF vs DNS
// tie-breaks, Supercross DNQ vs main-event DNF, Auto DNF rounding), run through
// the real engine: moto points (motoPoints.ts), event overall
// (@workspace/api-zod eventOverall) and series standings (seriesStandingsCore.ts).
import assert from "node:assert/strict";
import test from "node:test";
import { buildEventOverall } from "@workspace/api-zod";
import { scoreMotoRows, type MotoScoringSettings } from "./motoPoints";
import { AMA_POINTS, compareOverall, olympicPenalty, overallPositions } from "./overallOrder";
import { buildSeriesStandings, type SeriesMotoRow, type SeriesResultRow } from "./seriesStandingsCore";

const NAMES: Record<number, string> = { 10: "Alex", 20: "Blake", 30: "Casey", 40: "Drew", 50: "Eli", 60: "Finn" };
const FILLERS = Array.from({ length: 19 }, (_, i) => 101 + i); // #101–#119
const nameOf = (bib: number) => NAMES[bib] ?? `Filler${bib}`;

type Entry = { bib: number; dnf?: boolean; dns?: boolean; laps?: number };
/** A moto as finishing order: finishers, then DNFs, then DNSs (positions follow the list). */
interface Moto { id: number; eventId: number; type: string; motoNumber: number; order: Entry[] }

const fin = (...bibs: number[]): Entry[] => bibs.map(bib => ({ bib, laps: 5 }));

// ── Dataset A: 250 A, three rounds ───────────────────────────────────────────
const A: Moto[] = [
  { id: 1, eventId: 1, type: "heat", motoNumber: 1, order: [...fin(10, 20, 30, 40), { bib: 50, dnf: true, laps: 3 }, { bib: 60, dns: true, laps: 0 }] },
  { id: 2, eventId: 1, type: "heat", motoNumber: 2, order: [...fin(20, 30, 10, 40), { bib: 60, dnf: true, laps: 2 }, { bib: 50, dns: true, laps: 0 }] },
  { id: 3, eventId: 2, type: "heat", motoNumber: 1, order: [...fin(30, 10, 20, 40), { bib: 50, dnf: true, laps: 4 }, { bib: 60, dnf: true, laps: 1 }] },
  { id: 4, eventId: 2, type: "heat", motoNumber: 2, order: [...fin(10, 20, 30, 40), { bib: 60, dnf: true, laps: 3 }, { bib: 50, dnf: true, laps: 2 }] },
  { id: 5, eventId: 3, type: "heat", motoNumber: 1, order: [...fin(20, 30, 10, 40), ...fin(...FILLERS), { bib: 50, dnf: true, laps: 4 }, { bib: 60, dns: true, laps: 0 }] },
  { id: 6, eventId: 3, type: "heat", motoNumber: 2, order: [...fin(30, 10, 20, 40), ...fin(...FILLERS), ...fin(50), { bib: 60, dnf: true, laps: 3 }] },
];

const AMA: MotoScoringSettings = { scoringMethod: "highest_points", pointsScale: AMA_POINTS, scoringFormula: null, mainEventOnly: false };
const OLYMPIC: MotoScoringSettings = { scoringMethod: "lowest_positions", pointsScale: [], scoringFormula: null, mainEventOnly: false };
const PER_RIDER: MotoScoringSettings = { scoringMethod: "per_rider", pointsScale: [], scoringFormula: null, mainEventOnly: false };

/** Points per bib for one moto under a scoring table. */
function motoPoints(m: Moto, s: MotoScoringSettings): Map<number, number> {
  const rows = m.order.map((e, i) => ({ id: e.bib, position: i + 1, dnf: !!e.dnf, dns: !!e.dns, lapTimes: Array(e.laps ?? 0).fill(60_000) }));
  return scoreMotoRows(rows, s, m.type);
}

function results(motos: Moto[], s: MotoScoringSettings, raceClass = "250 A"): SeriesResultRow[] {
  return motos.flatMap(m => {
    const pts = motoPoints(m, s);
    return m.order.map((e, i) => ({
      motoId: m.id, riderId: e.bib, firstName: nameOf(e.bib), lastName: "", position: i + 1,
      points: pts.get(e.bib) ?? null, dnf: !!e.dnf, dns: !!e.dns, raceClass,
    }));
  });
}

function series(motos: Moto[], s: MotoScoringSettings) {
  const seriesMotos: SeriesMotoRow[] = motos.map(m => ({ id: m.id, eventId: m.eventId, type: m.type, raceClass: "250 A", motoNumber: m.motoNumber, resultsFinalizedAt: new Date() }));
  return buildSeriesStandings({
    eventIds: [1, 2, 3], eventNames: new Map([[1, "R1"], [2, "R2"], [3, "R3"]]),
    eligibleClasses: new Map([[1, null], [2, null], [3, null]]),
    motos: seriesMotos, results: results(motos, s), scoring: s,
  });
}

const rules = { compareOverall, overallPositions, olympicPenalty };
function eventOverall(motos: Moto[], s: MotoScoringSettings, lowerIsBetter: boolean) {
  const rows = results(motos, s).map(r => ({ ...r, bibNumber: String(r.riderId) }));
  // As the servers call it: the event's main-event races are passed in.
  return buildEventOverall(motos.map(m => m.id), rows, lowerIsBetter, rules, motos.filter(m => m.type === "main").map(m => m.id)).classes[0].riders;
}

// ── 1. AMA scale ─────────────────────────────────────────────────────────────
test("AMA: 25-22-20-18-17 scale, 21st = 1, 22nd and lower score 0 (never negative)", () => {
  assert.deepEqual(AMA_POINTS.slice(0, 5), [25, 22, 20, 18, 17]);
  const m6 = motoPoints(A[5], AMA);
  assert.equal(m6.get(50), 0); // R3 Moto 2: Eli finished 24th
  for (const p of m6.values()) assert.ok(p >= 0);
});

test("AMA series: 3-way tie on points and on 1st/2nd/3rd counts goes to the final moto of the last round", () => {
  const s = series(A, AMA);
  const top = s.slice(0, 3);
  assert.deepEqual(top.map(r => r.totalScore), [134, 134, 134]);
  assert.deepEqual(top.map(r => r.riderName), ["Casey", "Alex", "Blake"]);
  assert.deepEqual(top.map(r => r.position), [1, 2, 3]);
});

test("AMA round 1: 0-point tie, [DNS, DNF] (Finn) beats [DNF, DNS] (Eli): DNF beats DNS in the last moto", () => {
  const r1 = eventOverall(A.slice(0, 2), AMA, false);
  const finn = r1.find(r => r.riderId === 60)!;
  const eli = r1.find(r => r.riderId === 50)!;
  assert.equal(finn.totalPoints, 0); assert.equal(eli.totalPoints, 0);
  assert.ok(finn.position < eli.position, `Finn ${finn.position} should be ahead of Eli ${eli.position}`);
});

test("[DNF, DNS] and [DNS, DNF] both beat [DNS, DNS]", () => {
  const x = (o: Entry[], id: number): Moto => ({ id, eventId: 9, type: "heat", motoNumber: id, order: o });
  const motos = [
    x([...fin(1), { bib: 50, dnf: true, laps: 1 }, { bib: 60, dns: true }, { bib: 70, dns: true }], 91),
    x([...fin(1), { bib: 60, dnf: true, laps: 1 }, { bib: 50, dns: true }, { bib: 70, dns: true }], 92),
  ];
  const order = eventOverall(motos, AMA, false).map(r => r.riderId);
  assert.deepEqual(order, [1, 60, 50, 70]);
});

// ── 2. Olympic ───────────────────────────────────────────────────────────────
test("Olympic series: all three on 12, tie-break ranks Casey, Alex, Blake", () => {
  const s = series(A, OLYMPIC);
  const top = s.slice(0, 3);
  assert.deepEqual(top.map(r => r.totalScore), [12, 12, 12]);
  assert.deepEqual(top.map(r => r.riderName), ["Casey", "Alex", "Blake"]);
});

test("Olympic R3 Moto 1 (24 starters): DNF = 24 (starters, > 20), DNS = 24 + 30 = 54", () => {
  const m5 = motoPoints(A[4], OLYMPIC);
  assert.equal(m5.get(50), 24);
  assert.equal(m5.get(60), 54);
});

test("Olympic R3 Moto 2 (25 starters): DNF = 25", () => {
  assert.equal(motoPoints(A[5], OLYMPIC).get(60), 25);
});

test("Olympic series uses the same per-moto penalties as the moto scores", () => {
  const finn = series(A, OLYMPIC).find(r => r.riderId === 60)!;
  const r3 = finn.events.find(e => e.eventId === 3)!;
  assert.deepEqual(r3.motos, [54, 25]);
});

// ── 3. Per rider ─────────────────────────────────────────────────────────────
test("Per rider R3 Moto 1 (24 starters): 1st = 24, DNF = 0, DNS = 0", () => {
  const m5 = motoPoints(A[4], PER_RIDER);
  assert.equal(m5.get(20), 24); assert.equal(m5.get(50), 0); assert.equal(m5.get(60), 0);
});

test("Per rider R3 Moto 2 (25 starters): 1st = 25, 24th = 2, DNF = 0", () => {
  const m6 = motoPoints(A[5], PER_RIDER);
  assert.equal(m6.get(30), 25); assert.equal(m6.get(50), 2); assert.equal(m6.get(60), 0);
});

// ── 4. Supercross (main event only) ──────────────────────────────────────────
test("Supercross: a main-event DNF ranks ahead of riders who didn't make the main", () => {
  const SX: MotoScoringSettings = { ...AMA, mainEventOnly: true };
  const motos: Moto[] = [
    { id: 21, eventId: 7, type: "heat", motoNumber: 1, order: fin(10, 20, 30) },
    { id: 22, eventId: 7, type: "heat", motoNumber: 2, order: fin(40, 50, 60) },
    { id: 23, eventId: 7, type: "main", motoNumber: 3, order: [...fin(40, 10, 20), { bib: 50, dnf: true, laps: 2 }] },
  ];
  const o = eventOverall(motos, SX, false);
  const pos = (bib: number) => o.find(r => r.riderId === bib)!.position;
  assert.deepEqual([pos(40), pos(10), pos(20), pos(50)], [1, 2, 3, 4]);
  assert.equal(o.find(r => r.riderId === 50)!.totalPoints, 0);
  assert.equal(pos(30), 5); assert.equal(pos(60), 5); // DNQ: tied 5th
});

// ── 5. Auto DNF ──────────────────────────────────────────────────────────────
test("Auto DNF 75% of a 7-lap race: 5.25 rounds UP to 6 laps; Casey (5) scores 0 but keeps 3rd ahead of Drew", () => {
  const AUTO: MotoScoringSettings = { ...AMA, autoDnfEnabled: true, autoDnfThreshold: 75 };
  const m: Moto = { id: 31, eventId: 8, type: "heat", motoNumber: 1, order: [
    { bib: 10, laps: 7 }, { bib: 20, laps: 6 }, { bib: 30, laps: 5 }, { bib: 40, laps: 4 },
  ] };
  const pts = motoPoints(m, AUTO);
  assert.deepEqual([pts.get(10), pts.get(20), pts.get(30), pts.get(40)], [25, 22, 0, 0]);
  const o = eventOverall([m], AUTO, false);
  assert.deepEqual(o.map(r => r.riderId), [10, 20, 30, 40]);
});
