import assert from "node:assert/strict";
import test from "node:test";
import { checkFixToken, parseFindings } from "./supportInvestigation";
import { newApprovalToken } from "./supportTickets";

const base = { root_cause: "Registration 77 was left pending after a paid checkout.", summary: "Confirm registration 77", organizer_message: "Their entry is confirmed now." };

test("findings are checked before they're recorded", () => {
  const data = parseFindings({ ...base, kind: "data", sql: "UPDATE registrations SET status = 'confirmed' WHERE id = 77", expected_rows: 1 });
  assert.equal(data.ok, true);
  assert.equal((data as any).fix.expectedRows, 1);
  assert.equal(parseFindings({ ...base, kind: "data", sql: "UPDATE registrations SET status = 'confirmed'", expected_rows: 1 }).ok, false, "needs WHERE");
  assert.equal(parseFindings({ ...base, kind: "code", files: [{ path: ".github/workflows/x.yml", content: "" }] }).ok, false);
  assert.equal(parseFindings({ ...base, kind: "code", files: [{ path: "artifacts/api-server/src/routes/x.ts", content: "fixed" }] }).ok, true);
  assert.equal(parseFindings({ ...base, kind: "config" }).ok, false, "config needs steps");
  assert.equal(parseFindings({ ...base, kind: "none" }).ok, true);
  assert.equal(parseFindings({ ...base, kind: "rewrite" }).ok, false);
  assert.equal(parseFindings({ kind: "none", summary: "x" }).ok, false, "root cause and message required");
});

test("a fix token works once, only while the fix awaits approval", () => {
  const now = new Date("2026-10-29T12:00:00Z");
  const { token, hash, expiresAt } = newApprovalToken(now);
  const t = { fixStatus: "awaiting_approval", fixTokenHash: hash, fixTokenExpiresAt: expiresAt } as any;
  assert.equal(checkFixToken(t, token, now), "ok");
  assert.equal(checkFixToken(t, "nope", now), "invalid");
  assert.equal(checkFixToken(t, token, new Date(expiresAt.getTime() + 1)), "expired");
  assert.equal(checkFixToken({ ...t, fixStatus: "applied" }, token, now), "already_decided");
});
