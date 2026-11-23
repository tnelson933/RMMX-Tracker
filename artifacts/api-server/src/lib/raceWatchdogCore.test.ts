import assert from "node:assert/strict";
import test from "node:test";
import {
  evaluateWatchdog, watchdogConfigFromEnv,
  type WatchdogConfig, type WatchdogMoto, type WatchdogState,
} from "./raceWatchdogCore";

const MIN = 60_000;
const T0 = Date.UTC(2026, 10, 22, 15, 0, 0);
const cfg: WatchdogConfig = { staleMs: 6 * MIN, repeatMs: 30 * MIN, longNoLimitMs: 90 * MIN, longLimitFactor: 2 };

function moto(over: Partial<WatchdogMoto> = {}): WatchdogMoto {
  return {
    motoId: 10, motoName: "250 B Moto 1", eventName: "Spring Opener", clubName: "Dev Club",
    type: "heat", startedAtMs: T0, pausedAtMs: null, totalPausedMs: 0, timeLimitMs: null,
    lastCrossingMs: null, resumedAtMs: null, ...over,
  };
}

test("no alert while crossings are recent", () => {
  const state: WatchdogState = new Map();
  const out = evaluateWatchdog([moto({ lastCrossingMs: T0 + 10 * MIN })], state, T0 + 14 * MIN, cfg);
  assert.deepEqual(out, []);
});

test("stale after N minutes without a crossing, with club, event and moto in the text", () => {
  const state: WatchdogState = new Map();
  const out = evaluateWatchdog([moto({ lastCrossingMs: T0 + 5 * MIN })], state, T0 + 12 * MIN, cfg);
  assert.equal(out.length, 1);
  assert.equal(out[0].kind, "stale");
  assert.equal(out[0].minutes, 7);
  assert.match(out[0].text, /250 B Moto 1/);
  assert.match(out[0].text, /Spring Opener/);
  assert.match(out[0].text, /Dev Club/);
});

test("a moto started less than N minutes ago is ignored; before the first crossing it waits 2N", () => {
  const state: WatchdogState = new Map();
  assert.deepEqual(evaluateWatchdog([moto()], state, T0 + 5 * MIN, cfg), []);
  assert.deepEqual(evaluateWatchdog([moto()], state, T0 + 11 * MIN, cfg), []);
  const out = evaluateWatchdog([moto()], state, T0 + 12 * MIN, cfg);
  assert.equal(out.length, 1);
  assert.equal(out[0].kind, "stale");
});

test("paused motos don't alert, and pause time before the first crossing isn't counted", () => {
  const state: WatchdogState = new Map();
  assert.deepEqual(evaluateWatchdog([moto({ pausedAtMs: T0 + 2 * MIN })], state, T0 + 40 * MIN, cfg), []);
  // Resumed after a 30 min pause, no crossings yet: 11 min of racing, under the 2N first-lap wait.
  assert.deepEqual(evaluateWatchdog([moto({ totalPausedMs: 30 * MIN })], state, T0 + 41 * MIN, cfg), []);
});

test("after a resume the quiet clock restarts at the resume", () => {
  const state: WatchdogState = new Map();
  const m = moto({ lastCrossingMs: T0 + 2 * MIN, resumedAtMs: T0 + 30 * MIN, totalPausedMs: 27 * MIN });
  assert.deepEqual(evaluateWatchdog([m], state, T0 + 34 * MIN, cfg), []);
  assert.equal(evaluateWatchdog([m], state, T0 + 37 * MIN, cfg)[0]?.kind, "stale");
});

test("practice and enduro tests are not watched", () => {
  const state: WatchdogState = new Map();
  const out = evaluateWatchdog([moto({ type: "practice" }), moto({ motoId: 11, type: "enduro_test" })], state, T0 + 200 * MIN, cfg);
  assert.deepEqual(out, []);
});

