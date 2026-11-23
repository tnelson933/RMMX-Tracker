import assert from "node:assert/strict";
import test from "node:test";
import { ErrorAlertThrottle, summaryText } from "./serverErrorAlerts";
import { opsSmsEnabled, sendOpsText } from "./opsAlerts";
import { readerHint } from "./ingestAuth";

const MIN = 60_000;
const T0 = 1_000_000_000;

test("first error texts at once; later ones in the window are counted, not texted", () => {
  const t = new ErrorAlertThrottle(15 * MIN);
  assert.deepEqual(t.record("GET /api/events/:id", T0), { count: 1, topRoute: "GET /api/events/:id", topRouteCount: 1, routes: 1 });
  for (let i = 1; i <= 5; i++) assert.equal(t.record("POST /api/timing/crossing", T0 + i * MIN), null);
  assert.equal(t.record("GET /api/events/:id", T0 + 6 * MIN), null);
  assert.equal(t.flush(T0 + 14 * MIN), null, "still inside the window");
  assert.equal(t.msUntilFlush(T0 + 14 * MIN), MIN);
  const summary = t.flush(T0 + 15 * MIN);
  assert.deepEqual(summary, { count: 6, topRoute: "POST /api/timing/crossing", topRouteCount: 5, routes: 2 });
  assert.equal(t.flush(T0 + 31 * MIN), null, "nothing waiting");
  assert.equal(t.msUntilFlush(T0 + 31 * MIN), null);
});

test("at most one summary per window under a burst", () => {
  const t = new ErrorAlertThrottle(15 * MIN);
  let sends = 0;
  for (let s = 0; s < 60 * 60; s++) {
    if (t.record("GET /x", T0 + s * 1000)) sends++;
  }
  assert.equal(sends, 4, "one per 15 minutes over an hour");
});

test("an error after a quiet window texts immediately with what was waiting", () => {
  const t = new ErrorAlertThrottle(15 * MIN);
  t.record("GET /a", T0);
  t.record("GET /a", T0 + MIN);
  const s = t.record("GET /b", T0 + 20 * MIN);
  assert.equal(s?.count, 2);
});

test("summary text names the count and top route", () => {
  const text = summaryText({ count: 6, topRoute: "POST /api/timing/crossing", topRouteCount: 5, routes: 2 }, 15);
  assert.match(text, /6 server errors across 2 routes/);
  assert.match(text, /POST \/api\/timing\/crossing \(5\)/);
});

test("ops texts only in production unless the override is on", async () => {
  assert.equal(opsSmsEnabled("RACE_WATCHDOG_SMS", { NODE_ENV: "development" }), false);
  assert.equal(opsSmsEnabled("RACE_WATCHDOG_SMS", { NODE_ENV: "development", RACE_WATCHDOG_SMS: "on" }), true);
  assert.equal(opsSmsEnabled("RACE_WATCHDOG_SMS", { NODE_ENV: "production" }), true);

  const sent: string[] = [];
  const stub = async (text: string) => { sent.push(text); return 1; };
  assert.deepEqual(await sendOpsText("x", "hello", "RACE_WATCHDOG_SMS", stub, { NODE_ENV: "test" }), { sent: 0, skipped: true });
  assert.deepEqual(sent, []);
  assert.deepEqual(await sendOpsText("x", "hello", "RACE_WATCHDOG_SMS", stub, { NODE_ENV: "production" }), { sent: 1, skipped: false });
  assert.deepEqual(sent, ["hello"]);
  const failing = async () => { throw new Error("twilio down"); };
  assert.deepEqual(await sendOpsText("x", "hello", "RACE_WATCHDOG_SMS", failing, { NODE_ENV: "production" }), { sent: 0, skipped: false });
});

test("unauthenticated ingest names the reader from its payload", () => {
  assert.deepEqual(readerHint({ rfidNumber: "1", readerId: "gate-1", source: "rm_connect" }), { readerId: "gate-1", source: "rm_connect" });
  assert.deepEqual(readerHint({ events: [{ hostname: "impinj-14-1b-8f" }] }), { readerId: "impinj-14-1b-8f", source: undefined });
  assert.deepEqual(readerHint(undefined), {});
});
