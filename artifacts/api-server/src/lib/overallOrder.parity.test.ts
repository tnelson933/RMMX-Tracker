import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { compareOverall, olympicPenalty, overallPositions } from "./overallOrder";

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
