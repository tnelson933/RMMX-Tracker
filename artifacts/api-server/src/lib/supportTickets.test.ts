import assert from "node:assert/strict";
import test from "node:test";
import { APPROVAL_TOKEN_TTL_MS, checkApprovalToken, hashApprovalToken, newApprovalToken, underTicketLimit } from "./supportTickets";
import { parsePhoneList } from "./sms";

test("an emailed approval token is stored only as its hash and expires in 7 days", () => {
  const now = new Date("2026-10-29T12:00:00Z");
  const { token, hash, expiresAt } = newApprovalToken(now);
  assert.ok(token.length >= 40);
  assert.notEqual(hash, token);
  assert.equal(hash, hashApprovalToken(token));
  assert.equal(expiresAt.getTime() - now.getTime(), APPROVAL_TOKEN_TTL_MS);
  assert.notEqual(newApprovalToken(now).token, token, "tokens are random");
});

test("only the right, unexpired token decides an open ticket, once", () => {
  const now = new Date("2026-10-29T12:00:00Z");
  const { token, hash, expiresAt } = newApprovalToken(now);
  const open = { status: "open", approvalTokenHash: hash, approvalTokenExpiresAt: expiresAt };
  assert.equal(checkApprovalToken(open, token, now), "ok");
  assert.equal(checkApprovalToken(open, token + "x", now), "invalid");
  assert.equal(checkApprovalToken(open, "", now), "invalid");
  assert.equal(checkApprovalToken(open, null, now), "invalid");
  assert.equal(checkApprovalToken(open, token, new Date(expiresAt.getTime() + 1)), "expired");
  // Deciding clears the hash; a second use is reported as already handled.
  assert.equal(checkApprovalToken({ status: "approved", approvalTokenHash: null, approvalTokenExpiresAt: null }, token, now), "already_decided");
  assert.equal(checkApprovalToken({ ...open, approvalTokenHash: null }, token, now), "invalid");
});

test("a club can send 5 tickets a day", () => {
  assert.equal(underTicketLimit(0), true);
  assert.equal(underTicketLimit(4), true);
  assert.equal(underTicketLimit(5), false);
});

test("alert phone numbers must be in +country format", () => {
  assert.deepEqual(parsePhoneList("+1 (801) 555-0100, 8015550101, +15550102"), ["+18015550100", "+15550102"]);
  assert.deepEqual(parsePhoneList(undefined), []);
});
