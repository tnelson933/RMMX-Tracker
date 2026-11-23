import { logger } from "./logger";

/**
 * Operations texts to the support-alert numbers (SUPPORT_ALERT_PHONES minus
 * anyone who replied STOP, via lib/smsAlerts). Texts only go out in production,
 * or when the feature's own override variable is "on"; otherwise the text is
 * logged as ops_alert_sms_skipped so local runs and tests never reach a phone.
 */

export type OpsSmsSender = (text: string) => Promise<number>;

/** Default sender: every enrolled support-alert phone. Imported lazily so pure tests don't load the database. */
export const sendToAlertPhones: OpsSmsSender = async (text) => {
  const [{ alertPhones }, { sendSms }] = await Promise.all([import("./smsAlerts"), import("./sms")]);
  let sent = 0;
  for (const phone of await alertPhones()) {
    const result = await sendSms(phone, text);
    if (result.ok) sent++;
  }
  return sent;
};

export function opsSmsEnabled(overrideVar: string, env: NodeJS.ProcessEnv = process.env): boolean {
  return env.NODE_ENV === "production" || (env[overrideVar] ?? "").trim().toLowerCase() === "on";
}

/**
 * Send (or, outside production, log) one operations text. Never throws: an
 * alerting failure must not break the caller.
 */
export async function sendOpsText(
  alert: string,
  text: string,
  overrideVar: string,
  sender: OpsSmsSender = sendToAlertPhones,
  env: NodeJS.ProcessEnv = process.env,
): Promise<{ sent: number; skipped: boolean }> {
  if (!opsSmsEnabled(overrideVar, env)) {
    logger.info({ event: "ops_alert_sms_skipped", alert, text, enableWith: `${overrideVar}=on` }, "ops alert text not sent (not production)");
    return { sent: 0, skipped: true };
  }
  try {
    const sent = await sender(text);
    logger.info({ event: "ops_alert_sms_sent", alert, recipients: sent }, "ops alert text sent");
    return { sent, skipped: false };
  } catch (err) {
    logger.error({ event: "ops_alert_sms_failed", alert, err: err instanceof Error ? err.message : String(err) }, "ops alert text failed");
    return { sent: 0, skipped: false };
  }
}
