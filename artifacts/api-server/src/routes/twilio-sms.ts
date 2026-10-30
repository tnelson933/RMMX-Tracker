import { Router } from "express";
import { db, supportTicketsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { decideTicket } from "../lib/supportTickets";
import { decideFix, startInvestigation } from "../lib/supportInvestigation";
import { isAlertPhone, setOptedOut } from "../lib/smsAlerts";
import { parseReply, replyCodeMatches, twilioSignatureValid, twiml } from "../lib/smsReplies";
import { logger } from "../lib/logger";

/**
 * Replies to support-alert texts (Twilio's "A message comes in" webhook):
 * "YES 123 K7Q2C" approves, "NO 123 K7Q2C" declines, the ticket or, once the
 * investigation proposed one, its fix. Only Twilio (signature checked) and
 * only numbers on the alert list are heard. STOP/START/HELP are answered by
 * Twilio with the registered replies; here they only update the opt-out record.
 */
const router = Router();

function getAppUrl(): string {
  if (process.env.APP_URL) return process.env.APP_URL.replace(/\/$/, "");
  const domains = process.env.REPLIT_DOMAINS;
  if (domains) return `https://${domains.split(",")[0]}`;
  return "http://localhost:80";
}

/** The URL Twilio signed: what's set on the Twilio number, by default APP_URL + this path. */
function webhookUrl(): string {
  return process.env.TWILIO_SMS_WEBHOOK_URL || `${getAppUrl()}/api/twilio/sms`;
}

const mask = (phone: string) => phone.replace(/\d(?=\d{4})/g, "•");

router.post("/twilio/sms", async (req, res) => {
  res.type("text/xml");
  const params = Object.fromEntries(Object.entries(req.body ?? {}).map(([k, v]) => [k, String(v)]));
  if (!twilioSignatureValid(webhookUrl(), params, req.get("X-Twilio-Signature"), process.env.TWILIO_AUTH_TOKEN ?? "")) {
    logger.warn("[sms] reply rejected: bad or missing Twilio signature (check TWILIO_AUTH_TOKEN and TWILIO_SMS_WEBHOOK_URL)");
    return res.status(403).send(twiml());
  }
  const from = params.From ?? "";
  const reply = parseReply(params.Body);

  if (reply.kind === "keyword") {
    if (reply.keyword !== "help") await setOptedOut(from, reply.keyword === "stop");
    return res.send(twiml());
  }
  if (!(await isAlertPhone(from))) {
    logger.warn({ from: mask(from) }, "[sms] reply from a number not on the alert list: ignored");
    return res.send(twiml());
  }
  if (reply.kind === "unknown") {
    return res.send(twiml("To decide a ticket, reply YES or NO with its number and code, e.g. YES 123 K7Q2C. Open the link in the alert for details."));
  }

  const [t] = await db.select().from(supportTicketsTable).where(eq(supportTicketsTable.id, reply.ticketId));
  const now = Date.now();

  // The fix the investigation proposed.
  if (t?.fixStatus === "awaiting_approval" && replyCodeMatches(reply.code, t.fixSmsCodeHash)) {
    if (!t.fixTokenExpiresAt || t.fixTokenExpiresAt.getTime() < now) return res.send(twiml(`Support #${t.id}: that code has expired. Open the ticket in RM Roost to decide.`));
    logger.info({ ticketId: t.id, decision: reply.decision, from: mask(from) }, "[sms] fix decided by text");
    const outcome = await decideFix(t.id, reply.decision, null);
    return res.send(twiml(`Support #${t.id}: ${outcome.message}`.slice(0, 600)));
  }
  // The ticket itself (approve = start the investigation).
  if (t?.status === "open" && replyCodeMatches(reply.code, t.approvalSmsCodeHash)) {
    if (!t.approvalTokenExpiresAt || t.approvalTokenExpiresAt.getTime() < now) return res.send(twiml(`Support #${t.id}: that code has expired. Open the ticket in RM Roost to decide.`));
    logger.info({ ticketId: t.id, decision: reply.decision, from: mask(from) }, "[sms] ticket decided by text");
    const decided = await decideTicket(t.id, reply.decision, null);
    if (!decided) return res.send(twiml(`Support #${t.id} was already handled.`));
    if (decided.status === "approved") {
      void startInvestigation(decided.id, getAppUrl()).catch(err => logger.error({ err, ticketId: decided.id }, "[sms] investigation failed to start"));
      return res.send(twiml(`Support #${t.id} approved. Claude is investigating; you'll get a text when a fix is ready.`));
    }
    return res.send(twiml(`Support #${t.id} declined. Nothing was changed.`));
  }
  // Wrong code, or the step it was for is already done.
  if (t && (t.status !== "open" && t.fixStatus !== "awaiting_approval")) return res.send(twiml(`Support #${t.id} was already handled.`));
  return res.send(twiml("That ticket number and code don't match an open request. Check the latest alert and try again."));
});

export default router;
