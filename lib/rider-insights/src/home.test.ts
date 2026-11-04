// Run from scripts/: ./node_modules/.bin/tsx --test ../lib/rider-insights/src/home.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { countdownLabel, pickNextRace } from "./home";

const race = (eventId: number, eventDate: string, status = "registration_open", eventEndDate: string | null = null) =>
  ({ eventId, eventDate, eventEndDate, status });

test("next race: today's race day first, then the soonest that hasn't ended", () => {
  const today = "2026-11-04";
  assert.equal(pickNextRace([race(1, "2026-11-20"), race(2, "2026-11-08")], today)?.eventId, 2);
  assert.equal(pickNextRace([race(1, "2026-11-08"), race(2, "2026-11-03", "race_day", "2026-11-05")], today)?.eventId, 2);
  assert.equal(pickNextRace([race(1, "2026-10-01")], today), null);
  assert.equal(pickNextRace([], today), null);
});

test("countdown labels", () => {
  const today = "2026-11-04";
  assert.equal(countdownLabel(race(1, "2026-11-04"), today), "Racing today");
  assert.equal(countdownLabel(race(1, "2026-11-03", "race_day", "2026-11-05"), today), "Racing today");
  assert.equal(countdownLabel(race(1, "2026-11-05"), today), "Tomorrow");
  assert.equal(countdownLabel(race(1, "2026-11-08"), today), "In 4 days");
  assert.equal(countdownLabel(race(1, "2026-11-25"), today), "In 3 weeks");
  assert.equal(countdownLabel(race(1, "2027-03-14"), today), "Mar 14");
  assert.equal(countdownLabel({ eventId: 1, eventDate: null, status: "registration_open" }, today), "Date to be announced");
});
