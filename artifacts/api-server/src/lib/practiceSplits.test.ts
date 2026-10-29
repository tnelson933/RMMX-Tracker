import assert from "node:assert/strict";
import test from "node:test";
import { practiceSectors } from "./practiceSplits";

const t = (s: number) => new Date(Date.UTC(2026, 9, 29, 10, 0, s));
const course = { finishReaderId: 1, splits: [{ readerId: 2, sequence: 1, label: "Whoops" }] };

test("practice sectors: the first pass starts lap 1 and each split lands on the lap in progress", () => {
  const passes = [
    { rfidNumber: "ABC", crossingTime: t(0) },   // first pass: starts lap 1
    { rfidNumber: "ABC", crossingTime: t(60) },  // ends lap 1
    { rfidNumber: "abc", crossingTime: t(115) }, // ends lap 2 (tag case differs)
  ];
  const splits = [
    { rfidNumber: "ABC", lapNumber: 1, splitSequence: 1, crossingTime: t(25) },
    { rfidNumber: "ABC", lapNumber: 2, splitSequence: 1, crossingTime: t(80) },
  ];
  const result = practiceSectors(course, passes, splits)!;
  assert.deepEqual(result.names, ["Finish → Whoops", "Whoops → Finish"]);
  const rider = result.byTag.get("abc")!;
  assert.deepEqual(rider.laps.map(l => l.sectorsMs), [[25_000, 35_000], [20_000, 35_000]]);
  assert.deepEqual(rider.best, [20_000, 35_000]);
});

test("practice sectors: none without split readers on the course", () => {
  assert.equal(practiceSectors({ finishReaderId: 1, splits: [] }, [], []), null);
  assert.equal(practiceSectors(null, [], []), null);
});
