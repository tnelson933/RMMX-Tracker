import { Router } from "express";
import { db } from "@workspace/db";
import {
  riderPushTokensTable,
  riderAccountsTable,
  ridersTable,
  registrationsTable,
  eventsTable,
  usersTable,
} from "@workspace/db";
import { eq, inArray } from "drizzle-orm";
import { sendPushNotifications } from "../lib/push";

const router = Router();

const RATE_LIMIT_MS = 1 * 60 * 60 * 1000; // 1 hour
const WINDOW_BEFORE_MS = 24 * 60 * 60 * 1000; // 24 hours before event

// POST /admin/notifications/broadcast
// Organizer-scoped: requires eventId, enforces timing window and 4-hour rate limit.
// Super admins bypass timing/rate but still require eventId (use /broadcast-all for unrestricted sends).
router.post("/admin/notifications/broadcast", async (req, res) => {
  const userId = (req.session as any).userId;
  if (!userId) return res.status(401).json({ error: "Not authenticated" });

  const [callingUser] = await db
    .select({ role: usersTable.role, lastPushSentAt: usersTable.lastPushSentAt })
    .from(usersTable)
    .where(eq(usersTable.id, userId));

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

  // Non-super-admins must provide an eventId
  if (!isSuperAdmin && !eventId) {
    return res.status(400).json({ error: "eventId is required" });
  }

  // Timing window and rate limit checks for non-super-admins
  if (!isSuperAdmin && eventId) {
    // Verify event exists and check timing window
    const [event] = await db
      .select({ date: eventsTable.date })
      .from(eventsTable)
      .where(eq(eventsTable.id, eventId));

    if (!event) {
      return res.status(404).json({ error: "Event not found" });
    }

    const now = new Date();
    // Parse event date as local date (YYYY-MM-DD)
    const [year, month, day] = event.date.split("-").map(Number);
    // Window start: 24h before event date (midnight of event date - 24h)
    const windowStart = new Date(year, month - 1, day, 0, 0, 0, 0);
    windowStart.setTime(windowStart.getTime() - WINDOW_BEFORE_MS);
    // Window end: midnight of event date + 48h (24h after end of event day)
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

    // Rate limit check
    if (callingUser.lastPushSentAt) {
      const elapsed = now.getTime() - callingUser.lastPushSentAt.getTime();
      if (elapsed < RATE_LIMIT_MS) {
        const retryAfterSeconds = Math.ceil((RATE_LIMIT_MS - elapsed) / 1000);
        return res.status(429).json({
          error: "Rate limit exceeded",
          retryAfterSeconds,
          lastSentAt: callingUser.lastPushSentAt.toISOString(),
        });
      }
    }
  }

  let accountIds: number[] | null = null;

  if (eventId) {
    const regs = await db
      .select({ riderId: registrationsTable.riderId })
      .from(registrationsTable)
      .where(eq(registrationsTable.eventId, eventId));

    const riderIds = regs.map((r) => r.riderId).filter(Boolean) as number[];
    if (riderIds.length === 0) {
      return res.json({ ok: true, sent: 0, lastPushSentAt: callingUser.lastPushSentAt?.toISOString() ?? null });
    }

    const riders = await db
      .select({ email: ridersTable.email })
      .from(ridersTable)
      .where(inArray(ridersTable.id, riderIds));

    const emails = riders
      .map((r) => r.email?.toLowerCase())
      .filter((e): e is string => !!e);

    if (emails.length === 0) {
      return res.json({ ok: true, sent: 0, lastPushSentAt: callingUser.lastPushSentAt?.toISOString() ?? null });
    }

    const accounts = await db
      .select({ id: riderAccountsTable.id })
      .from(riderAccountsTable)
      .where(inArray(riderAccountsTable.email, emails));

    accountIds = accounts.map((a) => a.id);
  }

  const pushQuery = db
    .select({ expoPushToken: riderPushTokensTable.expoPushToken })
    .from(riderPushTokensTable);

  const pushRows =
    accountIds !== null
      ? await pushQuery.where(
          inArray(riderPushTokensTable.riderAccountId, accountIds),
        )
      : await pushQuery;

  if (pushRows.length === 0) {
    return res.json({ ok: true, sent: 0, lastPushSentAt: callingUser.lastPushSentAt?.toISOString() ?? null });
  }

  await sendPushNotifications(
    pushRows.map((r) => ({
      to: r.expoPushToken,
      title: title.trim(),
      body: body.trim(),
    })),
  );

  // Update lastPushSentAt for non-super-admins (rate limit tracking)
  const now = new Date();
  if (!isSuperAdmin) {
    await db
      .update(usersTable)
      .set({ lastPushSentAt: now })
      .where(eq(usersTable.id, userId));
  }

  return res.json({ ok: true, sent: pushRows.length, lastPushSentAt: isSuperAdmin ? null : now.toISOString() });
});

// POST /admin/notifications/broadcast-all
// Super admin only — no timing or rate restrictions. Sends to all registered push tokens.
router.post("/admin/notifications/broadcast-all", async (req, res) => {
  const userId = (req.session as any).userId;
  if (!userId) return res.status(401).json({ error: "Not authenticated" });

  const [callingUser] = await db
    .select({ role: usersTable.role })
    .from(usersTable)
    .where(eq(usersTable.id, userId));

  if (!callingUser || callingUser.role !== "super_admin") {
    return res.status(403).json({ error: "Super admin access required" });
  }

  const { title, body } = req.body as { title?: string; body?: string };

  if (!title?.trim() || !body?.trim()) {
    return res.status(400).json({ error: "title and body are required" });
  }

  const pushRows = await db
    .select({ expoPushToken: riderPushTokensTable.expoPushToken })
    .from(riderPushTokensTable);

  if (pushRows.length === 0) {
    return res.json({ ok: true, sent: 0 });
  }

  await sendPushNotifications(
    pushRows.map((r) => ({
      to: r.expoPushToken,
      title: title.trim(),
      body: body.trim(),
    })),
  );

  return res.json({ ok: true, sent: pushRows.length });
});

// GET /admin/notifications/push-stats
router.get("/admin/notifications/push-stats", async (req, res) => {
  const userId = (req.session as any).userId;
  if (!userId) return res.status(401).json({ error: "Not authenticated" });

  const rows = await db
    .select({ id: riderPushTokensTable.id })
    .from(riderPushTokensTable);

  return res.json({ total: rows.length });
});

export default router;
