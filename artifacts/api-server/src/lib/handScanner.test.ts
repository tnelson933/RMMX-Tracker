import assert from "node:assert/strict";
import test from "node:test";
// @ts-expect-error Node's type-stripping runner requires the explicit extension.
import { normalizeScanBody } from "../routes/reader-ingest.ts";
// @ts-expect-error Node's type-stripping runner requires the explicit extension.
import { describePlacement } from "../routes/hand-scanners.ts";

test("scanner app payloads map onto rfidNumber and crossingTime", () => {
  assert.equal(normalizeScanBody({ epc: "e280 1160 6000" }).rfidNumber, "e28011606000");
  assert.equal(normalizeScanBody({ tagId: "ABC" }).rfidNumber, "ABC");
  assert.equal(normalizeScanBody("E2801160\r\n").rfidNumber, "E2801160");
  assert.equal(normalizeScanBody({}, { tag: "Q1" }).rfidNumber, "Q1");
  assert.equal(normalizeScanBody({ rfidNumber: "X", crossingTime: "2026-10-29T10:00:00Z" }).crossingTime, "2026-10-29T10:00:00Z");
  assert.equal(normalizeScanBody({ epc: "X", timestamp: "1793224047852" }).crossingTime, new Date(1793224047852).toISOString());
  assert.equal(normalizeScanBody({ nothing: 1 }).rfidNumber, undefined);
});

test("placements read the way organizers named them", () => {
  assert.equal(describePlacement({ role: "time_check", label: "Section 4 check", sequence: null }), "Section 4 check (time check)");
  assert.equal(describePlacement({ role: "split", label: null, sequence: 2 }), "Split 2");
  assert.equal(describePlacement({ role: "finish", label: null, sequence: null }), "Finish");
});
