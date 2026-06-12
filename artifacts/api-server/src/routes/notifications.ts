import { Router } from "express";
import { db } from "@workspace/db";
import {
  riderPushTokensTable,
  riderAccountsTable,
  ridersTable,
  registrationsTable,
  eventsTable,
} from "@workspace/db";
import { eq, inArray } from "drizzle-orm";
import { sendPushNotifications } from "../lib/push";

const router = Router();

// POST /admin/notifications/broadcast
// Requires organizer/admin session auth.
router.post("/admin/notifications/broadcast", async (req, res) => {
  const userId = (req.session as any).userId;
  if (!userId) return res.status(401).json({ error: "Not authenticated" });

  const { title, body, eventId } = req.body as {
    title?: string;
    body?: string;
    eventId?: number;
  };

  if (!title?.trim() || !body?.trim()) {
    return res.status(400).json({ error: "title and body are required" });
  }

  let accountIds: number[] | null = null;

  if (eventId) {
    // Only riders registered for this event
    const regs = await db
      .select({ riderId: registrationsTable.riderId })
      .from(registrationsTable)
      .where(eq(registrationsTable.eventId, eventId));

    const riderIds = regs.map((r) => r.riderId).filter(Boolean) as number[];
    if (riderIds.length === 0) {
      return res.json({ ok: true, sent: 0 });
    }

    const riders = await db
      .select({ email: ridersTable.email })
      .from(ridersTable)
      .where(inArray(ridersTable.id, riderIds));

    const emails = riders
      .map((r) => r.email?.toLowerCase())
      .filter((e): e is string => !!e);

    if (emails.length === 0) return res.json({ ok: true, sent: 0 });

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

  if (pushRows.length === 0) return res.json({ ok: true, sent: 0 });

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

  const [row] = await db
    .select({ count: riderPushTokensTable.id })
    .from(riderPushTokensTable);

  const rows = await db
    .select({ id: riderPushTokensTable.id })
    .from(riderPushTokensTable);

  return res.json({ total: rows.length });
});

export default router;
