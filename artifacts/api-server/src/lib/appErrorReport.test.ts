import assert from "node:assert/strict";
import test from "node:test";
import {
  MAX_BODY_BYTES,
  MAX_STACK_CHARS,
  parseAppErrorReport,
  ReportRateLimiter,
  scrubText,
  UpdateErrorCounter,
} from "./appErrorReport";

const valid = {
  message: "Cannot read property 'laps' of undefined",
  name: "TypeError",
  stack: "TypeError: Cannot read property 'laps'\n    at fetchDetail (index.bundle:1:2345)",
  source: "global",
  fatal: false,
  route: "/(tabs)/results",
  appVersion: "1.0.24",
  runtimeVersion: "1.0.24",
  updateId: "0f6e3c1a-1111-4222-8333-944445555666",
  platform: "android",
  osVersion: "14",
  installId: "a1b2c3d4-e5f6-4789-8abc-def012345678",
};

test("a valid report keeps only allowlisted fields", () => {
  const r = parseAppErrorReport({ ...valid, email: "rider@example.com", token: "secret" });
  assert.ok(r.ok);
  assert.equal(r.report.message, valid.message);
  assert.equal(r.report.route, "/(tabs)/results");
  assert.equal(r.report.updateId, valid.updateId);
  assert.equal(r.report.fatal, false);
  assert.equal(r.report.context, null);
  assert.ok(!("email" in r.report) && !("token" in r.report));
});

test("message is required and must be a string", () => {
  for (const body of [{}, { message: "" }, { message: "   " }, { message: 42 }, null, [], "text"]) {
    const r = parseAppErrorReport(body);
    assert.equal(r.ok, false, JSON.stringify(body));
    if (!r.ok) assert.equal(r.status, 400);
  }
});

test("a wrong-typed or malformed field is a 400", () => {
  const bad = [
    { stack: 123 },
    { fatal: "yes" },
    { platform: "windows" },
    { source: "elsewhere" },
    { updateId: "../../etc" },
    { route: "/racer/<script>" },
    { context: "drop table;" },
  ];
  for (const extra of bad) {
    const r = parseAppErrorReport({ ...valid, ...extra });
    assert.equal(r.ok, false, JSON.stringify(extra));
    if (!r.ok) assert.equal(r.status, 400);
  }
});

test("over 8 KB is a 413, by declared length or by the parsed body", () => {
  const big = parseAppErrorReport({ ...valid, stack: "x".repeat(MAX_BODY_BYTES) });
  assert.equal(big.ok, false);
  if (!big.ok) assert.equal(big.status, 413);
  const declared = parseAppErrorReport(valid, MAX_BODY_BYTES + 1);
  assert.equal(declared.ok, false);
  if (!declared.ok) assert.equal(declared.status, 413);
});

test("long strings are trimmed: stack to 4 KB, message to 500 chars", () => {
  const r = parseAppErrorReport({ message: "m".repeat(2000), stack: "s".repeat(MAX_STACK_CHARS + 500) });
  assert.ok(r.ok);
  assert.ok(r.report.message.length <= 501);
  assert.ok((r.report.stack ?? "").length <= MAX_STACK_CHARS + 1);
});

test("emails and token-like strings are masked", () => {
  assert.equal(scrubText("no account for jo.rider+1@example.co.uk"), "no account for [email]");
  assert.equal(scrubText("header Bearer abc.def-123"), "header Bearer [token]");
  assert.match(scrubText(`key ${"A".repeat(40)} failed`), /key \[token\] failed/);
  const r = parseAppErrorReport({ message: "HTTP 401 for rider@example.com", stack: "at x (rider@example.com)" });
  assert.ok(r.ok);
  assert.ok(!r.report.message.includes("@") && !(r.report.stack ?? "").includes("@"));
});

test("rate limiter allows max per window per key", () => {
  const l = new ReportRateLimiter(3, 60_000);
  const t0 = 1_000_000;
  assert.deepEqual([1, 2, 3, 4].map(() => l.allow("a", t0)), [true, true, true, false]);
  assert.equal(l.allow("b", t0), true, "other addresses unaffected");
  assert.equal(l.allow("a", t0 + 60_000), true, "next window");
});

test("per-update counter counts separately and treats no update as embedded", () => {
  const c = new UpdateErrorCounter();
  assert.equal(c.increment("u1"), 1);
  assert.equal(c.increment("u1"), 2);
  assert.equal(c.increment(null), 1);
  assert.equal(c.increment("u2"), 1);
});
