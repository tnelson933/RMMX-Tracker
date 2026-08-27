import assert from "node:assert/strict";
import test from "node:test";
import {
  consumeSnapshotFallback,
  consumeManualOptimisticPings,
  discardManualOptimisticPing,
  markManualOptimisticPing,
  registerAcceptedCrossing,
  shouldPlayAcceptedCrossing,
} from "./liveTimingAudio.ts";

test("crossing acknowledgements are de-duplicated by persisted crossing id", () => {
  const seen = new Set<number>();
  assert.equal(registerAcceptedCrossing(seen, 41), true);
  assert.equal(registerAcceptedCrossing(seen, 41), false);
  assert.equal(registerAcceptedCrossing(seen, 42), true);
});

test("manual acknowledgements do not replay the optimistic beep", () => {
  assert.equal(shouldPlayAcceptedCrossing("MANUAL"), false);
  assert.equal(shouldPlayAcceptedCrossing("reader:12"), true);
  assert.equal(shouldPlayAcceptedCrossing(null), true);
});

test("manual optimistic accounting suppresses only that moto's accepted crossing", () => {
  markManualOptimisticPing(7, 10_000);
  assert.equal(consumeManualOptimisticPings(8, 1, 10_100), 0);
  assert.equal(consumeManualOptimisticPings(7, 1, 10_100), 1);
  assert.equal(consumeManualOptimisticPings(7, 1, 10_100), 0);
});

test("failed or stale manual requests cannot mute a later physical fallback", () => {
  markManualOptimisticPing(9, 10_000);
  discardManualOptimisticPing(9);
  assert.equal(consumeManualOptimisticPings(9, 1, 10_100), 0);
  markManualOptimisticPing(9, 10_000);
  assert.equal(consumeManualOptimisticPings(9, 1, 16_000), 0);
});

test("a fast acknowledgement suppresses only its matching snapshot lap delta", () => {
  const result = consumeSnapshotFallback(2, [10_000], 10_100);
  assert.equal(result.fallbackCount, 1);
  assert.deepEqual(result.pendingFastAckTimes, []);
});

test("stale acknowledgements cannot mute later snapshot fallback sounds", () => {
  const result = consumeSnapshotFallback(1, [10_000], 16_000);
  assert.equal(result.fallbackCount, 1);
  assert.deepEqual(result.pendingFastAckTimes, []);
});