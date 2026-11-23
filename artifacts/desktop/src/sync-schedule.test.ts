// Run from scripts/: ./node_modules/.bin/tsx --test ../artifacts/desktop/src/sync-schedule.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  SYNC_TIMING,
  backoffDelay,
  isNetworkError,
  localDateKey,
  nextFullCycleDelay,
  pullInterval,
  sessionStillTrusted,
  shouldPullAfterPush,
} from "./sync-schedule";

const base = { raceDay: false, userActive: true, unchangedPulls: 0, failures: 0, overrideMs: null };

test("backoff doubles from 2 s and caps at 30 s", () => {
  assert.deepEqual([0, 1, 2, 3, 4, 5, 6, 50].map((n) => backoffDelay(n)), [0, 2_000, 4_000, 8_000, 16_000, 30_000, 30_000, 30_000]);
});

test("race day pulls every 10 s whether or not anyone is at the computer", () => {
  assert.equal(pullInterval({ raceDay: true, userActive: false, unchangedPulls: 50 }), 10_000);
  assert.equal(pullInterval({ raceDay: true, userActive: true, unchangedPulls: 0 }), 10_000);
});

test("someone at the computer: 15 s, even when nothing changes", () => {
  assert.equal(pullInterval({ raceDay: false, userActive: true, unchangedPulls: 0 }), 15_000);
  assert.equal(pullInterval({ raceDay: false, userActive: true, unchangedPulls: 100 }), 15_000);
});

test("idle computer slows to 30 s, then 60 s, as pulls keep coming back unchanged", () => {
  const at = (n: number) => pullInterval({ raceDay: false, userActive: false, unchangedPulls: n });
  assert.deepEqual([0, 2, 3, 5, 6, 40].map(at), [15_000, 15_000, 30_000, 30_000, 60_000, 60_000]);
});

test("failures override the pull interval with backoff; success returns to it", () => {
  assert.equal(nextFullCycleDelay({ ...base, raceDay: true, failures: 3 }), 8_000);
  assert.equal(nextFullCycleDelay({ ...base, raceDay: true }), 10_000);
});

test("a manual interval override wins over the adaptive schedule but not below 2 s", () => {
  assert.equal(nextFullCycleDelay({ ...base, overrideMs: 5_000 }), 5_000);
  assert.equal(nextFullCycleDelay({ ...base, overrideMs: 100 }), SYNC_TIMING.minOverrideMs);
  assert.equal(nextFullCycleDelay({ ...base, overrideMs: 5_000, failures: 1 }), 2_000);
});

test("a push pulls too unless a pull ran in the last 5 s", () => {
  assert.equal(shouldPullAfterPush(100_000, null), true);
  assert.equal(shouldPullAfterPush(100_000, 96_000), false);
  assert.equal(shouldPullAfterPush(100_000, 95_000), true);
});

test("a session confirmed in the last 5 minutes is reused without /api/auth/me", () => {
  assert.equal(sessionStillTrusted(1_000_000, null), false);
  assert.equal(sessionStillTrusted(1_000_000, 1_000_000 - 299_000), true);
  assert.equal(sessionStillTrusted(1_000_000, 1_000_000 - 300_000), false);
});

test("worst-case delays stay within the race-day budget", () => {
  // Local write → push: one local check plus the debounce.
  assert.ok(SYNC_TIMING.localCheckMs + SYNC_TIMING.pushDebounceMs <= 2_000);
  // A down cloud is retried at least twice a minute.
  assert.ok(SYNC_TIMING.backoffMaxMs <= 30_000);
});

test("localDateKey uses the local calendar date", () => {
  assert.equal(localDateKey(new Date(2026, 10, 3, 23, 59)), "2026-11-03");
  assert.equal(localDateKey(new Date(2026, 0, 1, 0, 0)), "2026-01-01");
});

test("isNetworkError: fetch failures and timeouts, not HTTP errors", () => {
  const refused = new TypeError("fetch failed", { cause: Object.assign(new Error("connect"), { code: "ECONNREFUSED" }) });
  assert.equal(isNetworkError(refused), true);
  assert.equal(isNetworkError(Object.assign(new Error("aborted"), { name: "AbortError" })), true);
  assert.equal(isNetworkError(new Error("sync-pull failed (500): boom")), false);
  assert.equal(isNetworkError(new Error("Login failed (401): nope")), false);
  assert.equal(isNetworkError("fetch failed"), false);
});
