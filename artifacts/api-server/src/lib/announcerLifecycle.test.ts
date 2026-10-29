import assert from "node:assert/strict";
import test from "node:test";
import {
  advanceAnnouncerLifecycle,
  calculateRaceTimeRemainingMs,
  createAnnouncerLifecycleState,
  hydrateAnnouncerLifecycle,
  shouldPublishAnnouncerSnapshotForMotoPatch,
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

test("calls the lap the moment the leader crosses, once", () => {
  const state = createAnnouncerLifecycleState();
  advanceAnnouncerLifecycle(state, "in_progress", field(0));
  // Only the leader has crossed: that's the moment to call it, not after the field.
  const leaderOnly = field(0).map((rider, index) => ({ ...rider, laps: index === 0 ? 1 : 0 }));
  assert.equal(advanceAnnouncerLifecycle(state, "in_progress", leaderOnly, 5).kind, "lap");
  assert.equal(advanceAnnouncerLifecycle(state, "in_progress", field(1), 5).kind, "none");
});

test("stays quiet under a red flag and calls the next lap after the restart", () => {
  const state = createAnnouncerLifecycleState();
  advanceAnnouncerLifecycle(state, "in_progress", field(0));
  assert.equal(advanceAnnouncerLifecycle(state, "in_progress", field(1), 5, { paused: true }).kind, "none");
  assert.equal(advanceAnnouncerLifecycle(state, "in_progress", field(1), 5).kind, "lap");
});

test("a pass names the rider who held that spot", () => {
  const state = createAnnouncerLifecycleState();
  advanceAnnouncerLifecycle(state, "in_progress", field(0));
  const lap = advanceAnnouncerLifecycle(state, "in_progress", field(1, [2, 1, 3, 4, 5]));
  assert.equal(lap.kind, "lap");
  if (lap.kind === "lap") {
    const toFirst = lap.positionChanges.find(c => c.to === 1);
    assert.ok(toFirst?.passedName, "the old leader is named");
    assert.notEqual(toFirst?.passedName, toFirst?.riderName);
  }
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

test("announces timed-race expiry once and counts down leader extra laps", () => {
  const state = createAnnouncerLifecycleState();
  hydrateAnnouncerLifecycle(state, { started: true, finished: false, lastAnnouncedLap: 4 });

  assert.deepEqual(
    advanceAnnouncerLifecycle(state, "in_progress", field(4), 5, {
      timeExpired: true,
      plusLaps: 2,
    }),
    { kind: "time_expired", lap: 4, extraLapsRemaining: 2 },
  );
  assert.equal(
    advanceAnnouncerLifecycle(state, "in_progress", field(4), 5, {
      timeExpired: true,
      plusLaps: 2,
    }).kind,
    "none",
  );
  assert.deepEqual(
    advanceAnnouncerLifecycle(state, "in_progress", field(5), 5, {
      timeExpired: true,
      plusLaps: 2,
    }),
    { kind: "extra_lap", lap: 5, extraLapsCompleted: 1, extraLapsRemaining: 1 },
  );
  assert.deepEqual(
    advanceAnnouncerLifecycle(state, "in_progress", field(6), 5, {
      timeExpired: true,
      plusLaps: 2,
    }),
    { kind: "extra_lap", lap: 6, extraLapsCompleted: 2, extraLapsRemaining: 0 },
  );
  assert.equal(
    advanceAnnouncerLifecycle(state, "in_progress", field(7), 5, {
      timeExpired: true,
      plusLaps: 2,
    }).kind,
    "none",
  );
});

test("persisted timed-race markers suppress expiry and extra-lap replays after restart", () => {
  const state = createAnnouncerLifecycleState();
  hydrateAnnouncerLifecycle(state, {
    started: true,
    finished: false,
    lastAnnouncedLap: 6,
    timeExpiredAnnounced: true,
    expiryLeaderLap: 4,
    lastAnnouncedExtraLap: 2,
  });
  assert.equal(
    advanceAnnouncerLifecycle(state, "in_progress", field(6), 5, {
      timeExpired: true,
      plusLaps: 2,
    }).kind,
    "none",
  );
});

test("timed-race remaining time subtracts completed pauses and freezes during an active pause", () => {
  const startedAt = new Date("2026-08-27T12:00:00.000Z");
  const pausedAt = new Date("2026-08-27T12:03:00.000Z");
  assert.equal(calculateRaceTimeRemainingMs({
    startedAt,
    pausedAt,
    totalPausedMs: 30_000,
    timeLimitMs: 10 * 60_000,
    timeExpiredAt: null,
  }, new Date("2026-08-27T12:08:00.000Z").getTime()), 7.5 * 60_000);

  assert.equal(calculateRaceTimeRemainingMs({
    startedAt,
    pausedAt: null,
    totalPausedMs: 30_000,
    timeLimitMs: 10 * 60_000,
    timeExpiredAt: new Date("2026-08-27T12:10:30.000Z"),
  }), 0);
});

test("an expiry-only moto update publishes an authoritative announcer snapshot", () => {
  assert.equal(shouldPublishAnnouncerSnapshotForMotoPatch({
    timeExpiredAt: "2026-08-27T12:10:00.000Z",
  }), true);
  assert.equal(shouldPublishAnnouncerSnapshotForMotoPatch({ name: "Heat 2" }), false);
});