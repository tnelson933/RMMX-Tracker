import assert from "node:assert/strict";
import test from "node:test";
import {
  canonicalizeCrossingTimestamp,
  deriveClockSkewRepair,
  isTrustedDirectActiveTimingSource,
  parseTrustworthyReceivedAt,
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

test("new direct active ingress canonicalizes trusted clock skew in both directions", () => {
  const received = new Date("2026-08-27T15:29:18.200Z");
  const trusted = isTrustedDirectActiveTimingSource("CONNECTOR_LIVE_TCP");
  assert.equal(
    canonicalizeCrossingTimestamp("2026-08-27T17:29:18.200Z", received, {}, trusted).getTime(),
    received.getTime(),
  );
  assert.equal(
    canonicalizeCrossingTimestamp("2026-08-27T09:29:18.200Z", received, {}, trusted).getTime(),
    received.getTime(),
  );
});

test("only normalized direct-active bridge provenance opts into past skew repair", () => {
  assert.equal(isTrustedDirectActiveTimingSource(" F2000_TCP "), true);
  assert.equal(isTrustedDirectActiveTimingSource("PASSIVE_RFID"), false);
  assert.equal(isTrustedDirectActiveTimingSource("unknown"), false);
  const received = new Date("2026-08-27T15:29:18.200Z");
  assert.equal(
    canonicalizeCrossingTimestamp("2026-08-27T09:29:18.200Z", received, {}, false).toISOString(),
    "2026-08-27T09:29:18.200Z",
  );
  assert.equal(
    canonicalizeCrossingTimestamp(
      "2026-08-27T09:29:18.200Z",
      received,
      {},
      isTrustedDirectActiveTimingSource("passive_rfid"),
    ).toISOString(),
    "2026-08-27T09:29:18.200Z",
  );
});

test("delayed retry retains a canonical crossing relative to its original receipt", () => {
  const originalReceipt = parseTrustworthyReceivedAt(
    "2025-01-02T03:04:06.000Z",
    new Date("2025-01-03T03:04:06.000Z"),
  );
  assert.ok(originalReceipt);
  assert.equal(
    canonicalizeCrossingTimestamp("2025-01-02T03:04:05.000Z", originalReceipt, {}, true).toISOString(),
    "2025-01-02T03:04:05.000Z",
  );
});

test("future supplied receipts are not trusted", () => {
  assert.equal(
    parseTrustworthyReceivedAt("2026-08-27T16:00:00.000Z", new Date("2026-08-27T15:00:00.000Z")),
    null,
  );
  assert.equal(
    parseTrustworthyReceivedAt("not-a-date", new Date("2026-08-27T15:00:00.000Z")),
    null,
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

test("clock-skew repair leaves stable past historical sequences untouched", () => {
  assert.equal(deriveClockSkewRepair(new Date("2026-08-27T15:28:00.000Z"), [
    { id: 1, crossingTime: new Date("2026-08-27T09:30:00.000Z"), createdAt: new Date("2026-08-27T15:30:00.000Z") },
    { id: 2, crossingTime: new Date("2026-08-27T09:32:00.000Z"), createdAt: new Date("2026-08-27T15:32:00.000Z") },
  ]), null);
});

test("clock-skew repair fixes stable positive timezone labels", () => {
  const repair = deriveClockSkewRepair(new Date("2026-08-27T15:28:00.000Z"), [
    { id: 1, crossingTime: new Date("2026-08-27T17:30:00.000Z"), createdAt: new Date("2026-08-27T15:30:00.000Z") },
    { id: 2, crossingTime: new Date("2026-08-27T17:32:30.000Z"), createdAt: new Date("2026-08-27T15:32:00.000Z") },
  ]);
  assert.deepEqual(repair?.map(lap => lap.lapTimeMs), [120_000, 120_000]);
});

test("clock-skew repair leaves variable queued delayed uploads untouched", () => {
  const repair = deriveClockSkewRepair(new Date("2026-08-27T15:00:00.000Z"), [
    { id: 1, crossingTime: new Date("2026-08-27T14:10:00.000Z"), createdAt: new Date("2026-08-27T15:30:00.000Z") },
    { id: 2, crossingTime: new Date("2026-08-27T14:20:00.000Z"), createdAt: new Date("2026-08-27T15:30:30.000Z") },
  ]);
  assert.equal(repair, null);
});

test("clock-skew repair leaves a lone past crossing untouched", () => {
  assert.equal(deriveClockSkewRepair(new Date("2026-08-27T15:00:00.000Z"), [
    { id: 1, crossingTime: new Date("2026-08-27T09:10:00.000Z"), createdAt: new Date("2026-08-27T15:30:00.000Z") },
  ]), null);
});

test("clock-skew repair leaves a short delayed historical replay untouched", () => {
  assert.equal(deriveClockSkewRepair(new Date("2026-08-27T08:00:00.000Z"), [
    { id: 1, crossingTime: new Date("2026-08-27T08:30:00.000Z"), createdAt: new Date("2026-08-27T14:30:00.000Z") },
    { id: 2, crossingTime: new Date("2026-08-27T08:31:00.000Z"), createdAt: new Date("2026-08-27T14:31:00.000Z") },
    { id: 3, crossingTime: new Date("2026-08-27T08:33:00.000Z"), createdAt: new Date("2026-08-27T14:33:00.000Z") },
  ]), null);
});