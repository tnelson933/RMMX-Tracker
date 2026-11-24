// Run from scripts/: ./node_modules/.bin/tsx --test ../artifacts/rider-app/lib/*.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  eventChip, fastestLapRiderId, fmtDelta, followMoto, furthestStatus, hasBikeNumbers, intervalAhead, todaysMotos,
  type ScheduleMoto, type TimingRow,
} from "./liveEvent";

const moto = (motoId: number, status: string, completedAt: string | null = null): ScheduleMoto =>
  ({ motoId, motoNumber: motoId, name: `Moto ${motoId}`, raceClass: null, status, startedAt: null, completedAt });

test("follows the running race, else the latest result, else the next race", () => {
  assert.equal(followMoto([moto(1, "completed", "2026-11-24T10:00:00Z"), moto(2, "in_progress"), moto(3, "scheduled")])?.motoId, 2);
  assert.equal(followMoto([moto(1, "completed", "2026-11-24T10:00:00Z"), moto(2, "completed", "2026-11-24T10:20:00Z"), moto(3, "scheduled")])?.motoId, 2);
  assert.equal(followMoto([moto(1, "scheduled"), moto(2, "scheduled")])?.motoId, 1);
  assert.equal(followMoto([]), null);
});

test("LIVE only while a race runs", () => {
  assert.equal(eventChip("race_day", [moto(1, "in_progress")]).kind, "live");
  assert.equal(eventChip("race_day", [moto(1, "scheduled")]).label, "Race day");
  assert.equal(eventChip("race_day", [moto(1, "completed")]).label, "Finished");
  assert.equal(eventChip("completed", []).label, "Finished");
  assert.equal(eventChip("registration_open", []).kind, "upcoming");
});

test("today's motos drop races finished on an earlier day", () => {
  const now = new Date(2026, 10, 24, 12);
  const yesterday = new Date(2026, 10, 23, 12).toISOString();
  const today = new Date(2026, 10, 24, 9).toISOString();
  assert.deepEqual(todaysMotos([moto(1, "completed", yesterday), moto(2, "completed", today), moto(3, "scheduled")], now).map(m => m.motoId), [2, 3]);
  // A finished event looked at later still shows its races.
  assert.deepEqual(todaysMotos([moto(1, "completed", yesterday)], now).map(m => m.motoId), [1]);
});

test("status takes whichever source is further along", () => {
  assert.equal(furthestStatus("scheduled", "in_progress"), "in_progress");
  assert.equal(furthestStatus("completed", "in_progress"), "completed");
  assert.equal(furthestStatus("in_progress", undefined), "in_progress");
});

const row = (p: Partial<TimingRow>): TimingRow =>
  ({ position: null, riderId: null, bibNumber: null, laps: 0, totalMs: null, bestLapMs: null, dnf: false, dns: false, ...p });

test("interval to the rider ahead, in time or laps, skipping DNFs", () => {
  const rows = [
    row({ riderId: 1, laps: 5, totalMs: 300_000 }),
    row({ riderId: 2, laps: 5, totalMs: 300_512 }),
    row({ riderId: 3, dnf: true, laps: 2, totalMs: 120_000 }),
    row({ riderId: 4, laps: 5, totalMs: 362_857 }),
    row({ riderId: 5, laps: 3, totalMs: 200_000 }),
  ];
  assert.equal(intervalAhead(rows, 0), null);
  assert.equal(intervalAhead(rows, 1), "+0.512");
  assert.equal(intervalAhead(rows, 2), null);
  assert.equal(intervalAhead(rows, 3), "+1:02.345");
  assert.equal(intervalAhead(rows, 4), "+2 laps");
  assert.equal(fmtDelta(12_040), "12.040");
});

test("fastest lap holder and the plate column", () => {
  assert.equal(fastestLapRiderId([row({ riderId: 1, bestLapMs: 61_000 }), row({ riderId: 2, bestLapMs: 60_500 }), row({ riderId: 3 })]), 2);
  assert.equal(fastestLapRiderId([row({ riderId: 1 })]), null);
  assert.equal(hasBikeNumbers([{ bibNumber: null }, { bibNumber: " " }]), false);
  assert.equal(hasBikeNumbers([{ bibNumber: null }, { bibNumber: "23" }]), true);
});
