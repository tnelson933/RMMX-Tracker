import { logger } from "./logger";

/**
 * Text messages through Twilio's REST API. Off until TWILIO_ACCOUNT_SID,
 * TWILIO_AUTH_TOKEN and TWILIO_FROM_NUMBER (or TWILIO_MESSAGING_SERVICE_SID)
 * are set; then each send logs a skip instead of failing.
 */
export async function sendSms(to: string, body: string): Promise<{ ok: boolean; reason?: string }> {
  const sid = process.env.TWILIO_ACCOUNT_SID;
  const authToken = process.env.TWILIO_AUTH_TOKEN;
  const from = process.env.TWILIO_FROM_NUMBER;
  const service = process.env.TWILIO_MESSAGING_SERVICE_SID;
  if (!sid || !authToken || (!from && !service)) {
    logger.warn("[sms] Twilio isn't configured (TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_FROM_NUMBER): text not sent");
    return { ok: false, reason: "not_configured" };
  }
  const form = new URLSearchParams({ To: to, Body: body.slice(0, 1500) });
  if (service) form.set("MessagingServiceSid", service);
  else form.set("From", from!);
  try {
    const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(sid)}/Messages.json`, {
      method: "POST",
      headers: {
        Authorization: `Basic ${Buffer.from(`${sid}:${authToken}`).toString("base64")}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: form,
    });
    if (!res.ok) {
      const reason = await res.text().catch(() => `HTTP ${res.status}`);
      logger.error({ status: res.status, reason: reason.slice(0, 300) }, "[sms] Twilio rejected the text");
      return { ok: false, reason };
    }
    return { ok: true };
  } catch (err) {
    logger.error({ err }, "[sms] Twilio request failed");
    return { ok: false, reason: err instanceof Error ? err.message : String(err) };
  }
}

/** Phone numbers from a comma-separated list, kept only if they look like E.164 (+15551234567). */
export function parsePhoneList(value: string | null | undefined): string[] {
  return (value ?? "").split(",").map(s => s.replace(/[\s().-]/g, "")).filter(s => /^\+[1-9]\d{7,14}$/.test(s));
}
