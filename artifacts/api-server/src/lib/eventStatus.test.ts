import assert from "node:assert/strict";
import test from "node:test";
import { computeAutoStatus, eventDateReached, scheduleShowsEvent } from "./eventStatus";

// 2026-07-11 23:30 UTC is still 5:30 pm on July 11 in Utah, and already July 12 in UTC
// one hour later: the evening of a race day.
const eveningInUtah = new Date("2026-07-12T01:30:00Z");

test("a rider's schedule keeps a race until its last day has passed at the track", () => {
  const raceDay = { status: "race_day", date: "2026-07-11", endDate: null };
  // The track's own date decides, never the server's (UTC) date.
  assert.equal(scheduleShowsEvent(raceDay, "2026-07-11"), true);
  assert.equal(scheduleShowsEvent(raceDay, "2026-07-12"), false);
  assert.equal(scheduleShowsEvent({ status: "registration_open", date: "2026-08-01" }, "2026-07-11"), true);
  // Two-day events stay through the second day.
  assert.equal(scheduleShowsEvent({ status: "race_day", date: "2026-07-11", endDate: "2026-07-12" }, "2026-07-12"), true);
  // Stored with a time part.
  assert.equal(scheduleShowsEvent({ status: "race_day", date: "2026-07-11T00:00:00.000Z" }, "2026-07-11"), true);
  // Finished events stay (history); undated ones don't.
  assert.equal(scheduleShowsEvent({ status: "completed", date: "2025-01-01" }, "2026-07-11"), true);
  assert.equal(scheduleShowsEvent({ status: "registration_closed", date: null }, "2026-07-11"), false);
});

test("race day lasts the whole local day: no early finish when UTC rolls over", () => {
  const event = { id: 1, date: "2026-07-11", endDate: null, status: "race_day", registrationOpen: null, registrationClose: null, state: "UT" };
  assert.equal(computeAutoStatus(event, eveningInUtah), null);
  assert.equal(computeAutoStatus(event, new Date("2026-07-12T07:00:00Z")), "completed");
  assert.equal(eventDateReached({ date: "2026-07-12", state: "UT" }, eveningInUtah), false);
});
