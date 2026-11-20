import { test } from "node:test";
import assert from "node:assert/strict";
import { ALERT_GAP_MS, claimRiderLiveAlert, riderLiveMessage } from "./riderLiveAlerts";
import { createRiderBroadcastTicket, createRiderWatchTicket, verifyBroadcastTicket, riderChannel, RIDER_CAMERA, getLiveEvents } from "./videoRelay";

test("a rider's live alert goes out once per stream, not on a quick restart", () => {
  const seen = new Map<number, number>();
  assert.equal(claimRiderLiveAlert(5, 1_000, seen), true);
  assert.equal(claimRiderLiveAlert(5, 1_000 + 60_000, seen), false);
  assert.equal(claimRiderLiveAlert(6, 1_000 + 60_000, seen), true);
  assert.equal(claimRiderLiveAlert(5, 1_000 + ALERT_GAP_MS, seen), true);
});

test("rider live push text", () => {
  assert.deepEqual(riderLiveMessage("Jake Smith"), { title: "Jake Smith is racing live", body: "Watch Jake's live video now." });
});

test("rider tickets: broadcast and watch tickets are not interchangeable, and riders differ", () => {
  const b = createRiderBroadcastTicket(7);
  const w = createRiderWatchTicket(7);
  assert.equal(verifyBroadcastTicket(b, riderChannel(7), RIDER_CAMERA), true);
  assert.equal(verifyBroadcastTicket(w, riderChannel(7), RIDER_CAMERA), false);
  assert.equal(verifyBroadcastTicket(w, riderChannel(7), "watch"), true);
  assert.equal(verifyBroadcastTicket(b, riderChannel(8), RIDER_CAMERA), false);
  assert.equal(verifyBroadcastTicket(b, 7, RIDER_CAMERA), false); // not an event's camera
  assert.deepEqual(getLiveEvents(), []);
});

import { pickRiderRace, SHOW_FINISHED_MS } from "./riderRace";
test("overlay race: running first, then just finished, then next up, then last finished", () => {
  const now = 1_000_000_000;
  const m = (id: number, status: string, motoNumber: number, doneAgo?: number) => ({ id, eventId: 1, status, motoNumber, completedAt: doneAgo == null ? null : new Date(now - doneAgo) });
  assert.equal(pickRiderRace([m(1, "completed", 1, 60_000), m(2, "in_progress", 2), m(3, "scheduled", 3)], now)?.id, 2);
  assert.equal(pickRiderRace([m(1, "completed", 1, 60_000), m(3, "scheduled", 3)], now)?.id, 1);
  assert.equal(pickRiderRace([m(1, "completed", 1, SHOW_FINISHED_MS + 1), m(4, "scheduled", 5), m(3, "scheduled", 3)], now)?.id, 3);
  assert.equal(pickRiderRace([m(1, "completed", 1, SHOW_FINISHED_MS * 3), m(5, "completed", 2, SHOW_FINISHED_MS * 2)], now)?.id, 5);
  assert.equal(pickRiderRace([], now), null);
});

import { goLiveWindow, LIVE_AFTER_FINALIZED_MS, LIVE_AFTER_FINISH_MS } from "./riderRace";
test("Go Live: race day, within 2 races, and until 5 minutes after the race is finalized", () => {
  const now = 2_000_000_000;
  const r = (id: number, motoNumber: number, status: string, extra: { completedAt?: number; finalizedAt?: number; eventId?: number } = {}) => ({
    id, eventId: extra.eventId ?? 1, motoNumber, status,
    completedAt: extra.completedAt != null ? new Date(extra.completedAt) : null,
    resultsFinalizedAt: extra.finalizedAt != null ? new Date(extra.finalizedAt) : null,
  });
  const day = (mineStatus: string, extra = {}) => [
    r(1, 1, "completed", { completedAt: now - 3_600_000, finalizedAt: now - 3_500_000 }),
    r(2, 2, "in_progress"), r(3, 3, "scheduled"), r(4, 4, "scheduled"), r(5, 5, mineStatus, extra), r(6, 6, "scheduled"),
  ];
  // Three unfinished races before theirs: not yet.
  let w = goLiveWindow(day("scheduled"), new Set([5]), now);
  assert.equal(w.allowed, false); assert.equal(w.reason, "too_early"); assert.equal(w.racesAhead, 3);
  // Two before (one finished meanwhile): open.
  const twoAhead = day("scheduled"); twoAhead[1].status = "completed"; twoAhead[1].completedAt = new Date(now - 60_000);
  w = goLiveWindow(twoAhead, new Set([5]), now);
  assert.equal(w.allowed, true); assert.equal(w.reason, "up_soon"); assert.equal(w.racesAhead, 2);
  // Racing: open, no end.
  w = goLiveWindow(day("in_progress"), new Set([5]), now);
  assert.equal(w.allowed, true); assert.equal(w.reason, "racing"); assert.equal(w.endsAt, null);
  // Finished and finalized 2 minutes ago: open until finalized + 5 min.
  w = goLiveWindow(day("completed", { completedAt: now - 300_000, finalizedAt: now - 120_000 }), new Set([5]), now);
  assert.equal(w.allowed, true); assert.equal(w.reason, "race_finished");
  assert.equal(w.endsAt?.getTime(), now - 120_000 + LIVE_AFTER_FINALIZED_MS);
  // Finalized 6 minutes ago: closed.
  w = goLiveWindow(day("completed", { completedAt: now - 600_000, finalizedAt: now - 360_000 }), new Set([5]), now);
  assert.equal(w.allowed, false); assert.equal(w.reason, "race_ended");
  // Finished, never finalized: closes 30 minutes after it finished.
  w = goLiveWindow(day("completed", { completedAt: now - LIVE_AFTER_FINISH_MS + 60_000 }), new Set([5]), now);
  assert.equal(w.allowed, true);
  w = goLiveWindow(day("completed", { completedAt: now - LIVE_AFTER_FINISH_MS - 1 }), new Set([5]), now);
  assert.equal(w.allowed, false);
  // Finished one race, next one is 1 race away: open again for the next.
  const second = [...day("completed", { completedAt: now - 3_000_000, finalizedAt: now - 2_900_000 }), r(7, 7, "scheduled")];
  second[1].status = "completed"; second[2].status = "completed"; second[3].status = "completed"; second[5].status = "in_progress";
  w = goLiveWindow(second, new Set([5, 7]), now);
  assert.equal(w.allowed, true); assert.equal(w.reason, "up_soon"); assert.equal(w.racesAhead, 1);
  // Races at another event don't count toward "races ahead"; no race of theirs today: closed.
  w = goLiveWindow([r(9, 1, "scheduled", { eventId: 2 }), ...day("scheduled")], new Set([5]), now);
  assert.equal(w.racesAhead, 3);
  w = goLiveWindow(day("scheduled"), new Set([99]), now);
  assert.equal(w.reason, "no_race_today");
});
