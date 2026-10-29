import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { AMA_POINTS, compareOverall, countFinishes, olympicPenalty, overallPositions } from "./overallOrder";

// The offline server and the website keep copies of the overall-order rules.
test("the desktop and website copies of the overall-order rules match the cloud's", () => {
  const cloud = readFileSync(new URL("./overallOrder.ts", import.meta.url), "utf8");
  for (const path of ["../../../local-server/src/lib/overallOrder.ts", "../../../race-platform/src/lib/overallOrder.ts"]) {
    const copy = readFileSync(new URL(path, import.meta.url), "utf8");
    // Each copy adds a 2-line note at the top.
    assert.equal(copy.split("\n").slice(2).join("\n"), cloud, path);
  }
});

test("Olympic penalties follow the AMA amateur rules", () => {
  assert.equal(olympicPenalty("dnf", 12), 20);  // never less than 20
  assert.equal(olympicPenalty("dnf", 35), 35);  // riders in the class
  assert.equal(olympicPenalty("dns", 12), 42);  // riders + 30
});

test("Olympic overall: lowest total wins, ties go to the better last-moto finish, finishers first", () => {
  const rows = [
    { name: "A", total: 4, finishedAny: true, lastMotoFinish: 3 },  // 1-3
    { name: "B", total: 4, finishedAny: true, lastMotoFinish: 1 },  // 3-1
    { name: "C", total: 2, finishedAny: true, lastMotoFinish: 1 },  // 1-1
    { name: "D", total: 0, finishedAny: false, lastMotoFinish: null },
  ];
  const sorted = [...rows].sort((a, b) => compareOverall(a, b, true));
  assert.deepEqual(sorted.map(r => r.name), ["C", "B", "A", "D"]);
  assert.deepEqual(overallPositions(sorted, true), [1, 2, 3, 4]);
  const points = [{ total: 47, finishedAny: true, lastMotoFinish: 1 }, { total: 50, finishedAny: true, lastMotoFinish: 2 }];
  assert.deepEqual([...points].sort((a, b) => compareOverall(a, b, false)).map(r => r.total), [50, 47]);
});

test("AMA scale (Pro Motocross and Supercross since 2024)", () => {
  assert.deepEqual(AMA_POINTS.slice(0, 7), [25, 22, 20, 18, 17, 16, 15]);
  assert.equal(AMA_POINTS.length, 21);
  assert.equal(AMA_POINTS[20], 1);   // 21st
  assert.equal(AMA_POINTS[21], undefined); // 22nd scores nothing
});

test("points ties: event overall goes to the last moto; series count-back goes to most wins first", () => {
  // Event overall: 1-3 vs 3-1, both 45 points: the better last moto wins.
  const a = { total: 45, finishedAny: true, lastMotoFinish: 3 };
  const b = { total: 45, finishedAny: true, lastMotoFinish: 1 };
  assert.ok(compareOverall(b, a, false) < 0);
  // Series: equal totals, one rider has more wins even with a worse last moto.
  const wins2 = { total: 100, finishedAny: true, lastMotoFinish: 5, finishCounts: countFinishes([1, 1, 5, 5]) };
  const wins1 = { total: 100, finishedAny: true, lastMotoFinish: 1, finishCounts: countFinishes([2, 2, 2, 1]) };
  assert.ok(compareOverall(wins2, wins1, false) < 0);
  // Same wins: more 2nds.
  const s1 = { total: 90, finishedAny: true, lastMotoFinish: 4, finishCounts: countFinishes([1, 2, 2, 4]) };
  const s2 = { total: 90, finishedAny: true, lastMotoFinish: 2, finishCounts: countFinishes([1, 3, 3, 2]) };
  assert.ok(compareOverall(s1, s2, false) < 0); // one win each; s1 has two 2nds to s2's one
});
