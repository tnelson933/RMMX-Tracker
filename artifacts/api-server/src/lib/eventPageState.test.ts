import assert from "node:assert/strict";
import test from "node:test";
import { eventPageState, isFinishedPageState, isLivePageState } from "@workspace/api-zod";

// The event page (/results/:eventId) and its link preview share this rule.
const today = "2026-06-01";
const now = new Date("2026-06-01T18:00:00Z");
const official = { count: 12, official: true };
const unofficial = { count: 12, official: false };

test("drafts have no public page", () => {
  assert.equal(eventPageState({ status: "draft", date: "2026-06-13" }, today, now), null);
});

test("before race day: upcoming, registration open, registration closed", () => {
  assert.equal(eventPageState({ status: "upcoming", date: "2026-06-13" }, today, now), "upcoming");
  assert.equal(eventPageState({ status: "registration_open", date: "2026-06-13" }, today, now), "registration_open");
  assert.equal(eventPageState({ status: "registration_open", date: "2026-06-13", registrationClose: "2026-06-12T00:00:00Z" }, today, now), "registration_open");
  // Past the close time before the status sweep has caught up.
  assert.equal(eventPageState({ status: "registration_open", date: "2026-06-13", registrationClose: "2026-05-31T00:00:00Z" }, today, now), "registration_closed");
  assert.equal(eventPageState({ status: "registration_closed", date: "2026-06-13" }, today, now), "registration_closed");
});

test("race day: by status or by the track's local date, including a multi-day event's later days", () => {
  assert.equal(eventPageState({ status: "race_day", date: "2026-06-01" }, today, now), "race_day");
  assert.equal(eventPageState({ status: "registration_closed", date: "2026-06-01" }, today, now), "race_day");
  assert.equal(eventPageState({ status: "registration_closed", date: "2026-05-31", endDate: "2026-06-01" }, today, now), "race_day");
  assert.equal(eventPageState({ status: "race_day", date: "2026-06-01T00:00:00.000Z" }, today, now), "race_day");
  // Motos that are scheduled or finished don't make it live.
  assert.equal(eventPageState({ status: "race_day", date: "2026-06-01", motos: [{ status: "scheduled" }, { status: "completed" }] }, today, now), "race_day");
});

test("live: any moto in progress, even before the status catches up or after it was completed", () => {
  const running = [{ status: "completed" }, { status: "in_progress" }];
  assert.equal(eventPageState({ status: "race_day", date: "2026-06-01", motos: running }, today, now), "live");
  assert.equal(eventPageState({ status: "registration_closed", date: "2026-06-02", motos: running }, today, now), "live");
  assert.equal(eventPageState({ status: "completed", date: "2026-05-01", motos: running, results: official }, today, now), "live");
});

test("after the race: unofficial until every finished result is finalized, then official", () => {
  assert.equal(eventPageState({ status: "completed", date: "2026-05-01", results: unofficial }, today, now), "finished_unofficial");
  assert.equal(eventPageState({ status: "completed", date: "2026-05-01", results: official }, today, now), "official");
  // results_published is a legacy status value; publication is still decided by the results.
  assert.equal(eventPageState({ status: "results_published", date: "2026-05-01", results: unofficial }, today, now), "finished_unofficial");
  // No results posted (or unknown): never official.
  assert.equal(eventPageState({ status: "completed", date: "2026-05-01", results: { count: 0, official: true } }, today, now), "finished_unofficial");
  assert.equal(eventPageState({ status: "completed", date: "2026-05-01" }, today, now), "finished_unofficial");
  // The last day has passed though the status wasn't moved on.
  assert.equal(eventPageState({ status: "race_day", date: "2026-05-30", endDate: "2026-05-31", results: official }, today, now), "official");
});

test("state groups", () => {
  assert.ok(isLivePageState("live") && isLivePageState("race_day"));
  assert.ok(!isLivePageState("official") && !isLivePageState(null));
  assert.ok(isFinishedPageState("official") && isFinishedPageState("finished_unofficial"));
  assert.ok(!isFinishedPageState("race_day"));
});
