import assert from "node:assert/strict";
import test from "node:test";
// @ts-expect-error Node's type-stripping runner requires the explicit extension.
import { motoIsLive, MOTO_LIVE_WINDOW_MS } from "./liveSession.ts";

const now = Date.parse("2026-10-28T22:00:00Z");
const ago = (ms: number) => new Date(now - ms);

test("a moto started minutes ago is live", () => {
  assert.equal(motoIsLive({ startedAt: ago(5 * 60_000) }, null, now), true);
});

test("a moto left in progress for months no longer takes reads", () => {
  assert.equal(motoIsLive({ startedAt: new Date("2026-07-01T20:05:47Z") }, null, now), false);
  assert.equal(motoIsLive({ startedAt: ago(MOTO_LIVE_WINDOW_MS + 1) }, null, now), false);
});

test("a practice started after the moto wins", () => {
  const moto = { startedAt: ago(60 * 60_000) };
  assert.equal(motoIsLive(moto, { startedAt: ago(10 * 60_000), createdAt: ago(10 * 60_000) }, now), false);
  // A moto started during a practice is the live session.
  assert.equal(motoIsLive(moto, { startedAt: ago(2 * 60 * 60_000), createdAt: ago(2 * 60 * 60_000) }, now), true);
});

test("a moto with no start time is not live", () => {
  assert.equal(motoIsLive({ startedAt: null }, null, now), false);
});
