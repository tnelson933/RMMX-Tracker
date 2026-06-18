import { Router } from "express";
import { getDb } from "../db";
import { sendPushNotifications } from "../lib/push";

const router = Router();

const RATE_LIMIT_MS = 4 * 60 * 60 * 1000; // 4 hours
const WINDOW_BEFORE_MS = 24 * 60 * 60 * 1000; // 24h before event

// POST /admin/notifications/broadcast
router.post("/admin/notifications/broadcast", async (req, res) => {
  const userId = (req.session as any).userId;
  if (!userId) return res.status(401).json({ error: "Not authenticated" });

  const db = getDb();

  const callingUser = db
    .prepare("SELECT role, last_push_sent_at FROM users WHERE id = ?")
    .get(userId) as { role: string; last_push_sent_at: string | null } | undefined;

  if (!callingUser) return res.status(401).json({ error: "Not authenticated" });

  const isSuperAdmin = callingUser.role === "super_admin";

  const { title, body, eventId } = req.body as {
    title?: string;
    body?: string;
    eventId?: number;
  };

  if (!title?.trim() || !body?.trim()) {
    return res.status(400).json({ error: "title and body are required" });
  }

  if (!isSuperAdmin && !eventId) {
    return res.status(400).json({ error: "eventId is required" });
  }

  let lastPushSentAtIso: string | null = null;

  if (!isSuperAdmin && eventId) {
    const event = db
      .prepare("SELECT date FROM events WHERE id = ?")
      .get(eventId) as { date: string } | undefined;

    if (!event) {
      return res.status(404).json({ error: "Event not found" });
    }

    const now = new Date();
    const [year, month, day] = event.date.split("-").map(Number);
    const windowStart = new Date(year, month - 1, day, 0, 0, 0, 0);
    windowStart.setTime(windowStart.getTime() - WINDOW_BEFORE_MS);
    const windowEnd = new Date(year, month - 1, day, 0, 0, 0, 0);
    windowEnd.setTime(windowEnd.getTime() + 48 * 60 * 60 * 1000);

    if (now < windowStart || now > windowEnd) {
      const windowStartStr = windowStart.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
      const windowEndStr = windowEnd.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
      return res.status(403).json({
        error: `Notifications can only be sent between ${windowStartStr} and ${windowEndStr}`,
        windowStart: windowStart.toISOString(),
        windowEnd: windowEnd.toISOString(),
      });
    }

    if (callingUser.last_push_sent_at) {
      const lastSent = new Date(callingUser.last_push_sent_at);
      const elapsed = now.getTime() - lastSent.getTime();
      if (elapsed < RATE_LIMIT_MS) {
        const retryAfterSeconds = Math.ceil((RATE_LIMIT_MS - elapsed) / 1000);
        return res.status(429).json({
          error: "Rate limit exceeded",
          retryAfterSeconds,
          lastSentAt: lastSent.toISOString(),
        });
      }
    }
  }

  // Resolve push tokens via rider_accounts + rider_push_tokens (synced from cloud).
  const pushTokens: string[] = [];

  if (eventId) {
    const regs = db
      .prepare("SELECT rider_id FROM registrations WHERE event_id = ?")
      .all(eventId) as Array<{ rider_id: number }>;

    const riderIds = regs.map((r) => r.rider_id).filter(Boolean);

    if (riderIds.length > 0) {
      const placeholders = riderIds.map(() => "?").join(",");
      const riders = db
        .prepare(`SELECT email FROM riders WHERE id IN (${placeholders})`)
        .all(...riderIds) as Array<{ email: string | null }>;

      const emails = riders.map((r) => r.email?.toLowerCase()).filter((e): e is string => !!e);

      if (emails.length > 0) {
        const emailPlaceholders = emails.map(() => "?").join(",");
        const accounts = db
          .prepare(`SELECT id FROM rider_accounts WHERE email IN (${emailPlaceholders})`)
          .all(...emails) as Array<{ id: number }>;

        if (accounts.length > 0) {
          const accountIds = accounts.map((a) => a.id);
          const acctPlaceholders = accountIds.map(() => "?").join(",");
          const tokens = db
            .prepare(`SELECT expo_push_token FROM rider_push_tokens WHERE rider_account_id IN (${acctPlaceholders})`)
            .all(...accountIds) as Array<{ expo_push_token: string }>;
          pushTokens.push(...tokens.map((t) => t.expo_push_token));
        }
      }
    }
  }

  if (pushTokens.length === 0) {
    return res.json({ ok: true, sent: 0, lastPushSentAt: lastPushSentAtIso });
  }

  await sendPushNotifications(
    pushTokens.map((token) => ({
      to: token,
      title: title!.trim(),
      body: body!.trim(),
    }))
  );

  const now = new Date();
  if (!isSuperAdmin) {
    db.prepare("UPDATE users SET last_push_sent_at = ? WHERE id = ?").run(
      now.toISOString(),
      userId
    );
    lastPushSentAtIso = now.toISOString();
  }

  return res.json({ ok: true, sent: pushTokens.length, lastPushSentAt: lastPushSentAtIso });
});

export default router;
