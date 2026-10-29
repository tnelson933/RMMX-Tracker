import { Router } from "express";
import { getDb } from "../db";
import { sendPushNotifications } from "../lib/push";

const router = Router();

const RATE_LIMIT_MS = 1 * 60 * 60 * 1000; // 1 hour
const WINDOW_BEFORE_MS = 24 * 60 * 60 * 1000; // 24h before event

// POST /admin/notifications/broadcast
router.post("/admin/notifications/broadcast", async (req, res) => {
  const userId = (req.session as any).userId;
  if (!userId) return res.status(401).json({ error: "Not authenticated" });

  const db = getDb();

  const callingUser = db
    .prepare("SELECT role FROM users WHERE id = ?")
    .get(userId) as { role: string } | undefined;

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
  const applyRateLimit = !isSuperAdmin && !!eventId;

  if (applyRateLimit) {
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
  }

  // Resolve push tokens via rider_accounts + rider_push_tokens (synced from cloud).
  // Live (non-void) entries only; emails match case-insensitively. The local schema has
  // no rider_profile_managers or rider_notification_prefs tables, so invited managers
  // and club opt-outs can't be applied offline.
  const pushTokens: string[] = [];

  if (eventId) {
    const regs = db
      .prepare("SELECT DISTINCT rider_id FROM registrations WHERE event_id = ? AND status != 'void'")
      .all(eventId) as Array<{ rider_id: number }>;

    const riderIds = regs.map((r) => r.rider_id).filter(Boolean);

    if (riderIds.length > 0) {
      const placeholders = riderIds.map(() => "?").join(",");
      const riders = db
        .prepare(`SELECT email FROM riders WHERE id IN (${placeholders})`)
        .all(...riderIds) as Array<{ email: string | null }>;

      const emails = [...new Set(riders.map((r) => r.email?.trim().toLowerCase()).filter((e): e is string => !!e))];

      if (emails.length > 0) {
        const emailPlaceholders = emails.map(() => "?").join(",");
        const accounts = db
          .prepare(`SELECT id FROM rider_accounts WHERE lower(trim(email)) IN (${emailPlaceholders})`)
          .all(...emails) as Array<{ id: number }>;

        if (accounts.length > 0) {
          const accountIds = accounts.map((a) => a.id);
          const acctPlaceholders = accountIds.map(() => "?").join(",");
          const tokens = db
            .prepare(`SELECT DISTINCT expo_push_token FROM rider_push_tokens WHERE rider_account_id IN (${acctPlaceholders})`)
            .all(...accountIds) as Array<{ expo_push_token: string }>;
          pushTokens.push(...tokens.map((t) => t.expo_push_token));
        }
      }
    }
  }

  if (pushTokens.length === 0) {
    return res.json({ ok: true, sent: 0, lastPushSentAt: lastPushSentAtIso });
  }

  // Reserve the rate-limit slot atomically (conditional UPDATE) so two concurrent
  // requests can't both pass the check; release it if nothing was delivered.
  let previousSentAt: string | null = null;
  if (applyRateLimit) {
    const nowIso = new Date().toISOString();
    const cutoffIso = new Date(Date.now() - RATE_LIMIT_MS).toISOString();
    const reserve = db.transaction(() => {
      const row = db.prepare("SELECT last_push_sent_at FROM users WHERE id = ?").get(userId) as { last_push_sent_at: string | null } | undefined;
      const prev = row?.last_push_sent_at ?? null;
      if (prev && new Date(prev).getTime() > Date.now() - RATE_LIMIT_MS) return { ok: false as const, prev };
      const info = db
        .prepare("UPDATE users SET last_push_sent_at = ? WHERE id = ? AND (last_push_sent_at IS NULL OR last_push_sent_at <= ?)")
        .run(nowIso, userId, prev ?? cutoffIso);
      return info.changes === 1 ? { ok: true as const, prev } : { ok: false as const, prev };
    });
    const r = reserve();
    if (!r.ok) {
      const lastSent = r.prev ? new Date(r.prev) : new Date();
      const retryAfterSeconds = Math.max(1, Math.ceil((RATE_LIMIT_MS - (Date.now() - lastSent.getTime())) / 1000));
      return res.status(429).json({
        error: "Rate limit exceeded",
        retryAfterSeconds,
        lastSentAt: lastSent.toISOString(),
      });
    }
    previousSentAt = r.prev;
    lastPushSentAtIso = nowIso;
  }

  let result;
  try {
    result = await sendPushNotifications(
      pushTokens.map((token) => ({
        to: token,
        title: title!.trim(),
        body: body!.trim(),
      }))
    );
  } catch (err) {
    result = null;
    console.error("[push] Broadcast failed:", err);
  }

  if (!result || result.accepted === 0) {
    if (applyRateLimit) {
      // Only release our own reservation.
      db.prepare("UPDATE users SET last_push_sent_at = ? WHERE id = ? AND last_push_sent_at = ?")
        .run(previousSentAt, userId, lastPushSentAtIso);
    }
    return res.status(502).json({
      error: "The push service did not accept any of these notifications. Nothing was delivered; try again.",
      sent: 0,
      failed: pushTokens.length,
      lastPushSentAt: previousSentAt,
    });
  }

  return res.json({
    ok: result.failed === 0,
    partial: result.failed > 0,
    sent: result.accepted,
    failed: result.failed,
    lastPushSentAt: lastPushSentAtIso,
  });
});

export default router;
