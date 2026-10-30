import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import test from "node:test";
import {
  hashReplyCode, newReplyCode, parseReply, replyCodeMatches, twilioSignature, twilioSignatureValid, twiml,
  SMS_HELP, SMS_STOPPED, SMS_WELCOME, REPLY_CODE_LENGTH,
} from "./smsReplies";

test("reply codes: five readable characters, checked against the stored hash", () => {
  const { code, hash } = newReplyCode();
  assert.equal(code.length, REPLY_CODE_LENGTH);
  assert.match(code, /^[A-HJKMNP-Z2-9]+$/);
  assert.ok(replyCodeMatches(code, hash));
  assert.ok(replyCodeMatches(code.toLowerCase(), hash));
  assert.ok(!replyCodeMatches("ZZZZZ", hash));
  assert.ok(!replyCodeMatches(code, null));
  assert.equal(hashReplyCode(" k7q2c "), hashReplyCode("K7Q2C"));
});

test("replies: YES/NO with ticket and code, or a keyword", () => {
  assert.deepEqual(parseReply("YES 123 K7Q2C"), { kind: "decision", decision: "approve", ticketId: 123, code: "K7Q2C" });
  assert.deepEqual(parseReply("  no #123 k7q2c. "), { kind: "decision", decision: "decline", ticketId: 123, code: "K7Q2C" });
  assert.deepEqual(parseReply("Approve 9 ABCDE"), { kind: "decision", decision: "approve", ticketId: 9, code: "ABCDE" });
  assert.deepEqual(parseReply("stop"), { kind: "keyword", keyword: "stop" });
  assert.deepEqual(parseReply("HELP"), { kind: "keyword", keyword: "help" });
  assert.deepEqual(parseReply("Start"), { kind: "keyword", keyword: "start" });
  // A bare "yes", a missing code, or chatter never decides anything.
  for (const body of ["yes", "YES 123", "YES 123 K7Q2", "yes please fix 123", "", null]) {
    assert.deepEqual(parseReply(body), { kind: "unknown" }, String(body));
  }
});

test("Twilio signatures: URL then parameters sorted by name, HMAC-SHA1 with the auth token", () => {
  const url = "https://www.rmroost.com/api/twilio/sms";
  const params = { To: "+18005551212", Body: "YES 1 ABCDE", From: "+15551234567" };
  // Twilio's documented algorithm, spelled out: names sorted (Body, From, To), each name then value, after the URL.
  const signed = "https://www.rmroost.com/api/twilio/smsBodyYES 1 ABCDEFrom+15551234567To+18005551212";
  const expected = createHmac("sha1", "secret").update(signed).digest("base64");
  assert.equal(twilioSignature(url, params, "secret"), expected);
  assert.ok(twilioSignatureValid(url, params, expected, "secret"));
  assert.ok(!twilioSignatureValid(url, { ...params, Body: "YES 1 ZZZZZ" }, expected, "secret"));
  assert.ok(!twilioSignatureValid(url, params, expected, "other-token"));
  assert.ok(!twilioSignatureValid(url, params, undefined, "secret"));
});

test("TwiML escapes the reply; registered wording carries the required disclosures", () => {
  assert.equal(twiml(), `<?xml version="1.0" encoding="UTF-8"?><Response></Response>`);
  assert.match(twiml("Fix <applied> & done"), /<Message>Fix &lt;applied&gt; &amp; done<\/Message>/);
  for (const text of [SMS_WELCOME, SMS_HELP]) {
    assert.match(text, /Rocky Mountain ATV Inc\./);
    assert.match(text, /Msg & data rates may apply/);
    assert.match(text, /STOP/);
  }
  assert.match(SMS_WELCOME, /Up to 8 msgs\/month/);
  assert.match(SMS_HELP, /sales@rockymountainatv\.com/);
  assert.match(SMS_STOPPED, /won't receive more messages/);
});
