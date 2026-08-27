import assert from "node:assert/strict";
import test from "node:test";
import {
  advanceAnnouncerLifecycle,
  createAnnouncerLifecycleState,
  hydrateAnnouncerLifecycle,
  type AnnouncerRider,
// Node's built-in type-stripping test runner requires the explicit extension.
// @ts-expect-error TypeScript's bundler resolution does not allow it by default.
} from "./announcerLifecycle.ts";

function field(laps: number, positions = [1, 2, 3, 4, 5]): AnnouncerRider[] {
  return positions.map((position, index) => ({
    riderId: index + 1,
    riderName: `Rider ${index + 1}`,
    position,
    laps,
    dnf: false,
    dns: false,
  }));
}

test("emits one opening call at the authoritative race start", () => {
  const state = createAnnouncerLifecycleState();
  assert.equal(advanceAnnouncerLifecycle(state, "in_progress", field(0)).kind, "start");
  assert.equal(advanceAnnouncerLifecycle(state, "in_progress", field(0)).kind, "none");
});

test("seeds a mid-race join without replaying start or completed laps", () => {
  const state = createAnnouncerLifecycleState();
  assert.equal(advanceAnnouncerLifecycle(state, "in_progress", field(3)).kind, "none");
  assert.equal(state.lastAnnouncedLap, 3);
  assert.equal(advanceAnnouncerLifecycle(state, "in_progress", field(3)).kind, "none");
  assert.deepEqual(advanceAnnouncerLifecycle(state, "in_progress", field(4)), {
    kind: "lap",
    lap: 4,
    positionChanges: [],
  });
});

test("waits for field progression and suppresses duplicate lap updates", () => {
  const state = createAnnouncerLifecycleState();
  advanceAnnouncerLifecycle(state, "in_progress", field(0));
  const partial = field(0).map((rider, index) => ({ ...rider, laps: index < 4 ? 1 : 0 }));
  assert.equal(advanceAnnouncerLifecycle(state, "in_progress", partial, 5).kind, "none");
  assert.equal(advanceAnnouncerLifecycle(state, "in_progress", field(1), 5).kind, "lap");
  assert.equal(advanceAnnouncerLifecycle(state, "in_progress", field(1)).kind, "none");
});

test("captures position changes and emits one completion recap", () => {
  const state = createAnnouncerLifecycleState();
  advanceAnnouncerLifecycle(state, "in_progress", field(0));
  const lap = advanceAnnouncerLifecycle(state, "in_progress", field(1, [2, 1, 3, 4, 5]));
  assert.equal(lap.kind, "lap");
  if (lap.kind === "lap") assert.equal(lap.positionChanges.length, 2);
  assert.equal(advanceAnnouncerLifecycle(state, "completed", field(2)).kind, "finish");
  assert.equal(advanceAnnouncerLifecycle(state, "completed", field(2)).kind, "none");
});

test("can retry an uncommitted transition after generation fails", () => {
  const state = createAnnouncerLifecycleState();
  const candidate = createAnnouncerLifecycleState();
  assert.equal(advanceAnnouncerLifecycle(candidate, "in_progress", field(0)).kind, "start");
  assert.equal(state.started, false);
  assert.equal(advanceAnnouncerLifecycle(state, "in_progress", field(0)).kind, "start");
});

test("persisted markers prevent duplicate opening and finish calls after restart", () => {
  const state = createAnnouncerLifecycleState();
  hydrateAnnouncerLifecycle(state, { started: true, finished: false, lastAnnouncedLap: 0 });
  assert.equal(advanceAnnouncerLifecycle(state, "in_progress", field(0)).kind, "none");
  hydrateAnnouncerLifecycle(state, { started: true, finished: true, lastAnnouncedLap: 4 });
  assert.equal(advanceAnnouncerLifecycle(state, "completed", field(4)).kind, "none");
});

test("persisted lap progress is not replayed after an API restart", () => {
  const state = createAnnouncerLifecycleState();
  hydrateAnnouncerLifecycle(state, { started: true, finished: false, lastAnnouncedLap: 3 });
  assert.equal(advanceAnnouncerLifecycle(state, "in_progress", field(3), 5).kind, "none");
  assert.equal(advanceAnnouncerLifecycle(state, "in_progress", field(4), 5).kind, "lap");
});