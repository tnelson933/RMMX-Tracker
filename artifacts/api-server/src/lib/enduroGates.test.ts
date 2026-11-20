// Which enduro test (and which end of it) a reader read belongs to, for the
// course setups organizers use: a start and finish reader per test, one reader
// for both ends, the same course run as two tests, and runs repeated on a test.
import assert from "node:assert/strict";
import test from "node:test";
import { pickEnduroGate, type EnduroGateTest } from "@workspace/api-zod";

type Gate = { motoId: number; role: "start" | "finish" };
const T = (motoId: number, crossings = 0, extra: Partial<EnduroGateTest> = {}): EnduroGateTest =>
  ({ motoId, name: `Test ${motoId}`, motoNumber: motoId, requiredRuns: 1, status: "in_progress", crossings, ...extra });

/** Simulate a rider's reads: each read hits one reader (its gates); crossings accumulate. */
function ride(readers: Record<string, Gate[]>, tests: EnduroGateTest[], reads: string[]) {
  const counts = new Map(tests.map(t => [t.motoId, t.crossings]));
  return reads.map(r => {
    const gates = readers[r];
    const ids = new Set(gates.map(g => g.motoId));
    const picked = pickEnduroGate(gates, tests.filter(t => ids.has(t.motoId)).map(t => ({ ...t, crossings: counts.get(t.motoId)! })));
    if ("error" in picked) return picked.error;
    counts.set(picked.motoId, counts.get(picked.motoId)! + 1);
    return `${picked.role} ${picked.name}`;
  });
}

test("3 tests, each with its own start and finish reader", () => {
  const readers = {
    s1: [{ motoId: 1, role: "start" as const }], f1: [{ motoId: 1, role: "finish" as const }],
    s2: [{ motoId: 2, role: "start" as const }], f2: [{ motoId: 2, role: "finish" as const }],
    s3: [{ motoId: 3, role: "start" as const }], f3: [{ motoId: 3, role: "finish" as const }],
  };
  assert.deepEqual(ride(readers, [T(1), T(2), T(3)], ["s1", "f1", "s2", "f2", "s3", "f3"]),
    ["start Test 1", "finish Test 1", "start Test 2", "finish Test 2", "start Test 3", "finish Test 3"]);
});

test("a finish with no start, and a second start while on course, are refused", () => {
  const readers = { s1: [{ motoId: 1, role: "start" as const }], f1: [{ motoId: 1, role: "finish" as const }] };
  assert.deepEqual(ride(readers, [T(1)], ["f1", "s1", "s1"]),
    ["No open start for this rider on Test 1", "start Test 1", "Rider already has an open start on Test 1 — waiting for finish crossing"]);
});

test("each test run twice (lap count 2): two timed runs per test", () => {
  const readers = { s1: [{ motoId: 1, role: "start" as const }], f1: [{ motoId: 1, role: "finish" as const }] };
  assert.deepEqual(ride(readers, [T(1, 0, { requiredRuns: 2 })], ["s1", "f1", "s1", "f1", "s1"]),
    ["start Test 1", "finish Test 1", "start Test 1", "finish Test 1", "Rider already completed all 2 runs of Test 1"]);
});

test("the same course set up as two tests (Test 1 and Test 4) on the same readers", () => {
  const readers = {
    s: [{ motoId: 1, role: "start" as const }, { motoId: 4, role: "start" as const }],
    f: [{ motoId: 1, role: "finish" as const }, { motoId: 4, role: "finish" as const }],
  };
  assert.deepEqual(ride(readers, [T(4), T(1)], ["s", "f", "s", "f", "s"]),
    ["start Test 1", "finish Test 1", "start Test 4", "finish Test 4", "Rider already completed all 1 run of Test 1, Test 4"]);
});

test("one reader is Test 1's finish and Test 2's start", () => {
  const readers = {
    s1: [{ motoId: 1, role: "start" as const }],
    mid: [{ motoId: 1, role: "finish" as const }, { motoId: 2, role: "start" as const }],
    f2: [{ motoId: 2, role: "finish" as const }],
  };
  assert.deepEqual(ride(readers, [T(1), T(2)], ["s1", "mid", "mid", "f2"]),
    ["start Test 1", "finish Test 1", "start Test 2", "finish Test 2"]);
});

test("one reader for both ends of a test alternates start and finish", () => {
  const readers = { g: [{ motoId: 1, role: "start" as const }, { motoId: 1, role: "finish" as const }] };
  assert.deepEqual(ride(readers, [T(1, 0, { requiredRuns: 2 })], ["g", "g", "g", "g"]),
    ["start Test 1", "finish Test 1", "start Test 1", "finish Test 1"]);
});

test("a finished test can't start new runs; an open run on it can still finish", () => {
  const readers = { s: [{ motoId: 1, role: "start" as const }], f: [{ motoId: 1, role: "finish" as const }] };
  assert.deepEqual(ride(readers, [T(1, 0, { status: "completed" })], ["s"]), ["Test 1 is finished — reopen it to record more runs"]);
  assert.deepEqual(ride(readers, [T(1, 1, { status: "completed" })], ["f"]), ["finish Test 1"]);
});
