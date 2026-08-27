import assert from "node:assert/strict";
import test from "node:test";
import {
  canonicalizeCrossingTimestamp,
  deriveClockSkewRepair,
} from "./crossingTimestamp";

test("canonical crossing timestamps preserve normal and delayed values", () => {
  const received = new Date("2026-08-27T15:29:18.200Z");
  assert.equal(
    canonicalizeCrossingTimestamp("2026-08-27T15:29:17.900Z", received).toISOString(),
    "2026-08-27T15:29:17.900Z",
  );
  assert.equal(
    canonicalizeCrossingTimestamp("2026-08-26T12:00:00.000Z", received).toISOString(),
    "2026-08-26T12:00:00.000Z",
  );
});

test("canonical crossing timestamps replace invalid and two-hour-future values", () => {
  const received = new Date("2026-08-27T15:29:18.200Z");
  assert.equal(
    canonicalizeCrossingTimestamp("2026-08-27T17:29:18.200Z", received).getTime(),
    received.getTime(),
  );
  assert.equal(canonicalizeCrossingTimestamp("not-a-date", received).getTime(), received.getTime());
});

test("clock-skew repair rebuilds lap deltas instead of a 131-minute total", () => {
  const repair = deriveClockSkewRepair(
    new Date("2026-08-27T15:28:56.106Z"),
    [
      { id: 1, crossingTime: new Date("2026-08-27T17:29:18.200Z"), createdAt: new Date("2026-08-27T15:29:18.200Z") },
      { id: 2, crossingTime: new Date("2026-08-27T17:31:43.744Z"), createdAt: new Date("2026-08-27T15:31:43.744Z") },
      { id: 3, crossingTime: new Date("2026-08-27T17:33:56.053Z"), createdAt: new Date("2026-08-27T15:33:56.053Z") },
    ],
  );
  assert.deepEqual(repair?.map(lap => lap.lapTimeMs), [22_094, 145_544, 132_309]);
});