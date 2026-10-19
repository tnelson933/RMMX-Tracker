import assert from "node:assert/strict";
import test from "node:test";
import { redactLogUrl } from "./logRedaction";

test("reader tokens in the path are redacted", () => {
  assert.equal(
    redactLogUrl("/api/timing/readers/4f1c2a9e-0b7d-4c55-9a51-2f0f3d1e8b6a/crossing"),
    "/api/timing/readers/[redacted]/crossing",
  );
  assert.equal(
    redactLogUrl("/timing/readers/abc123/active/crossing?clubId=7"),
    "/timing/readers/[redacted]/active/crossing",
  );
});

test("query strings are dropped and other paths are unchanged", () => {
  assert.equal(redactLogUrl("/api/connector/ws?token=secret"), "/api/connector/ws");
  assert.equal(redactLogUrl("/api/readers/12"), "/api/readers/12");
  assert.equal(redactLogUrl("/api/timing/active/crossing?clubId=3"), "/api/timing/active/crossing");
  assert.equal(redactLogUrl(undefined), undefined);
});
