import assert from "node:assert/strict";
import test from "node:test";
import { rentalExpiry } from "./rentalTransponders";

test("a rental link lasts through the last race day and ends the next morning", () => {
  // One-day event on Oct 25: expires Oct 26 at noon UTC (6 am Mountain), not on race-day evening.
  assert.equal(rentalExpiry({ date: "2026-10-25" }).toISOString(), "2026-10-26T12:00:00.000Z");
  // Two-day event: the last race day counts.
  assert.equal(rentalExpiry({ date: "2026-10-24", endDate: "2026-10-25" }).toISOString(), "2026-10-26T12:00:00.000Z");
  // An end date before the start is ignored.
  assert.equal(rentalExpiry({ date: "2026-10-25", endDate: "2026-10-20" }).toISOString(), "2026-10-26T12:00:00.000Z");
  // Month end rolls over.
  assert.equal(rentalExpiry({ date: "2026-10-31" }).toISOString(), "2026-11-01T12:00:00.000Z");
});
