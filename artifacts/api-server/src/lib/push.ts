import { db, riderPushTokensTable } from "@workspace/db";
import { inArray } from "drizzle-orm";
import { logger } from "./logger";

export interface PushMessage {
  to: string;
  title: string;
  body: string;
  data?: Record<string, unknown>;
}

/** Outcome for one message, in the same order as the input. */
export interface PushMessageResult {
  to: string;
  /** Expo accepted the message (a ticket with status "ok"). */
  ok: boolean;
  /** Failed for a reason a later attempt might fix (transport error, non-2xx, missing ticket). */
  retryable: boolean;
  error?: string;
}

export interface PushSendResult {
  /** True when every message was accepted. */
  ok: boolean;
  accepted: number;
  failed: number;
  results: PushMessageResult[];
}

const EXPO_PUSH_URL = "https://exp.host/--/api/v2/push/send";
const BATCH_SIZE = 100;

/** Valid Expo push token shape: ExponentPushToken[...] or ExpoPushToken[...]. */
export const EXPO_PUSH_TOKEN_RE = /^Expo(?:nent)?PushToken\[[^\]\s]{1,200}\]$/;

/** Mask a push token for logs: keeps the prefix and a few characters only. */
export function maskPushToken(token: string | undefined | null): string {
  if (!token) return "";
  const m = /^(Expo(?:nent)?PushToken)\[(.*)\]$/.exec(token);
  const inner = m ? m[2] : token;
  const shown = inner.length > 8 ? `${inner.slice(0, 4)}…${inner.slice(-2)}` : "…";
  return m ? `${m[1]}[${shown}]` : shown;
}

// Sends in batches of 100. Returns per-message results so callers can tell a
// partial failure from a full one. Tokens Expo reports as DeviceNotRegistered
// are pruned (not retryable).
export async function sendPushNotifications(messages: PushMessage[]): Promise<PushSendResult> {
  const results: PushMessageResult[] = [];
  for (let i = 0; i < messages.length; i += BATCH_SIZE) {
    const batch = messages.slice(i, i + BATCH_SIZE);
    const failBatch = (error: string) => {
      for (const m of batch) results.push({ to: m.to, ok: false, retryable: true, error });
    };
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
        logger.error({ status: res.status, batchSize: batch.length }, "Expo push API returned non-2xx");
        failBatch(`http_${res.status}`);
        continue;
      }

      const json = await res.json() as { data?: Array<{ status: string; details?: { error?: string } }> };
      const tickets = Array.isArray(json.data) ? json.data : [];

      const staleTokens: string[] = [];
      for (let j = 0; j < batch.length; j++) {
        const ticket = tickets[j];
        const to = batch[j].to;
        if (!ticket) {
          results.push({ to, ok: false, retryable: true, error: "missing_ticket" });
        } else if (ticket.status === "ok") {
          results.push({ to, ok: true, retryable: false });
        } else {
          const error = ticket.details?.error ?? "unknown";
          logger.warn({ error, token: maskPushToken(to) }, "Expo push delivery error");
          if (error === "DeviceNotRegistered") staleTokens.push(to);
          // Dead device or malformed message: retrying won't help.
          const retryable = error !== "DeviceNotRegistered" && error !== "InvalidCredentials" && error !== "MessageTooBig";
          results.push({ to, ok: false, retryable, error });
        }
      }

      if (staleTokens.length > 0) {
        logger.info({ count: staleTokens.length }, "Pruning stale/unregistered push tokens");
        try {
          await db
            .delete(riderPushTokensTable)
            .where(inArray(riderPushTokensTable.expoPushToken, staleTokens));
        } catch (err) {
          logger.error({ err }, "Failed to prune stale push tokens");
        }
      }
    } catch (err) {
      logger.error({ err, batchSize: batch.length }, "Failed to send push notification batch");
      // Drop anything already recorded for this batch before marking it failed.
      results.length = Math.min(results.length, i);
      failBatch("transport_error");
    }
  }
  const accepted = results.filter(r => r.ok).length;
  return { ok: accepted === messages.length, accepted, failed: messages.length - accepted, results };
}
