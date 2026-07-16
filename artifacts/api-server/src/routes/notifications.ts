import { Router } from "express";
import { db } from "@workspace/db";
import {
  riderPushTokensTable,
  riderAccountsTable,
  ridersTable,
  registrationsTable,
  eventsTable,
  usersTable,
  riderNotificationPrefsTable,
  notificationLogsTable,
} from "@workspace/db";
import { eq, inArray, and, countDistinct, desc } from "drizzle-orm";
import { sendPushNotifications } from "../lib/push";

const router = Router();

// POST /admin/notifications/broadcast
// Organizer-scoped: no timing window, no rate limit.
// When eventId is absent or null, sends to all riders registered across any event in the organizer's club.
// When eventId is provided, sends only to riders registered for that event.
// Super admins bypass club scoping (use /broadcast-all for unrestricted sends).
router.post("/admin/notifications/broadcast", async (req, res) => {
  const userId = (req.session as any).userId;
  if (!userId) return res.status(401).json({ error: "Not authenticated" });

  const [callingUser] = await db
    .select({ role: usersTable.role, clubId: usersTable.clubId })
    .from(usersTable)
    .where(eq(usersTable.id, userId));

  if (!callingUser) return res.status(401).json({ error: "Not authenticated" });

  const isSuperAdmin = callingUser.role === "super_admin";

  const { title, body, eventId } = req.body as {
    title?: string;
    body?: string;
    eventId?: number | null;
  };

  if (!title?.trim() || !body?.trim()) {
    return res.status(400).json({ error: "title and body are required" });
  }

  // Non-super-admins must belong to a club
  if (!isSuperAdmin && !callingUser.clubId) {
    return res.status(403).json({ error: "No club associated with your account" });
  }

  let accountIds: number[] | null = null;
  let audienceType = "all";
  let resolvedEventId: number | null = null;

  if (eventId) {
    // Single-event path: verify event belongs to the organizer's club (skip for super admins)
    const [event] = await db
      .select({ id: eventsTable.id, clubId: eventsTable.clubId })
      .from(eventsTable)
      .where(eq(eventsTable.id, eventId));

    if (!event) {
      return res.status(404).json({ error: "Event not found" });
    }

    if (!isSuperAdmin && event.clubId !== callingUser.clubId) {
      return res.status(403).json({ error: "Event does not belong to your club" });
    }

    const regs = await db
      .select({ riderId: registrationsTable.riderId })
      .from(registrationsTable)
      .where(eq(registrationsTable.eventId, eventId));

    const riderIds = regs.map((r) => r.riderId).filter(Boolean) as number[];
    if (riderIds.length === 0) {
      await db.insert(notificationLogsTable).values({
        clubId: callingUser.clubId ?? null,
        userId,
        title: title.trim(),
        body: body.trim(),
        audienceType: "event",
        eventId,
        sentCount: 0,
      });
      return res.json({ ok: true, sent: 0 });
    }

    const riders = await db
      .select({ email: ridersTable.email })
      .from(ridersTable)
      .where(inArray(ridersTable.id, riderIds));

    const emails = riders
      .map((r) => r.email?.toLowerCase())
      .filter((e): e is string => !!e);

    if (emails.length === 0) {
      await db.insert(notificationLogsTable).values({
        clubId: callingUser.clubId ?? null,
        userId,
        title: title.trim(),
        body: body.trim(),
        audienceType: "event",
        eventId,
        sentCount: 0,
      });
      return res.json({ ok: true, sent: 0 });
    }

    const accounts = await db
      .select({ id: riderAccountsTable.id })
      .from(riderAccountsTable)
      .where(inArray(riderAccountsTable.email, emails));

    accountIds = accounts.map((a) => a.id);
    audienceType = "event";
    resolvedEventId = eventId;
  } else {
    // All-riders path: gather registrations across all events in the organizer's club
    const clubId = isSuperAdmin ? null : callingUser.clubId;

    let eventIds: number[];

    if (clubId !== null) {
      const clubEvents = await db
        .select({ id: eventsTable.id })
        .from(eventsTable)
        .where(eq(eventsTable.clubId, clubId));

      eventIds = clubEvents.map((e) => e.id);
    } else {
      // Super admin with no eventId — treat as broadcast-all (no account filter)
      eventIds = [];
    }

    if (clubId !== null && eventIds.length === 0) {
      await db.insert(notificationLogsTable).values({
        clubId: callingUser.clubId ?? null,
        userId,
        title: title.trim(),
        body: body.trim(),
        audienceType: isSuperAdmin ? "all_global" : "all",
        eventId: null,
        sentCount: 0,
      });
      return res.json({ ok: true, sent: 0 });
    }

    if (eventIds.length > 0) {
      const regs = await db
        .select({ riderId: registrationsTable.riderId })
        .from(registrationsTable)
        .where(inArray(registrationsTable.eventId, eventIds));

      const riderIds = [...new Set(regs.map((r) => r.riderId).filter(Boolean) as number[])];
      if (riderIds.length === 0) {
        await db.insert(notificationLogsTable).values({
          clubId: callingUser.clubId ?? null,
          userId,
          title: title.trim(),
          body: body.trim(),
          audienceType: "all",
          eventId: null,
          sentCount: 0,
        });
        return res.json({ ok: true, sent: 0 });
      }

      const riders = await db
        .select({ email: ridersTable.email })
        .from(ridersTable)
        .where(inArray(ridersTable.id, riderIds));

      const emails = [...new Set(
        riders.map((r) => r.email?.toLowerCase()).filter((e): e is string => !!e)
      )];

      if (emails.length === 0) {
        await db.insert(notificationLogsTable).values({
          clubId: callingUser.clubId ?? null,
          userId,
          title: title.trim(),
          body: body.trim(),
          audienceType: "all",
          eventId: null,
          sentCount: 0,
        });
        return res.json({ ok: true, sent: 0 });
      }

      const accounts = await db
        .select({ id: riderAccountsTable.id })
        .from(riderAccountsTable)
        .where(inArray(riderAccountsTable.email, emails));

      accountIds = accounts.map((a) => a.id);
    }
    audienceType = isSuperAdmin ? "all_global" : "all";
    // accountIds remains null → push to all tokens (super admin no-eventId case)
  }

  // Determine the broadcasting club ID for opt-out filtering
  const broadcastingClubId: number | null = isSuperAdmin && !eventId
    ? null
    : (eventId
      ? (await db.select({ clubId: eventsTable.clubId }).from(eventsTable).where(eq(eventsTable.id, eventId)).then(r => r[0]?.clubId ?? null))
      : callingUser.clubId ?? null);

  // Collect opted-out account IDs for this club
  let optedOutAccountIds: number[] = [];
  if (broadcastingClubId !== null) {
    const optOuts = await db
      .select({ riderAccountId: riderNotificationPrefsTable.riderAccountId })
      .from(riderNotificationPrefsTable)
      .where(
        and(
          eq(riderNotificationPrefsTable.clubId, broadcastingClubId),
          eq(riderNotificationPrefsTable.enabled, false),
        ),
      );
    optedOutAccountIds = optOuts.map((o) => o.riderAccountId);
  }

  // Build effective account filter: intersection of target accounts minus opt-outs
  let effectiveAccountIds: number[] | null = accountIds;
  if (optedOutAccountIds.length > 0) {
    if (effectiveAccountIds !== null) {
      effectiveAccountIds = effectiveAccountIds.filter(
        (id) => !optedOutAccountIds.includes(id),
      );
    } else {
      effectiveAccountIds = null; // will filter below
    }
  }

  let pushRows: { expoPushToken: string }[];
  if (effectiveAccountIds !== null) {
    if (effectiveAccountIds.length === 0) {
      return res.json({ ok: true, sent: 0 });
    }
    pushRows = await db
      .select({ expoPushToken: riderPushTokensTable.expoPushToken })
      .from(riderPushTokensTable)
      .where(inArray(riderPushTokensTable.riderAccountId, effectiveAccountIds));
  } else if (optedOutAccountIds.length > 0) {
    // Super admin broadcast-all: exclude only opted-out accounts
    const all = await db
      .select({ riderAccountId: riderPushTokensTable.riderAccountId, expoPushToken: riderPushTokensTable.expoPushToken })
      .from(riderPushTokensTable);
    pushRows = all
      .filter((r) => !optedOutAccountIds.includes(r.riderAccountId))
      .map((r) => ({ expoPushToken: r.expoPushToken }));
  } else {
    pushRows = await db
      .select({ expoPushToken: riderPushTokensTable.expoPushToken })
      .from(riderPushTokensTable);
  }

  if (pushRows.length === 0) {
    await db.insert(notificationLogsTable).values({
      clubId: callingUser.clubId ?? null,
      userId,
      title: title.trim(),
      body: body.trim(),
      audienceType,
      eventId: resolvedEventId,
      sentCount: 0,
    });
    return res.json({ ok: true, sent: 0 });
  }

  await sendPushNotifications(
    pushRows.map((r) => ({
      to: r.expoPushToken,
      title: title.trim(),
      body: body.trim(),
    })),
  );

  await db.insert(notificationLogsTable).values({
    clubId: callingUser.clubId ?? null,
    userId,
    title: title.trim(),
    body: body.trim(),
    audienceType,
    eventId: resolvedEventId,
    sentCount: pushRows.length,
  });

  return res.json({ ok: true, sent: pushRows.length });
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

  const { title, body, linkUrl } = req.body as {
    title?: string;
    body?: string;
    linkUrl?: string;
  };

  if (!title?.trim() || !body?.trim()) {
    return res.status(400).json({ error: "title and body are required" });
  }

  let cleanLinkUrl: string | null = null;
  if (linkUrl?.trim()) {
    try {
      const parsed = new URL(linkUrl.trim());
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
        return res.status(400).json({ error: "linkUrl must be an http(s) URL" });
      }
      cleanLinkUrl = parsed.toString();
    } catch {
      return res.status(400).json({ error: "linkUrl is not a valid URL" });
    }
  }

  const pushRows = await db
    .select({ expoPushToken: riderPushTokensTable.expoPushToken })
    .from(riderPushTokensTable);

  if (pushRows.length === 0) {
    await db.insert(notificationLogsTable).values({
      clubId: null,
      userId,
      title: title.trim(),
      body: body.trim(),
      audienceType: "all_global",
      eventId: null,
      sentCount: 0,
    });
    return res.json({ ok: true, sent: 0 });
  }

  await sendPushNotifications(
    pushRows.map((r) => ({
      to: r.expoPushToken,
      title: title.trim(),
      body: body.trim(),
      ...(cleanLinkUrl ? { data: { url: cleanLinkUrl } } : {}),
    })),
  );

  await db.insert(notificationLogsTable).values({
    clubId: null,
    userId,
    title: title.trim(),
    body: body.trim(),
    audienceType: "all_global",
    eventId: null,
    sentCount: pushRows.length,
  });

  return res.json({ ok: true, sent: pushRows.length });
});

