// Run from scripts/: ./node_modules/.bin/tsx --test ../artifacts/rider-app/lib/*.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { aheadLabel, gateLabel, raceDayState, type RaceDayMoto } from "./raceDay";
import { momentLine, pickMoment, type MomentResult } from "./resultMoment";

const moto = (n: number, status: string, mine = false, extra: Partial<RaceDayMoto> = {}): RaceDayMoto => ({
  motoId: n, motoNumber: n, name: `Moto ${n}`, raceClass: "250 B", status, completedAt: null,
  isAnyFamilyMemberInMoto: mine, familyGates: mine ? [{ gate: 4, riderId: 1, riderName: "Sam Rider" }] : [], ...extra,
});

test("race day: next race, races before it, and what's on track", () => {
  const s = raceDayState([moto(1, "completed", true, { completedAt: "2026-11-24T10:00:00Z" }), moto(2, "in_progress"), moto(3, "scheduled"), moto(4, "scheduled", true)]);
  assert.equal(s.racing, null);
  assert.equal(s.next?.motoId, 4);
  assert.equal(s.racesAhead, 2);
  assert.equal(s.onTrack?.motoId, 2);
  assert.equal(s.done, 1);
  assert.equal(s.total, 2);
  assert.equal(s.lastDone?.motoId, 1);
  assert.equal(aheadLabel(s.racesAhead), "2 races before yours");
  assert.equal(aheadLabel(0), "You're up next");
});

test("race day: practice doesn't count, and a running race of mine is 'racing'", () => {
  const s = raceDayState([moto(1, "in_progress", true, { type: "practice" }), moto(2, "in_progress", true), moto(3, "scheduled", true)]);
  assert.equal(s.racing?.motoId, 2);
  assert.equal(s.next?.motoId, 3);
  assert.equal(s.racesAhead, 1);
  assert.equal(s.total, 2);
});

test("gate label names riders only when the account has several", () => {
  const m = moto(1, "scheduled", true);
  assert.equal(gateLabel(m, false), "Gate 4");
  assert.equal(gateLabel(m, true), "Gate 4 (Sam)");
  assert.equal(gateLabel(moto(2, "scheduled"), false), null);
});

const res = (eventId: number, date: string, pos: number | null, riderName?: string): MomentResult =>
  ({ eventId, eventName: `Race ${eventId}`, eventDate: date, raceClass: "250 B", bestPosition: pos, riderName });

test("moments: a recent win or podium, once", () => {
  const h = [res(1, "2026-11-01", 5), res(2, "2026-11-22", 2)];
  const m = pickMoment(h, new Set(), "2026-11-24");
  assert.equal(m?.kind, "podium");
  assert.equal(pickMoment(h, new Set([m!.key]), "2026-11-24"), null);
  assert.equal(pickMoment([res(3, "2026-11-23", 1)], new Set(), "2026-11-24")?.kind, "win");
});

test("moments: best finish yet needs an earlier race to beat; old races don't count", () => {
  assert.equal(pickMoment([res(1, "2026-11-22", 6)], new Set(), "2026-11-24"), null);
  assert.equal(pickMoment([res(1, "2026-10-01", 9), res(2, "2026-11-22", 6)], new Set(), "2026-11-24")?.kind, "best");
  assert.equal(pickMoment([res(1, "2026-10-01", 5), res(2, "2026-11-22", 6)], new Set(), "2026-11-24"), null);
  assert.equal(pickMoment([res(1, "2026-11-01", 1)], new Set(), "2026-11-24"), null);
  // Another rider's earlier results don't count against this one.
  assert.equal(pickMoment([res(1, "2026-10-01", 2, "Ann"), res(2, "2026-11-22", 6, "Sam"), res(3, "2026-10-05", 8, "Sam")], new Set(), "2026-11-24")?.kind, "best");
});

test("moment line", () => {
  assert.equal(momentLine({ key: "k", kind: "win", result: res(1, "2026-11-22", 1) }, null), "You won 250 B at Race 1.");
  assert.equal(momentLine({ key: "k", kind: "best", result: res(1, "2026-11-22", 6) }, "Sam"), "Sam finished P6 in 250 B at Race 1, their best yet.");
});
