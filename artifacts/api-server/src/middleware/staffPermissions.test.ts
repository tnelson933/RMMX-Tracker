import assert from "node:assert/strict";
import test from "node:test";
import type { Response } from "express";
import { applyStaffRules, normalizeAccessPath } from "./staffPermissions";

/** Runs the staff rules and reports "next" or the HTTP status they answered with. */
function check(permissions: string[], path: string, method = "GET"): number | "next" {
  let status: number | "next" = "next";
  const res = {
    locals: {} as Record<string, unknown>,
    status(code: number) { status = code; return this; },
    json() { return this; },
  } as unknown as Response;
  applyStaffRules({ permissions, clubId: 1000 }, path, method, res, () => {});
  return status;
}

test("staff rules apply whatever the letter case of the path", () => {
  // gate_schedule may read events but not their registrations.
  assert.equal(check(["gate_schedule"], "/events/5"), "next");
  assert.equal(check(["gate_schedule"], "/events/5/registrations"), 403);
  assert.equal(check(["gate_schedule"], "/events/5/Registrations"), 403);
  assert.equal(check(["gate_schedule"], "/EVENTS/5/REGISTRATIONS"), 403);
  assert.equal(check(["gate_schedule"], "/Events/5/CheckIns"), 403);
  assert.equal(check(["events"], "/events/5/Registrations"), "next");
});

test("blocked areas stay blocked in any case", () => {
  assert.equal(check(["events", "payments"], "/Organizer/Team"), 403);
  assert.equal(check(["events", "payments"], "/USERS"), 403);
  assert.equal(check(["events"], "/Admin/Notifications/Broadcast-All", "POST"), 403);
});

test("normalizeAccessPath lower-cases the path", () => {
  assert.equal(normalizeAccessPath("/Auth/Offline-Token"), "/auth/offline-token");
});