// GET /admin/notifications/audience-count
// Returns the number of distinct riders who will receive a push notification for the given scope.
// "Riders" = distinct riderAccountId values that have at least one push token.
// A rider with multiple devices is counted once.
router.get("/admin/notifications/audience-count", async (req, res) => {
  const userId = (req.session as any).userId;
  if (!userId) return res.status(401).json({ error: "Not authenticated" });

  const [callingUser] = await db
    .select({ role: usersTable.role, clubId: usersTable.clubId })
    .from(usersTable)
    .where(eq(usersTable.id, userId));

  if (!callingUser) return res.status(401).json({ error: "Not authenticated" });

  const isSuperAdmin = callingUser.role === "super_admin";

  // --- Input validation ---
  const audience = req.query.audience as string | undefined;
  if (audience !== "all" && audience !== "event") {
    return res.status(400).json({ error: "audience must be 'all' or 'event'" });
  }

  let eventId: number | null = null;
  if (audience === "event") {
    const eventIdRaw = req.query.eventId as string | undefined;
    if (!eventIdRaw || !/^\d+$/.test(eventIdRaw.trim())) {
      return res.status(400).json({ error: "eventId must be a positive integer when audience is 'event'" });
    }
    eventId = parseInt(eventIdRaw, 10);
  }

  if (!isSuperAdmin && !callingUser.clubId) {
    return res.status(403).json({ error: "No club associated with your account" });
  }

  // Build the set of riderAccount IDs in scope, then count distinct accounts with a token.
  let accountIds: number[] | null = null;

  if (audience === "event" && eventId !== null) {
    const [event] = await db
      .select({ id: eventsTable.id, clubId: eventsTable.clubId })
      .from(eventsTable)
      .where(eq(eventsTable.id, eventId));

    if (!event) return res.status(404).json({ error: "Event not found" });

    if (!isSuperAdmin && event.clubId !== callingUser.clubId) {
      return res.status(403).json({ error: "Event does not belong to your club" });
    }

    const regs = await db
      .select({ riderId: registrationsTable.riderId })
      .from(registrationsTable)
      .where(eq(registrationsTable.eventId, eventId));

    const riderIds = regs.map((r) => r.riderId).filter(Boolean) as number[];
    if (riderIds.length === 0) return res.json({ count: 0 });

    const riders = await db
      .select({ email: ridersTable.email })
      .from(ridersTable)
      .where(inArray(ridersTable.id, riderIds));

    const emails = riders
      .map((r) => r.email?.toLowerCase())
      .filter((e): e is string => !!e);

    if (emails.length === 0) return res.json({ count: 0 });

    const accounts = await db
      .select({ id: riderAccountsTable.id })
      .from(riderAccountsTable)
      .where(inArray(riderAccountsTable.email, emails));

    accountIds = accounts.map((a) => a.id);
  } else {
    // audience === "all": all riders across the organizer's club events
    const clubId = isSuperAdmin ? null : callingUser.clubId;
    let eventIds: number[];

    if (clubId !== null) {
      const clubEvents = await db
        .select({ id: eventsTable.id })
        .from(eventsTable)
        .where(eq(eventsTable.clubId, clubId));
      eventIds = clubEvents.map((e) => e.id);
    } else {
      eventIds = [];
    }

    if (clubId !== null && eventIds.length === 0) return res.json({ count: 0 });

    if (eventIds.length > 0) {
      const regs = await db
        .select({ riderId: registrationsTable.riderId })
        .from(registrationsTable)
        .where(inArray(registrationsTable.eventId, eventIds));

      const riderIds = [...new Set(regs.map((r) => r.riderId).filter(Boolean) as number[])];
      if (riderIds.length === 0) return res.json({ count: 0 });

      const riders = await db
        .select({ email: ridersTable.email })
        .from(ridersTable)
        .where(inArray(ridersTable.id, riderIds));

      const emails = [...new Set(
        riders.map((r) => r.email?.toLowerCase()).filter((e): e is string => !!e)
      )];

      if (emails.length === 0) return res.json({ count: 0 });

      const accounts = await db
        .select({ id: riderAccountsTable.id })
        .from(riderAccountsTable)
        .where(inArray(riderAccountsTable.email, emails));

      accountIds = accounts.map((a) => a.id);
    }
    // accountIds remains null → super admin broadcast-all: count all distinct account holders
  }

  // Count DISTINCT riderAccountId — a rider with multiple devices is counted once
  const [result] =
    accountIds !== null
      ? await db
          .select({ count: countDistinct(riderPushTokensTable.riderAccountId) })
          .from(riderPushTokensTable)
          .where(inArray(riderPushTokensTable.riderAccountId, accountIds))
      : await db
          .select({ count: countDistinct(riderPushTokensTable.riderAccountId) })
          .from(riderPushTokensTable);

  return res.json({ count: result?.count ?? 0 });
});

