const EXPO_PUSH_URL = "https://exp.host/--/api/v2/push/send";
const BATCH_SIZE = 100;

export interface PushMessage {
  to: string;
  title: string;
  body: string;
  data?: Record<string, unknown>;
}

export async function sendPushNotifications(messages: PushMessage[]): Promise<void> {
  if (messages.length === 0) return;
  for (let i = 0; i < messages.length; i += BATCH_SIZE) {
    const batch = messages.slice(i, i + BATCH_SIZE);
    try {
      const res = await fetch(EXPO_PUSH_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify(batch),
      });

      if (!res.ok) {
        console.error(`[push] Expo API returned ${res.status}`);
        continue;
      }

      const json = await res.json() as { data?: Array<{ status: string; details?: { error?: string } }> };
      const tickets = json.data ?? [];
      for (let j = 0; j < tickets.length; j++) {
        const ticket = tickets[j];
        if (ticket.status === "error") {
          console.error(`[push] Delivery error for token ${batch[j]?.to}: ${ticket.details?.error}`);
        }
      }
    } catch (err) {
      console.error("[push] Failed to send batch:", err);
    }
  }
}
