// Run from scripts/: ./node_modules/.bin/tsx --test ../artifacts/rider-app/lib/*.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildReport, describeError, MAX_BODY_BYTES, MAX_STACK_CHARS, newInstallId, ReportGate, routeFromSegments, scrub, utf8Length,
} from "./errorReportCore";

const meta = {
  route: "/racer/[id]", appVersion: "1.0.24", runtimeVersion: "1.0.24", updateId: "u-1",
  platform: "android", osVersion: "34", installId: "abc",
};

test("report carries the error, its source and the app metadata", () => {
  const err = new TypeError("x is undefined");
  const body = JSON.parse(buildReport(err, { source: "global", fatal: true }, meta));
  assert.equal(body.message, "x is undefined");
  assert.equal(body.name, "TypeError");
  assert.equal(body.fatal, true);
  assert.equal(body.source, "global");
  assert.equal(body.route, "/racer/[id]");
  assert.equal(body.updateId, "u-1");
});

test("emails and bearer tokens are masked", () => {
  assert.equal(scrub("no rider for a.b@example.com"), "no rider for [email]");
  assert.equal(scrub("Authorization: Bearer abc.def"), "Authorization: Bearer [token]");
});

test("stack trimmed to 4 KB and body always under 8 KB, even with multi-byte text", () => {
  const ascii = new Error("boom");
  ascii.stack = "a".repeat(20_000);
  const b1 = buildReport(ascii, { source: "caught" }, meta);
  assert.ok(JSON.parse(b1).stack.length <= MAX_STACK_CHARS);
  const wide = new Error("💥".repeat(1000));
  wide.stack = "語".repeat(20_000);
  const b2 = buildReport(wide, { source: "caught" }, meta);
  assert.ok(utf8Length(b2) <= MAX_BODY_BYTES, `${utf8Length(b2)} bytes`);
  assert.equal(utf8Length(b2), Buffer.byteLength(b2, "utf8"));
});

test("context is reduced to a safe label", () => {
  const body = JSON.parse(buildReport(new Error("e"), { source: "caught", context: "results.parse<moto>!" }, meta));
  assert.equal(body.context, "results.parsemoto");
});

test("non-Error throwables are described", () => {
  assert.deepEqual(describeError("plain"), { name: null, message: "plain", stack: null });
  assert.equal(describeError({ code: 1 }).message, '{"code":1}');
});

test("gate: each distinct error once, at most 10 a session", () => {
  const g = new ReportGate(10);
  assert.equal(g.take("a"), true);
  assert.equal(g.take("a"), false);
  for (let i = 0; i < 9; i++) assert.equal(g.take(`k${i}`), true);
  assert.equal(g.take("one-more"), false);
});

test("route is the template and install id looks like a v4 uuid", () => {
  assert.equal(routeFromSegments(["(tabs)", "results"]), "/(tabs)/results");
  assert.match(newInstallId(), /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
});