// GET /admin/notifications/push-stats
// Returns global total (super admin) or club-scoped count for organizers.
router.get("/admin/notifications/push-stats", async (req, res) => {
  const userId = (req.session as any).userId;
  if (!userId) return res.status(401).json({ error: "Not authenticated" });

  const [callingUser] = await db
    .select({ role: usersTable.role, clubId: usersTable.clubId })
    .from(usersTable)
    .where(eq(usersTable.id, userId));

  if (!callingUser) return res.status(401).json({ error: "Not authenticated" });

  const isSuperAdmin = callingUser.role === "super_admin";

  // Global total
  const [totalResult] = await db
    .select({ count: countDistinct(riderPushTokensTable.riderAccountId) })
    .from(riderPushTokensTable);
  const total = totalResult?.count ?? 0;

  // Club-scoped count: distinct rider accounts that have a push token AND registered for this club's events
  let clubCount: number | null = null;
  if (!isSuperAdmin && callingUser.clubId) {
    const clubEvents = await db
      .select({ id: eventsTable.id })
      .from(eventsTable)
      .where(eq(eventsTable.clubId, callingUser.clubId));
    const eventIds = clubEvents.map((e) => e.id);

    if (eventIds.length > 0) {
      const regs = await db
        .select({ riderId: registrationsTable.riderId })
        .from(registrationsTable)
        .where(inArray(registrationsTable.eventId, eventIds));
      const riderIds = [...new Set(regs.map((r) => r.riderId).filter(Boolean) as number[])];

      if (riderIds.length > 0) {
        const riders = await db
          .select({ email: ridersTable.email })
          .from(ridersTable)
          .where(inArray(ridersTable.id, riderIds));
        const emails = [...new Set(riders.map((r) => r.email?.toLowerCase()).filter((e): e is string => !!e))];

        if (emails.length > 0) {
          const accounts = await db
            .select({ id: riderAccountsTable.id })
            .from(riderAccountsTable)
            .where(inArray(riderAccountsTable.email, emails));
          const accountIds = accounts.map((a) => a.id);

          if (accountIds.length > 0) {
            const [clubResult] = await db
              .select({ count: countDistinct(riderPushTokensTable.riderAccountId) })
              .from(riderPushTokensTable)
              .where(inArray(riderPushTokensTable.riderAccountId, accountIds));
            clubCount = clubResult?.count ?? 0;
          } else {
            clubCount = 0;
          }
        } else {
          clubCount = 0;
        }
      } else {
        clubCount = 0;
      }
    } else {
      clubCount = 0;
    }
  }

  return res.json({ total, clubCount });
});

