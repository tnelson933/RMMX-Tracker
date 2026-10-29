import { getDb } from "../db";

const EXPO_PUSH_URL = "https://exp.host/--/api/v2/push/send";
const BATCH_SIZE = 100;

export interface PushMessage {
  to: string;
  title: string;
  body: string;
  data?: Record<string, unknown>;
}

export interface PushSendResult {
  ok: boolean;
  accepted: number;
  failed: number;
  results: Array<{ to: string; ok: boolean; retryable: boolean; error?: string }>;
}

/** Mask a push token for logs: keeps the prefix and a few characters only. */
export function maskPushToken(token: string | undefined | null): string {
  if (!token) return "";
  const m = /^(Expo(?:nent)?PushToken)\[(.*)\]$/.exec(token);
  const inner = m ? m[2] : token;
  const shown = inner.length > 8 ? `${inner.slice(0, 4)}…${inner.slice(-2)}` : "…";
  return m ? `${m[1]}[${shown}]` : shown;
}

// Same result shape as the cloud push lib: per-message outcomes, and tokens Expo
// reports as DeviceNotRegistered are pruned from the local copy.
export async function sendPushNotifications(messages: PushMessage[]): Promise<PushSendResult> {
  const results: PushSendResult["results"] = [];
  for (let i = 0; i < messages.length; i += BATCH_SIZE) {
    const batch = messages.slice(i, i + BATCH_SIZE);
    const failBatch = (error: string) => {
      for (const m of batch) results.push({ to: m.to, ok: false, retryable: true, error });
    };
    try {
      const res = await fetch(EXPO_PUSH_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify(batch),
      });

      if (!res.ok) {
        console.error(`[push] Expo API returned ${res.status}`);
        failBatch(`http_${res.status}`);
        continue;
      }

      const json = await res.json() as { data?: Array<{ status: string; details?: { error?: string } }> };
      const tickets = Array.isArray(json.data) ? json.data : [];
      const stale: string[] = [];
      for (let j = 0; j < batch.length; j++) {
        const ticket = tickets[j];
        const to = batch[j].to;
        if (!ticket) {
          results.push({ to, ok: false, retryable: true, error: "missing_ticket" });
        } else if (ticket.status === "ok") {
          results.push({ to, ok: true, retryable: false });
        } else {
          const error = ticket.details?.error ?? "unknown";
          console.error(`[push] Delivery error for token ${maskPushToken(to)}: ${error}`);
          if (error === "DeviceNotRegistered") stale.push(to);
          results.push({ to, ok: false, retryable: error !== "DeviceNotRegistered", error });
        }
      }

      if (stale.length > 0) {
        try {
          const db = getDb();
          const del = db.prepare("DELETE FROM rider_push_tokens WHERE expo_push_token = ?");
          db.transaction((tokens: string[]) => { for (const t of tokens) del.run(t); })(stale);
          console.log(`[push] Pruned ${stale.length} unregistered push token(s)`);
        } catch (err) {
          console.error("[push] Failed to prune stale tokens:", err);
        }
      }
    } catch (err) {
      console.error("[push] Failed to send batch:", err);
      results.length = Math.min(results.length, i);
      failBatch("transport_error");
    }
  }
  const accepted = results.filter((r) => r.ok).length;
  return { ok: accepted === messages.length, accepted, failed: messages.length - accepted, results };
}
