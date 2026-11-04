// Run from scripts/: ./node_modules/.bin/tsx --test ../lib/rider-insights/src/liveRaces.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { defaultSide, isLive, nextScheduled, splitLivePast } from "./liveRaces";

const ev = (id: number, status: string, date: string, endDate: string | null = null) => ({ id, status, date, endDate });
const today = "2026-11-04";

test("live = race day and today within the event's dates", () => {
  assert.equal(isLive(ev(1, "race_day", "2026-11-04"), today), true);
  assert.equal(isLive(ev(1, "race_day", "2026-11-03", "2026-11-05"), today), true);
  assert.equal(isLive(ev(1, "race_day", "2026-11-01"), today), false);
  assert.equal(isLive(ev(1, "registration_open", "2026-11-04"), today), false);
});

test("split: stale race days go to past, newest end date first", () => {
  const { live, past } = splitLivePast([
    ev(1, "completed", "2026-10-01"),
    ev(2, "race_day", "2026-11-04"),
    ev(3, "race_day", "2026-10-20", "2026-10-21"),
    ev(4, "registration_open", "2026-11-20"),
    ev(5, "completed", "2026-10-10"),
  ], today);
  assert.deepEqual(live.map(e => e.id), [2]);
  assert.deepEqual(past.map(e => e.id), [3, 5, 1]);
});

test("default side", () => {
  assert.equal(defaultSide(2), "live");
  assert.equal(defaultSide(0), "past");
});

test("next scheduled skips finished, drafts and live; soonest first", () => {
  const next = nextScheduled([
    ev(1, "registration_open", "2026-11-20"),
    ev(2, "registration_open", "2026-11-04"),
    ev(3, "completed", "2026-11-04"),
    ev(4, "draft", "2026-11-05"),
    ev(5, "race_day", "2026-11-04"),
    ev(6, "registration_closed", "2026-11-08"),
    ev(7, "registration_open", "2026-10-01"),
  ], today, 2);
  assert.deepEqual(next.map(e => e.id), [2, 6]);
});
