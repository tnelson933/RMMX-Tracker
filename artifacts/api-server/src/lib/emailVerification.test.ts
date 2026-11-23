import assert from "node:assert/strict";
import test from "node:test";
import { checkCode, codeCheckMessage, CODE_TTL_MS, generateCode, hashCode, MAX_CODE_ATTEMPTS, normalizeCode, SendLimiter } from "./emailVerification";

const now = new Date("2026-11-23T12:00:00Z");
const pending = (over: Partial<{ codeHash: string | null; expiresAt: Date | null; attempts: number }> = {}) => ({
  accountId: 7,
  codeHash: hashCode(7, "123456"),
  expiresAt: new Date(now.getTime() + CODE_TTL_MS),
  attempts: 1,
  ...over,
});

test("codes are 6 digits", () => {
  for (let i = 0; i < 200; i++) assert.match(generateCode(), /^\d{6}$/);
});

test("the hash depends on the account, and never contains the code", () => {
  assert.notEqual(hashCode(7, "123456"), hashCode(8, "123456"));
  assert.ok(!hashCode(7, "123456").includes("123456"));
});

test("typed codes tolerate spaces and dashes, nothing else", () => {
  assert.equal(normalizeCode(" 123 456 "), "123456");
  assert.equal(normalizeCode("123-456"), "123456");
  assert.equal(normalizeCode("12345"), null);
  assert.equal(normalizeCode("12345a"), null);
  assert.equal(normalizeCode(undefined), null);
});

test("the right code passes", () => {
  assert.deepEqual(checkCode(pending(), "123456", now), { ok: true });
});

test("another account's code fails", () => {
  assert.equal(checkCode({ ...pending(), accountId: 8 }, "123456", now).ok, false);
});

test("a wrong code says how many tries are left", () => {
  assert.deepEqual(checkCode(pending({ attempts: 1 }), "000000", now), { ok: false, reason: "wrong", attemptsLeft: 4 });
  assert.deepEqual(checkCode(pending({ attempts: 4 }), "000000", now), { ok: false, reason: "wrong", attemptsLeft: 1 });
});

test("the 5th wrong code locks; after that even the right code fails", () => {
  assert.deepEqual(checkCode(pending({ attempts: MAX_CODE_ATTEMPTS }), "000000", now), { ok: false, reason: "locked" });
  assert.deepEqual(checkCode(pending({ attempts: MAX_CODE_ATTEMPTS + 1 }), "123456", now), { ok: false, reason: "locked" });
});

test("the right code on the 5th try still passes", () => {
  assert.deepEqual(checkCode(pending({ attempts: MAX_CODE_ATTEMPTS }), "123456", now), { ok: true });
});

test("codes expire after 15 minutes", () => {
  const p = pending({ expiresAt: new Date(now.getTime() + CODE_TTL_MS) });
  assert.deepEqual(checkCode(p, "123456", new Date(now.getTime() + CODE_TTL_MS - 1)), { ok: true });
  assert.deepEqual(checkCode(p, "123456", new Date(now.getTime() + CODE_TTL_MS)), { ok: false, reason: "expired" });
});

test("no pending code", () => {
  assert.deepEqual(checkCode(pending({ codeHash: null }), "123456", now), { ok: false, reason: "none" });
});

test("every failure has a plain message", () => {
  assert.match(codeCheckMessage({ ok: false, reason: "wrong", attemptsLeft: 1 }), /1 try left/);
  assert.match(codeCheckMessage({ ok: false, reason: "locked" }), /Resend/);
  assert.match(codeCheckMessage({ ok: false, reason: "expired" }), /expired/);
});

test("send limiter: 1 a minute, 5 an hour", () => {
  const l = new SendLimiter([{ max: 1, windowMs: 60_000 }, { max: 5, windowMs: 3_600_000 }]);
  const t0 = 1_000_000;
  assert.equal(l.take("a", t0), 0);
  assert.equal(l.take("a", t0 + 30_000), 30_000);
  assert.equal(l.take("b", t0 + 30_000), 0, "other keys are independent");
  for (let i = 1; i <= 4; i++) assert.equal(l.take("a", t0 + i * 60_000), 0);
  // 5 sends in the hour: the 6th waits until the first is an hour old.
  assert.equal(l.take("a", t0 + 5 * 60_000), 3_600_000 - 5 * 60_000);
  assert.equal(l.take("a", t0 + 3_600_000), 0);
});

test("a refused send isn't counted", () => {
  const l = new SendLimiter([{ max: 1, windowMs: 60_000 }]);
  assert.equal(l.take("a", 0), 0);
  assert.ok(l.take("a", 59_000) > 0);
  assert.equal(l.take("a", 60_000), 0);
});
