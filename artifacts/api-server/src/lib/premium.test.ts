import assert from "node:assert/strict";
import test from "node:test";
import { premiumActive, isRecentPractice, createWatchTicket, verifyWatchTicket, premiumRequired, NO_LIMIT } from "./premium";

test("Premium is active only until its end time", () => {
  const now = new Date("2026-11-18T12:00:00Z");
  assert.equal(premiumActive(null, now), false);
  assert.equal(premiumActive(new Date("2026-11-18T11:59:59Z"), now), false);
  assert.equal(premiumActive(new Date("2026-12-18T00:00:00Z"), now), true);
});

test("free riders keep the last 24 hours of practice", () => {
  const now = new Date("2026-11-18T12:00:00Z");
  assert.equal(isRecentPractice("2026-11-18T08:00:00Z", now), true);
  assert.equal(isRecentPractice("2026-11-17T11:00:00Z", now), false);
  assert.equal(isRecentPractice(null, now), false);
});

test("watch tickets carry who is watching and until when", () => {
  const t0 = Date.parse("2026-11-18T12:00:00Z");
  const ticket = createWatchTicket(60, { riderAccountId: 7, allowUntil: t0 + 3_600_000, free: true }, t0);
  assert.deepEqual(verifyWatchTicket(ticket, 60, t0 + 60_000), { riderAccountId: 7, allowUntil: t0 + 3_600_000, free: true });
  assert.equal(verifyWatchTicket(ticket, 61, t0 + 60_000), null);
  assert.equal(verifyWatchTicket(ticket, 60, t0 + 6 * 60_000), null);
  assert.equal(verifyWatchTicket(ticket.replace(/.$/, c => (c === "A" ? "B" : "A")), 60, t0), null);
  assert.equal(verifyWatchTicket(null, 60, t0), null);
  const staff = createWatchTicket(60, { riderAccountId: 0, allowUntil: NO_LIMIT, free: false }, t0);
  assert.equal(verifyWatchTicket(staff, 60, t0)?.free, false);
});

test("locked features say what Premium unlocks", () => {
  assert.equal(premiumRequired("Career stats").code, "premium_required");
});
