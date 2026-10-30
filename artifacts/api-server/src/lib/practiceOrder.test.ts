import assert from "node:assert/strict";
import test from "node:test";
import { practiceInsertNumber } from "@workspace/api-zod";

const moto = (motoNumber: number, type: string, status = "scheduled") => ({ motoNumber, type, status });

test("a new practice goes before the first race moto that hasn't been raced", () => {
  assert.equal(practiceInsertNumber([moto(1, "heat"), moto(2, "heat"), moto(3, "main")]), 1);
  // Raced and running motos stay ahead of it.
  assert.equal(practiceInsertNumber([moto(1, "heat", "completed"), moto(2, "heat", "in_progress"), moto(3, "heat"), moto(4, "main")]), 3);
});

test("practices already queued keep their place; the new one follows them", () => {
  assert.equal(practiceInsertNumber([moto(1, "practice"), moto(2, "practice"), moto(3, "heat"), moto(4, "heat")]), 3);
  assert.equal(practiceInsertNumber([moto(1, "heat", "completed"), moto(2, "practice"), moto(3, "heat")]), 3);
});

test("with nothing left to race, or no motos, it goes at the end", () => {
  assert.equal(practiceInsertNumber([]), 1);
  assert.equal(practiceInsertNumber([moto(1, "heat", "completed"), moto(2, "main", "completed")]), 3);
  assert.equal(practiceInsertNumber([moto(1, "practice"), moto(2, "heat", "cancelled")]), 3);
});

test("enduro tests count as racing; gaps and unnumbered motos are handled", () => {
  assert.equal(practiceInsertNumber([moto(1, "practice", "completed"), moto(5, "enduro_test"), moto(9, "enduro_test")]), 5);
  assert.equal(practiceInsertNumber([{ motoNumber: null, type: "heat", status: "scheduled" }, moto(2, "heat", "completed")]), 3);
});
