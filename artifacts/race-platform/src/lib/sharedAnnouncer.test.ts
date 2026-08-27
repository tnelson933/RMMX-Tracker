import assert from "node:assert/strict";
import test from "node:test";
import {
  announcementStartOffsetSeconds,
  appendAnnouncementTask,
  isCurrentAnnouncementGeneration,
  sharedAnnouncerMotoId,
  shouldAcceptAnnouncement,
  shouldQueueAnnouncementAudio,
  type SharedAnnouncement,
} from "./sharedAnnouncer.ts";

const announcement: SharedAnnouncement = {
  sequence: 4,
  audioUrl: "/api/timing/announcer-audio/1-4",
  label: "Lap 4 announced",
  createdAt: new Date(Date.now() - 2_000).toISOString(),
};

test("accepts each shared announcement only once across reconnect delivery", () => {
  assert.equal(shouldAcceptAnnouncement(3, announcement), true);
  assert.equal(shouldAcceptAnnouncement(4, announcement), false);
  assert.equal(shouldAcceptAnnouncement(5, announcement), false);
});

test("preserves local mute control without changing the shared event cursor", () => {
  assert.equal(shouldAcceptAnnouncement(3, announcement), true);
  assert.equal(shouldQueueAnnouncementAudio(false), false);
  assert.equal(shouldQueueAnnouncementAudio(true), true);
});

test("starts an active shared clip near its current broadcast position", () => {
  const offset = announcementStartOffsetSeconds(announcement);
  assert.ok(offset >= 1.5 && offset <= 3);
});

test("delivers clips in server sequence even when later work is ready first", async () => {
  const delivered: number[] = [];
  let tail = Promise.resolve();
  tail = appendAnnouncementTask(tail, async () => {
    await new Promise(resolve => setTimeout(resolve, 10));
    delivered.push(1);
  });
  tail = appendAnnouncementTask(tail, async () => {
    delivered.push(2);
  });
  await tail;
  assert.deepEqual(delivered, [1, 2]);
});

test("a failed clip does not block the next shared announcement", async () => {
  const delivered: number[] = [];
  let tail = appendAnnouncementTask(Promise.resolve(), async () => {
    throw new Error("audio unavailable");
  });
  tail = appendAnnouncementTask(tail, async () => {
    delivered.push(2);
  });
  await tail;
  assert.deepEqual(delivered, [2]);
});

test("discards queued audio after switching to another moto", () => {
  assert.equal(isCurrentAnnouncementGeneration(8, 7), false);
  assert.equal(isCurrentAnnouncementGeneration(8, 8), true);
});

test("keeps the announcer connected while a delayed finish clip is generated", async () => {
  const inProgressId = sharedAnnouncerMotoId({ id: 42, status: "in_progress" });
  const delivered: string[] = [];
  const delayedFinish = appendAnnouncementTask(Promise.resolve(), async () => {
    await new Promise(resolve => setTimeout(resolve, 10));
    delivered.push("finish");
  });

  const completedId = sharedAnnouncerMotoId({ id: 42, status: "completed" });
  assert.equal(completedId, inProgressId);
  await delayedFinish;
  assert.deepEqual(delivered, ["finish"]);
});

test("a late viewer can subscribe to the retained completion announcement", () => {
  assert.equal(sharedAnnouncerMotoId({ id: 42, status: "completed" }), 42);
  assert.equal(sharedAnnouncerMotoId({ id: 42, status: "scheduled" }), null);
});
