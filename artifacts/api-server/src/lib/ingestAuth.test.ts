import assert from "node:assert/strict";
import test from "node:test";
import { bearerToken, decideIngest, globalIngestEnforce, timingIngestAuthMode, type IngestPrincipal } from "./ingestAuth";

const reader = (clubId: number): IngestPrincipal => ({ kind: "reader", readerId: 1, clubId });
const organizer = (clubId: number | null): IngestPrincipal => ({ kind: "user", userId: 1, clubId, platformWide: false });
const superAdmin: IngestPrincipal = { kind: "user", userId: 1, clubId: null, platformWide: true };
const none: IngestPrincipal = { kind: "none" };

test("credentials for the target club are accepted in every mode", () => {
  for (const mode of ["off", "warn", "enforce"] as const) {
    assert.deepEqual(decideIngest(reader(7), 7, mode), { allow: true });
    assert.deepEqual(decideIngest(organizer(7), 7, mode), { allow: true });
    assert.deepEqual(decideIngest(superAdmin, 7, mode), { allow: true });
  }
});

test("credentials for a different club are rejected with 403 even when the club is off", () => {
  const r = decideIngest(reader(8), 7, "off");
  assert.equal(r.allow, false);
  assert.equal(!r.allow && r.status, 403);
  const u = decideIngest(organizer(8), 7, "off");
  assert.equal(!u.allow && u.status, 403);
});

test("unknown target club does not reject a credential", () => {
  assert.deepEqual(decideIngest(reader(8), null, "off"), { allow: true });
});

test("no credential follows the club mode", () => {
  assert.deepEqual(decideIngest(none, 7, "off"), { allow: true });
  assert.deepEqual(decideIngest(none, 7, "warn"), { allow: true });
  const enforced = decideIngest(none, 7, "enforce");
  assert.equal(!enforced.allow && enforced.status, 401);
});

test("an unknown bearer token counts as no credential: accepted until enforced", () => {
  assert.deepEqual(decideIngest("invalid_bearer", 7, "off"), { allow: true });
  assert.deepEqual(decideIngest("invalid_bearer", 7, "warn"), { allow: true });
  const r = decideIngest("invalid_bearer", 7, "enforce");
  assert.equal(!r.allow && r.status, 401);
});

test("TIMING_INGEST_ENFORCE turns enforcement on for every club; the kill switch wins", async () => {
  const saved = { e: process.env.TIMING_INGEST_ENFORCE, o: process.env.TIMING_INGEST_AUTH_OVERRIDE };
  try {
    delete process.env.TIMING_INGEST_AUTH_OVERRIDE;
    delete process.env.TIMING_INGEST_ENFORCE;
    assert.equal(globalIngestEnforce(), false);
    assert.equal(await timingIngestAuthMode(null), "off");
    process.env.TIMING_INGEST_ENFORCE = "1";
    assert.equal(globalIngestEnforce(), true);
    assert.equal(await timingIngestAuthMode(null), "enforce");
    process.env.TIMING_INGEST_AUTH_OVERRIDE = "off";
    assert.equal(await timingIngestAuthMode(null), "off");
  } finally {
    if (saved.e === undefined) delete process.env.TIMING_INGEST_ENFORCE; else process.env.TIMING_INGEST_ENFORCE = saved.e;
    if (saved.o === undefined) delete process.env.TIMING_INGEST_AUTH_OVERRIDE; else process.env.TIMING_INGEST_AUTH_OVERRIDE = saved.o;
  }
});

test("bearer token parsing", () => {
  assert.equal(bearerToken("Bearer abc-123"), "abc-123");
  assert.equal(bearerToken("bearer abc-123 "), "abc-123");
  assert.equal(bearerToken("Basic dXNlcjpwYXNz"), null);
  assert.equal(bearerToken("Bearer"), null);
  assert.equal(bearerToken(undefined), null);
});