// GET /admin/notifications/history
// Returns the last 10 notification sends for the organizer's club.
router.get("/admin/notifications/history", async (req, res) => {
  const userId = (req.session as any).userId;
  if (!userId) return res.status(401).json({ error: "Not authenticated" });

  const [callingUser] = await db
    .select({ role: usersTable.role, clubId: usersTable.clubId })
    .from(usersTable)
    .where(eq(usersTable.id, userId));

  if (!callingUser) return res.status(401).json({ error: "Not authenticated" });

  const isSuperAdmin = callingUser.role === "super_admin";

  let rows;
  if (isSuperAdmin) {
    rows = await db
      .select({
        id: notificationLogsTable.id,
        title: notificationLogsTable.title,
        body: notificationLogsTable.body,
        audienceType: notificationLogsTable.audienceType,
        eventId: notificationLogsTable.eventId,
        sentCount: notificationLogsTable.sentCount,
        sentAt: notificationLogsTable.sentAt,
      })
      .from(notificationLogsTable)
      .orderBy(desc(notificationLogsTable.sentAt))
      .limit(10);
  } else {
    if (!callingUser.clubId) {
      return res.status(403).json({ error: "No club associated with your account" });
    }
    rows = await db
      .select({
        id: notificationLogsTable.id,
        title: notificationLogsTable.title,
        body: notificationLogsTable.body,
        audienceType: notificationLogsTable.audienceType,
        eventId: notificationLogsTable.eventId,
        sentCount: notificationLogsTable.sentCount,
        sentAt: notificationLogsTable.sentAt,
      })
      .from(notificationLogsTable)
      .where(eq(notificationLogsTable.clubId, callingUser.clubId))
      .orderBy(desc(notificationLogsTable.sentAt))
      .limit(10);
  }

  return res.json(rows.map((r) => ({
    ...r,
    sentAt: r.sentAt.toISOString(),
  })));
});

export default router;
