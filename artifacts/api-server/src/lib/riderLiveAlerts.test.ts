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
  const m = (id: number, status: string, motoNumber: number, doneAgo?: number) => ({ id, status, motoNumber, completedAt: doneAgo == null ? null : new Date(now - doneAgo) });
  assert.equal(pickRiderRace([m(1, "completed", 1, 60_000), m(2, "in_progress", 2), m(3, "scheduled", 3)], now)?.id, 2);
  assert.equal(pickRiderRace([m(1, "completed", 1, 60_000), m(3, "scheduled", 3)], now)?.id, 1);
  assert.equal(pickRiderRace([m(1, "completed", 1, SHOW_FINISHED_MS + 1), m(4, "scheduled", 5), m(3, "scheduled", 3)], now)?.id, 3);
  assert.equal(pickRiderRace([m(1, "completed", 1, SHOW_FINISHED_MS * 3), m(5, "completed", 2, SHOW_FINISHED_MS * 2)], now)?.id, 5);
  assert.equal(pickRiderRace([], now), null);
});
