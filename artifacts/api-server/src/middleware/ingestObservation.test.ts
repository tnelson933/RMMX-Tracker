import assert from "node:assert/strict";
import test from "node:test";
import { classifyIngestCredential, classifyIngestRoute } from "./ingestObservation";

test("ingest routes are recognized only for POST", () => {
  assert.equal(classifyIngestRoute("POST", "/timing/readers/abc-123/crossing"), "reader_token_crossing");
  assert.equal(classifyIngestRoute("POST", "/timing/readers/abc-123/active/crossing"), "reader_token_active_crossing");
  assert.equal(classifyIngestRoute("POST", "/timing/readers/abc-123/ping"), "reader_token_ping");
  assert.equal(classifyIngestRoute("POST", "/timing/crossing"), "crossing");
  assert.equal(classifyIngestRoute("POST", "/timing/active/crossing"), "active_crossing");
  assert.equal(classifyIngestRoute("POST", "/timing/ping"), "ping");
  assert.equal(classifyIngestRoute("POST", "/timing/impinj-crossing"), "impinj_crossing");
  assert.equal(classifyIngestRoute("POST", "/timing/zebra-crossing"), "zebra_crossing");
  assert.equal(classifyIngestRoute("POST", "/timing/mylaps-crossing"), "active_legacy_crossing");
  assert.equal(classifyIngestRoute("POST", "/practice/active/crossing"), "practice_active_crossing");
  assert.equal(classifyIngestRoute("GET", "/timing/crossing"), null);
});

test("non-ingest timing routes are ignored", () => {
  assert.equal(classifyIngestRoute("POST", "/timing/manual-crossing"), null);
  assert.equal(classifyIngestRoute("GET", "/timing/live/12"), null);
  assert.equal(classifyIngestRoute("POST", "/timing/announce"), null);
});

test("credential classification prefers the strongest credential presented", () => {
  assert.equal(
    classifyIngestCredential({ route: "reader_token_crossing", hasAuthorizationHeader: false, hasSessionUser: false }),
    "reader_path_token",
  );
  assert.equal(
    classifyIngestCredential({ route: "active_crossing", hasAuthorizationHeader: true, hasSessionUser: true }),
    "bearer",
  );
  assert.equal(
    classifyIngestCredential({ route: "ping", hasAuthorizationHeader: false, hasSessionUser: true }),
    "session",
  );
  assert.equal(
    classifyIngestCredential({ route: "impinj_crossing", hasAuthorizationHeader: false, hasSessionUser: false }),
    "none",
  );
});
