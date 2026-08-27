import assert from "node:assert/strict";
import test from "node:test";
import {
  buildAnnouncementScript,
// Node's built-in type-stripping test runner requires the explicit extension.
// @ts-expect-error TypeScript's bundler resolution does not allow it by default.
} from "./announcerScript.ts";

const top5 = [
  {
    position: 1,
    riderName: "Blake Leader",
    laps: 4,
    lastLap: "1:01.20",
    totalTime: "12:34.50",
    gap: "Leader",
    dnf: false,
    dns: false,
  },
  {
    position: 2,
    riderName: "Casey Chaser",
    laps: 4,
    lastLap: "1:02.00",
    totalTime: "12:37.00",
    gap: "+0:02.50",
    dnf: false,
    dns: false,
  },
];

function withRandom<T>(value: number, fn: () => T): T {
  const original = Math.random;
  Math.random = () => value;
  try {
    return fn();
  } finally {
    Math.random = original;
  }
}

test("lap and finish scripts use lap times and gaps, never cumulative race time", () => {
  for (const random of [0, 0.24, 0.49, 0.74, 0.99]) {
    const lapScript = withRandom(random, () => buildAnnouncementScript({
      lapCompleted: 4,
      top5,
      positionChanges: [],
      kind: "lap",
      lapsRemaining: 2,
    }));
    assert.match(lapScript, /1 minute and 1 point 2 seconds/);
    assert.match(lapScript, /2 point 5 seconds back/);
    assert.doesNotMatch(lapScript, /12 minutes|34 point 5|elapsed|on the clock/i);

    const finishScript = withRandom(random, () => buildAnnouncementScript({
      lapCompleted: 6,
      top5,
      positionChanges: [],
      kind: "finish",
    }));
    assert.match(finishScript, /1 minute and 1 point 2 seconds/);
    assert.doesNotMatch(finishScript, /12 minutes|34 point 5|elapsed|on the clock/i);
  }
});

test("fixed-lap scripts use correct remaining-lap grammar", () => {
  const plural = buildAnnouncementScript({
    lapCompleted: 2,
    top5,
    positionChanges: [],
    kind: "lap",
    lapsRemaining: 3,
  });
  assert.match(plural, /three laps remaining/i);

  const singular = buildAnnouncementScript({
    lapCompleted: 4,
    top5,
    positionChanges: [],
    kind: "lap",
    lapsRemaining: 1,
  });
  assert.match(singular, /one lap remaining/i);
  assert.doesNotMatch(singular, /one laps/i);
});

test("timed scripts report pause-adjusted remaining time supplied by the snapshot", () => {
  const script = buildAnnouncementScript({
    lapCompleted: 3,
    top5,
    positionChanges: [],
    kind: "lap",
    timeRemainingMs: 125_000,
  });
  assert.match(script, /2 minutes and 5 seconds remaining/i);
});

test("timed expiry and post-expiry scripts use bounded extra-lap counts", () => {
  const expiry = buildAnnouncementScript({
    lapCompleted: 4,
    top5,
    positionChanges: [],
    kind: "time_expired",
    extraLapsRemaining: 2,
  });
  assert.match(expiry, /time is up|clock has expired|time limit is up/i);
  assert.match(expiry, /two extra laps remaining/i);

  const finalExtraLap = buildAnnouncementScript({
    lapCompleted: 6,
    top5,
    positionChanges: [],
    kind: "extra_lap",
    extraLapsRemaining: 0,
  });
  assert.match(finalExtraLap, /no extra laps remain/i);
  assert.doesNotMatch(finalExtraLap, /-\d/);
});