import { db, riderPushTokensTable } from "@workspace/db";
import { inArray } from "drizzle-orm";
import { logger } from "./logger";

export interface PushMessage {
  to: string;
  title: string;
  body: string;
  data?: Record<string, unknown>;
}

const EXPO_PUSH_URL = "https://exp.host/--/api/v2/push/send";
const BATCH_SIZE = 100;

// Returns true if every batch was accepted by the Expo push API, false if any
// batch failed at the transport level (callers may retry later).
export async function sendPushNotifications(messages: PushMessage[]): Promise<boolean> {
  if (messages.length === 0) return true;
  let allOk = true;
  for (let i = 0; i < messages.length; i += BATCH_SIZE) {
    const batch = messages.slice(i, i + BATCH_SIZE);
    try {
      const res = await fetch(EXPO_PUSH_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify(batch),
      });

      if (!res.ok) {
        logger.error({ status: res.status }, "Expo push API returned non-2xx");
        allOk = false;
        continue;
      }

      const json = await res.json() as { data?: Array<{ status: string; details?: { error?: string } }> };
      const tickets = json.data ?? [];

      const staleTokens: string[] = [];
      for (let j = 0; j < tickets.length; j++) {
        const ticket = tickets[j];
        if (ticket.status === "error") {
          logger.warn({ error: ticket.details?.error, token: batch[j]?.to }, "Expo push delivery error");
          if (ticket.details?.error === "DeviceNotRegistered") {
            staleTokens.push(batch[j].to);
          }
        }
      }

      if (staleTokens.length > 0) {
        logger.info({ count: staleTokens.length }, "Pruning stale/unregistered push tokens");
        await db
          .delete(riderPushTokensTable)
          .where(inArray(riderPushTokensTable.expoPushToken, staleTokens));
      }
    } catch (err) {
      logger.error({ err }, "Failed to send push notification batch");
      allOk = false;
    }
  }
  return allOk;
}
