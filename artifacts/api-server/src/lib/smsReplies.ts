import { createHash, createHmac, randomInt, timingSafeEqual } from "node:crypto";

/**
 * Approving support tickets by text. Each alert carries a one-time code; the
 * owner replies "YES 123 K7Q2C" or "NO 123 K7Q2C". The code is stored only as a
 * SHA-256 hash, and replies are accepted only from Twilio (signature checked)
 * and from a number on the alert list.
 */

// No 0/O, 1/I/L: easy to read and type on a phone.
const CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
export const REPLY_CODE_LENGTH = 5;

export function hashReplyCode(code: string): string {
  return createHash("sha256").update(code.trim().toUpperCase()).digest("hex");
}

/** A new reply code and its hash for storage. */
export function newReplyCode(): { code: string; hash: string } {
  let code = "";
  for (let i = 0; i < REPLY_CODE_LENGTH; i++) code += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
  return { code, hash: hashReplyCode(code) };
}

/** Does this code match the stored hash? */
export function replyCodeMatches(code: string, storedHash: string | null | undefined): boolean {
  if (!storedHash || !code) return false;
  const given = Buffer.from(hashReplyCode(code), "hex");
  const stored = Buffer.from(storedHash, "hex");
  return given.length === stored.length && timingSafeEqual(given, stored);
}

export type ParsedReply =
  | { kind: "decision"; decision: "approve" | "decline"; ticketId: number; code: string }
  | { kind: "keyword"; keyword: "stop" | "start" | "help" }
  | { kind: "unknown" };

const APPROVE = new Set(["YES", "Y", "APPROVE", "OK"]);
const DECLINE = new Set(["NO", "N", "DECLINE"]);
const STOP = new Set(["STOP", "STOPALL", "UNSUBSCRIBE", "END", "QUIT", "CANCEL", "OPTOUT", "REVOKE"]);
const START = new Set(["START", "UNSTOP", "OPTIN", "YES-START"]);
const HELP = new Set(["HELP", "INFO", "SUPPORT"]);

/** Read a reply: "YES 123 K7Q2C", "no #123 k7q2c", "STOP", "HELP"… */
export function parseReply(body: string | null | undefined): ParsedReply {
  const words = (body ?? "").toUpperCase().replace(/[#.,!:;]/g, " ").trim().split(/\s+/).filter(Boolean);
  if (words.length === 1) {
    if (STOP.has(words[0])) return { kind: "keyword", keyword: "stop" };
    if (START.has(words[0])) return { kind: "keyword", keyword: "start" };
    if (HELP.has(words[0])) return { kind: "keyword", keyword: "help" };
  }
  if (words.length === 3) {
    const [word, id, code] = words;
    const decision = APPROVE.has(word) ? "approve" : DECLINE.has(word) ? "decline" : null;
    if (decision && /^\d{1,9}$/.test(id) && new RegExp(`^[A-Z0-9]{${REPLY_CODE_LENGTH}}$`).test(code)) {
      return { kind: "decision", decision, ticketId: Number(id), code };
    }
  }
  return { kind: "unknown" };
}

/**
 * Twilio's X-Twilio-Signature: base64 HMAC-SHA1, keyed with the auth token, of
 * the webhook URL followed by each POST parameter's name and value, sorted by name.
 */
export function twilioSignature(url: string, params: Record<string, string>, authToken: string): string {
  const data = url + Object.keys(params).sort().map(k => k + params[k]).join("");
  return createHmac("sha1", authToken).update(data, "utf8").digest("base64");
}

export function twilioSignatureValid(url: string, params: Record<string, string>, signature: string | undefined, authToken: string): boolean {
  if (!signature || !authToken) return false;
  const expected = Buffer.from(twilioSignature(url, params, authToken));
  const given = Buffer.from(signature);
  return expected.length === given.length && timingSafeEqual(expected, given);
}

/** A TwiML reply (empty when there's nothing to say). */
export function twiml(message?: string | null): string {
  if (!message) return `<?xml version="1.0" encoding="UTF-8"?><Response></Response>`;
  const esc = message.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return `<?xml version="1.0" encoding="UTF-8"?><Response><Message>${esc}</Message></Response>`;
}

/** Program wording registered with carriers (A2P 10DLC). Keep these in step with the registration. */
export const SMS_PROGRAM = "RM Roost support alerts (Rocky Mountain ATV Inc.)";
export const SMS_WELCOME = `${SMS_PROGRAM}: you're enrolled. Up to 8 msgs/month. Msg & data rates may apply. Reply HELP for help, STOP to opt out.`;
export const SMS_HELP = `${SMS_PROGRAM}: for help email sales@rockymountainatv.com or call 1-800-336-5437. Up to 8 msgs/month. Msg & data rates may apply. Reply STOP to opt out.`;
export const SMS_STOPPED = `${SMS_PROGRAM}: you're unsubscribed and won't receive more messages. Reply START to rejoin.`;
