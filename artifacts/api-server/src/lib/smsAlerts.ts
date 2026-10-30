import { db, smsAlertEnrollmentsTable } from "@workspace/db";
import { eq, sql } from "drizzle-orm";
import { logger } from "./logger";
import { parsePhoneList, sendSms } from "./sms";
import { SMS_WELCOME } from "./smsReplies";

/**
 * Who gets support-alert texts: the numbers in SUPPORT_ALERT_PHONES (added
 * after the person agreed in person), minus anyone who replied STOP. A number
 * gets the enrollment confirmation text before its first alert; the server also
 * sends it on startup, which Railway does right after the variable changes.
 */

/** The listed numbers that haven't opted out. */
export async function alertPhones(): Promise<string[]> {
  const listed = parsePhoneList(process.env.SUPPORT_ALERT_PHONES);
  if (listed.length === 0) return [];
  const rows = await db.select().from(smsAlertEnrollmentsTable);
  const stopped = new Set(rows.filter(r => r.optedOutAt).map(r => r.phone));
  return listed.filter(p => !stopped.has(p));
}

/** Text the enrollment confirmation to listed numbers that haven't had it. */
export async function sendEnrollmentConfirmations(): Promise<number> {
  const listed = parsePhoneList(process.env.SUPPORT_ALERT_PHONES);
  if (listed.length === 0) return 0;
  const rows = await db.select().from(smsAlertEnrollmentsTable);
  const done = new Set(rows.filter(r => r.confirmedAt || r.optedOutAt).map(r => r.phone));
  let sent = 0;
  for (const phone of listed.filter(p => !done.has(p))) {
    const result = await sendSms(phone, SMS_WELCOME);
    if (!result.ok) continue; // e.g. Twilio not set up yet: try again next time
    await db.insert(smsAlertEnrollmentsTable).values({ phone, confirmedAt: new Date() })
      .onConflictDoUpdate({ target: smsAlertEnrollmentsTable.phone, set: { confirmedAt: new Date(), updatedAt: new Date() } });
    sent++;
  }
  if (sent > 0) logger.info({ sent }, "[sms] enrollment confirmations sent");
  return sent;
}

/** Record STOP (true) or START (false) from a number. */
export async function setOptedOut(phone: string, optedOut: boolean): Promise<void> {
  await db.insert(smsAlertEnrollmentsTable)
    .values({ phone, optedOutAt: optedOut ? new Date() : null, confirmedAt: optedOut ? null : new Date() })
    .onConflictDoUpdate({
      target: smsAlertEnrollmentsTable.phone,
      set: optedOut
        ? { optedOutAt: new Date(), updatedAt: new Date() }
        : { optedOutAt: null, confirmedAt: sql`coalesce(${smsAlertEnrollmentsTable.confirmedAt}, now())`, updatedAt: new Date() },
    });
}

/** Is this number on the alert list and not opted out? */
export async function isAlertPhone(phone: string): Promise<boolean> {
  if (!parsePhoneList(process.env.SUPPORT_ALERT_PHONES).includes(phone)) return false;
  const [row] = await db.select({ optedOutAt: smsAlertEnrollmentsTable.optedOutAt }).from(smsAlertEnrollmentsTable)
    .where(eq(smsAlertEnrollmentsTable.phone, phone));
  return !row?.optedOutAt;
}
