import assert from "node:assert/strict";
import test from "node:test";
import {
  bibSpeech,
  buildAnnouncement,
  gapMs,
  gapSpeech,
  lastName,
// Node's built-in type-stripping test runner requires the explicit extension.
// @ts-expect-error TypeScript's bundler resolution does not allow it by default.
} from "./announcerScript.ts";

const rider = (position: number, riderName: string, gap: string, bibNumber: string | null = null, laps = 4) => ({
  position, riderName, bibNumber, laps, lastLap: "1:01.20", gap, dnf: false, dns: false,
});

const field = [
  rider(1, "Blake Leader", "Leader", "23"),
  rider(2, "Casey Chaser", "+0:04.20", "123"),
  rider(3, "Drew Third", "+0:09.80", "07"),
];

function each<T>(fn: () => T): T[] {
  const original = Math.random;
  try {
    return [0, 0.34, 0.67, 0.99].map(v => { Math.random = () => v; return fn(); });
  } finally {
    Math.random = original;
  }
}

test("numbers are said the racing way", () => {
  assert.equal(bibSpeech("7"), "seven");
  assert.equal(bibSpeech("07"), "oh-seven");
  assert.equal(bibSpeech("23"), "twenty-three");
  assert.equal(bibSpeech("123"), "one twenty-three");
  assert.equal(bibSpeech("105"), "one oh-five");
  assert.equal(bibSpeech("100"), "one hundred");
  assert.equal(bibSpeech("23X"), "23X");
  assert.equal(bibSpeech(""), null);
});

test("gaps are parsed exactly and called in round numbers", () => {
  assert.equal(gapMs("+0:02.96"), 2960);
  assert.equal(gapMs("+1:05.3"), 65300);
  assert.equal(gapMs("Leader"), null);
  assert.equal(gapMs("+1 lap"), null);
  assert.equal(gapSpeech(300), "just a few tenths");
  assert.equal(gapSpeech(800), "less than a second");
  assert.equal(gapSpeech(1200), "a second");
  assert.equal(gapSpeech(2960), "three seconds");
  assert.equal(gapSpeech(65300), "a minute and five");
});

test("riders go by last name", () => {
  assert.equal(lastName("Blake Leader"), "Leader");
  assert.equal(lastName("Sam Rider Jr."), "Rider");
});

test("calls never read lap times or the race clock", () => {
  for (const kind of ["lap", "finish"] as const) {
    for (const { text } of each(() => buildAnnouncement({ lapCompleted: 3, top5: field, positionChanges: [], kind, lapsRemaining: 5 }))) {
      assert.doesNotMatch(text, /1 minute|point|1:01|lap time/i);
    }
  }
});

test("a lead change is the story, with who was passed", () => {
  for (const call of each(() => buildAnnouncement({
    lapCompleted: 3,
    top5: [rider(1, "Casey Chaser", "Leader", "123"), rider(2, "Blake Leader", "+0:00.80", "23")],
    positionChanges: [{ riderName: "Casey Chaser", from: 2, to: 1, passedName: "Blake Leader" }],
    kind: "lap",
    lapsRemaining: 5,
  }))) {
    assert.match(call.text, /lead|out front/i);
    assert.match(call.text, /Chaser/);
    assert.equal(call.mood, "excited");
  }
});

test("podium passes name the rider passed; back-of-field shuffles are ignored", () => {
  const [call] = each(() => buildAnnouncement({
    lapCompleted: 3,
    top5: field,
    positionChanges: [
      { riderName: "Drew Third", from: 4, to: 3, passedName: "Eli Fourth" },
      { riderName: "Finn Ninth", from: 10, to: 9, passedName: "Gus Tenth" },
    ],
    kind: "lap",
    lapsRemaining: 5,
  }));
  assert.match(call.text, /Third .*Fourth|Fourth.*Third/);
  assert.doesNotMatch(call.text, /Ninth|Tenth/);
});

test("the white flag and the finish build the energy", () => {
  const white = buildAnnouncement({ lapCompleted: 5, top5: field, positionChanges: [], kind: "lap", lapsRemaining: 1 });
  assert.match(white.text, /white flag|last lap|one to go/i);
  assert.equal(white.mood, "excited");

  for (const finish of each(() => buildAnnouncement({ lapCompleted: 6, top5: field, positionChanges: [], kind: "finish", raceClass: "250 B", typeLabel: "main event" }))) {
    assert.match(finish.text, /twenty-three|Blake Leader/);
    assert.match(finish.text, /Chaser/);
    assert.equal(finish.mood, "peak");
  }
});

test("a close fight for the lead is called on any lap", () => {
  const close = [rider(1, "Blake Leader", "Leader"), rider(2, "Casey Chaser", "+0:00.60")];
  const call = buildAnnouncement({ lapCompleted: 4, top5: close, positionChanges: [], kind: "lap", lapsRemaining: 6 });
  assert.match(call.text, /Chaser/);
  assert.equal(call.mood, "rising");
});

test("quiet laps are skipped every other lap, but countdowns are always called", () => {
  const quiet = buildAnnouncement({ lapCompleted: 4, top5: field, positionChanges: [], kind: "lap", lapsRemaining: 6 });
  assert.equal(quiet.text, "");
  const twoToGo = buildAnnouncement({ lapCompleted: 4, top5: field, positionChanges: [], kind: "lap", lapsRemaining: 2 });
  assert.match(twoToGo.text, /two laps to go/i);
});

test("timed races call the flag and the extra laps", () => {
  assert.match(buildAnnouncement({ lapCompleted: 8, top5: field, positionChanges: [], kind: "time_expired", extraLapsRemaining: 1 }).text, /white flag|last lap|one lap/i);
  assert.match(buildAnnouncement({ lapCompleted: 8, top5: field, positionChanges: [], kind: "time_expired", extraLapsRemaining: 2 }).text, /two more laps/i);
  assert.match(buildAnnouncement({ lapCompleted: 2, top5: field, positionChanges: [], kind: "lap", timeRemainingMs: 45_000 }).text, /under a minute/i);
});