test("dedupe: one stale text per quiet period, repeated after the quiet period", () => {
  const state: WatchdogState = new Map();
  const m = moto({ lastCrossingMs: T0 + MIN });
  assert.equal(evaluateWatchdog([m], state, T0 + 8 * MIN, cfg).length, 1);
  for (let t = 9; t < 38; t++) assert.deepEqual(evaluateWatchdog([m], state, T0 + t * MIN, cfg), [], `minute ${t}`);
  const again = evaluateWatchdog([m], state, T0 + 38 * MIN, cfg);
  assert.equal(again.length, 1);
  assert.equal(again[0].minutes, 37);
});

test("recovered once when crossings resume, then a new outage alerts again", () => {
  const state: WatchdogState = new Map();
  assert.equal(evaluateWatchdog([moto({ lastCrossingMs: T0 + MIN })], state, T0 + 8 * MIN, cfg)[0].kind, "stale");
  const back = evaluateWatchdog([moto({ lastCrossingMs: T0 + 9 * MIN })], state, T0 + 9.5 * MIN, cfg);
  assert.equal(back.length, 1);
  assert.equal(back[0].kind, "recovered");
  assert.match(back[0].text, /resumed in 250 B Moto 1/);
  assert.deepEqual(evaluateWatchdog([moto({ lastCrossingMs: T0 + 10 * MIN })], state, T0 + 11 * MIN, cfg), []);
  assert.equal(evaluateWatchdog([moto({ lastCrossingMs: T0 + 10 * MIN })], state, T0 + 17 * MIN, cfg)[0].kind, "stale");
});

test("a resume without a crossing is not a recovery", () => {
  const state: WatchdogState = new Map();
  evaluateWatchdog([moto({ lastCrossingMs: T0 + MIN })], state, T0 + 8 * MIN, cfg);
  const out = evaluateWatchdog([moto({ lastCrossingMs: T0 + MIN, resumedAtMs: T0 + 9 * MIN, totalPausedMs: MIN })], state, T0 + 10 * MIN, cfg);
  assert.deepEqual(out, []);
});

test("long running: over 2x the time limit, or 90 min without one", () => {
  const state: WatchdogState = new Map();
  const timed = moto({ timeLimitMs: 20 * MIN, lastCrossingMs: T0 + 41 * MIN });
  assert.deepEqual(evaluateWatchdog([timed], state, T0 + 39 * MIN, cfg).filter(a => a.kind === "long_running"), []);
  const out = evaluateWatchdog([timed], state, T0 + 41 * MIN, cfg);
  assert.equal(out.length, 1);
  assert.equal(out[0].kind, "long_running");
  assert.match(out[0].text, /time limit 20 min/);
  assert.deepEqual(evaluateWatchdog([timed], state, T0 + 45 * MIN, cfg), []);

  const untimed = moto({ motoId: 12, lastCrossingMs: T0 + 91 * MIN });
  assert.deepEqual(evaluateWatchdog([untimed], new Map(), T0 + 89 * MIN, cfg).filter(a => a.kind === "long_running"), []);
  assert.equal(evaluateWatchdog([untimed], new Map(), T0 + 91 * MIN, cfg)[0].kind, "long_running");
});

test("long running excludes pauses", () => {
  const out = evaluateWatchdog([moto({ totalPausedMs: 30 * MIN, lastCrossingMs: T0 + 100 * MIN })], new Map(), T0 + 101 * MIN, cfg);
  assert.deepEqual(out, []);
});

test("state is forgotten when a moto stops running", () => {
  const state: WatchdogState = new Map();
  evaluateWatchdog([moto({ lastCrossingMs: T0 + MIN })], state, T0 + 8 * MIN, cfg);
  assert.equal(state.size, 1);
  evaluateWatchdog([], state, T0 + 9 * MIN, cfg);
  assert.equal(state.size, 0);
});

test("config from env with defaults", () => {
  assert.deepEqual(watchdogConfigFromEnv({}), cfg);
  assert.equal(watchdogConfigFromEnv({ RACE_WATCHDOG_STALE_MIN: "1" }).staleMs, MIN);
  assert.equal(watchdogConfigFromEnv({ RACE_WATCHDOG_STALE_MIN: "nope" }).staleMs, 6 * MIN);
});
