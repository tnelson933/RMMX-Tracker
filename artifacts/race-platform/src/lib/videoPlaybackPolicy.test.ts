import assert from "node:assert/strict";
import test from "node:test";
import {
  isVideoQueueOverLimit,
  isPlaybackStalled,
  MAX_CLIENT_QUEUE_BYTES,
  MAX_CLIENT_QUEUE_CHUNKS,
// @ts-expect-error Node's type-stripping runner requires the explicit extension.
} from "./videoPlaybackPolicy.ts";

test("allows a bounded live media queue", () => {
  assert.equal(isVideoQueueOverLimit(MAX_CLIENT_QUEUE_CHUNKS, MAX_CLIENT_QUEUE_BYTES), false);
});

test("forces clean-boundary recovery when chunks or bytes exceed the cap", () => {
  assert.equal(isVideoQueueOverLimit(MAX_CLIENT_QUEUE_CHUNKS + 1, 1), true);
  assert.equal(isVideoQueueOverLimit(1, MAX_CLIENT_QUEUE_BYTES + 1), true);
});

test("recovers a playing decoder that stops advancing without interrupting paused media", () => {
  assert.equal(isPlaybackStalled("playing", false, 12, 12), true);
  assert.equal(isPlaybackStalled("playing", true, 12, 12), false);
  assert.equal(isPlaybackStalled("buffering", false, 12, 12), false);
});