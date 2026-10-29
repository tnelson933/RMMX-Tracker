import { Router } from "express";
import { db } from "@workspace/db";
import {
  riderPushTokensTable,
  registrationsTable,
  eventsTable,
  usersTable,
  riderNotificationPrefsTable,
  notificationLogsTable,
} from "@workspace/db";
import { eq, inArray, and, count, countDistinct, desc, ne } from "drizzle-orm";
import { sendPushNotifications } from "../lib/push";
import { accountIdsForRiders } from "../lib/riderAccess";

const router = Router();

type Caller = { role: string; clubId: number | null };

type ResolvedAudience = {
  /** Accounts to reach (owners + invited managers); null = every account with a token (super-admin global). */
  accountIds: number[] | null;
  /** Club whose opt-outs apply; null = none (super-admin global send). */
  optOutClubId: number | null;
  /** Club recorded on the notification log. */
  logClubId: number | null;
  audienceType: "all" | "all_global" | "event";
  eventId: number | null;
};
type Audience = { error: { status: number; message: string } } | ResolvedAudience;

/**
 * The one audience resolver used by the send, the preview count and push-stats, so
 * they can't drift: riders with a non-void entry (one event, or all the club's events),
 * mapped to owner and invited-manager accounts via accountIdsForRiders.
 */
async function resolveAudience(caller: Caller, eventId: number | null): Promise<Audience> {
  const isSuperAdmin = caller.role === "super_admin";
  if (!isSuperAdmin && !caller.clubId) {
    return { error: { status: 403, message: "No club associated with your account" } };
  }

  if (eventId) {
    const [event] = await db
      .select({ id: eventsTable.id, clubId: eventsTable.clubId })
      .from(eventsTable)
      .where(eq(eventsTable.id, eventId));
    if (!event) return { error: { status: 404, message: "Event not found" } };
    if (!isSuperAdmin && event.clubId !== caller.clubId) {
      return { error: { status: 403, message: "Event does not belong to your club" } };
    }
    const regs = await db
      .select({ riderId: registrationsTable.riderId })
      .from(registrationsTable)
      .where(and(eq(registrationsTable.eventId, eventId), ne(registrationsTable.status, "void")));
    const riderIds = [...new Set(regs.map((r) => r.riderId).filter(Boolean) as number[])];
    return {
      accountIds: await accountIdsForRiders(riderIds),
      optOutClubId: event.clubId ?? null,
      // Logged under the event's club (also for super admins).
      logClubId: event.clubId ?? null,
      audienceType: "event",
      eventId,
    };
  }

  if (isSuperAdmin) {
    // Super admin with no event: every account with a token (no club opt-outs apply).
    return { accountIds: null, optOutClubId: null, logClubId: caller.clubId ?? null, audienceType: "all_global", eventId: null };
  }

  const clubId = caller.clubId!;
  const clubEvents = await db.select({ id: eventsTable.id }).from(eventsTable).where(eq(eventsTable.clubId, clubId));
  const eventIds = clubEvents.map((e) => e.id);
  let riderIds: number[] = [];
  if (eventIds.length > 0) {
    const regs = await db
      .select({ riderId: registrationsTable.riderId })
      .from(registrationsTable)
      .where(and(inArray(registrationsTable.eventId, eventIds), ne(registrationsTable.status, "void")));
    riderIds = [...new Set(regs.map((r) => r.riderId).filter(Boolean) as number[])];
  }
  return {
    accountIds: await accountIdsForRiders(riderIds),
    optOutClubId: clubId,
    logClubId: clubId,
    audienceType: "all",
    eventId: null,
  };
}

/** Push tokens for a resolved audience, minus accounts that opted out of the club's notifications. */
async function tokensForAudience(
  audience: ResolvedAudience,
): Promise<{ riderAccountId: number; expoPushToken: string }[]> {
  if (audience.accountIds !== null && audience.accountIds.length === 0) return [];
  let rows = audience.accountIds !== null
    ? await db
        .select({ riderAccountId: riderPushTokensTable.riderAccountId, expoPushToken: riderPushTokensTable.expoPushToken })
        .from(riderPushTokensTable)
        .where(inArray(riderPushTokensTable.riderAccountId, audience.accountIds))
    : await db
        .select({ riderAccountId: riderPushTokensTable.riderAccountId, expoPushToken: riderPushTokensTable.expoPushToken })
        .from(riderPushTokensTable);
  if (audience.optOutClubId !== null && rows.length > 0) {
    const optOuts = await db
      .select({ riderAccountId: riderNotificationPrefsTable.riderAccountId })
      .from(riderNotificationPrefsTable)
      .where(and(
        eq(riderNotificationPrefsTable.clubId, audience.optOutClubId),
        eq(riderNotificationPrefsTable.enabled, false),
      ));
    const optedOut = new Set(optOuts.map((o) => o.riderAccountId));
    if (optedOut.size > 0) rows = rows.filter((r) => !optedOut.has(r.riderAccountId));
  }
  return rows;
}

function countAudience(rows: { riderAccountId: number }[]): { accounts: number; devices: number } {
  return { accounts: new Set(rows.map((r) => r.riderAccountId)).size, devices: rows.length };
}

// Idempotency for manual broadcasts: the page sends a fresh requestId per click;
// a repeat of the same id within the window gets the first response back instead
// of a second send. In-memory, so it covers one API instance.
const IDEMPOTENCY_WINDOW_MS = 10 * 60 * 1000;
type RecentBroadcast = { at: number; pending: true } | { at: number; pending: false; status: number; body: Record<string, unknown> };
const recentBroadcasts = new Map<string, RecentBroadcast>();

function pruneRecentBroadcasts(now: number) {
  for (const [k, v] of recentBroadcasts) if (now - v.at > IDEMPOTENCY_WINDOW_MS) recentBroadcasts.delete(k);
}

// POST /admin/notifications/broadcast
// Organizer-scoped: no timing window, no rate limit.
// When eventId is absent or null, sends to all riders registered across any event in the organizer's club.
// When eventId is provided, sends only to riders registered for that event.
// Super admins bypass club scoping (use /broadcast-all for unrestricted sends).
// Optional requestId (client-generated per click) makes a repeated request a no-op.
router.post("/admin/notifications/broadcast", async (req, res) => {
  const userId = (req.session as any).userId;
  if (!userId) return res.status(401).json({ error: "Not authenticated" });

  const [callingUser] = await db
    .select({ role: usersTable.role, clubId: usersTable.clubId })
    .from(usersTable)
    .where(eq(usersTable.id, userId));

  if (!callingUser) return res.status(401).json({ error: "Not authenticated" });

  const { title, body, eventId, requestId } = req.body as {
    title?: string;
    body?: string;
    eventId?: number | null;
    requestId?: string;
  };

  if (!title?.trim() || !body?.trim()) {
    return res.status(400).json({ error: "title and body are required" });
  }
  if (eventId != null && (!Number.isInteger(eventId) || eventId <= 0)) {
    return res.status(400).json({ error: "eventId must be a positive integer" });
  }
  if (requestId != null && (typeof requestId !== "string" || requestId.length === 0 || requestId.length > 100)) {
    return res.status(400).json({ error: "requestId must be a string of 1-100 characters" });
  }

  const now = Date.now();
  pruneRecentBroadcasts(now);
  const idemKey = requestId ? `${userId}:${requestId}` : null;
  if (idemKey) {
    const prior = recentBroadcasts.get(idemKey);
    if (prior?.pending) {
      return res.status(409).json({ error: "This notification is already being sent" });
    }
    if (prior) return res.status(prior.status).json({ ...prior.body, duplicate: true });
    recentBroadcasts.set(idemKey, { at: now, pending: true });
  }

  // Remember the response for this requestId; a request that sent nothing is forgotten so it can be retried.
  const respond = (status: number, payload: Record<string, unknown>, remember = true) => {
    if (idemKey) {
      if (remember) recentBroadcasts.set(idemKey, { at: Date.now(), pending: false, status, body: payload });
      else recentBroadcasts.delete(idemKey);
    }
    return res.status(status).json(payload);
  };

  try {
    const audience = await resolveAudience(callingUser, eventId ?? null);
    if ("error" in audience) {
      return respond(audience.error.status, { error: audience.error.message }, false);
    }

    const pushRows = await tokensForAudience(audience);
    const { accounts, devices } = countAudience(pushRows);
    const logRow = {
      clubId: audience.logClubId,
      userId,
      title: title.trim(),
      body: body.trim(),
      audienceType: audience.audienceType,
      eventId: audience.eventId,
    };

    if (pushRows.length === 0) {
      // Nobody to reach (no riders, no app installs, or everyone opted out): still logged.
      await db.insert(notificationLogsTable).values({ ...logRow, sentCount: 0 });
      return respond(200, { ok: true, sent: 0, accounts: 0, devices: 0, failed: 0 });
    }

    const result = await sendPushNotifications(
      pushRows.map((r) => ({
        to: r.expoPushToken,
        title: title.trim(),
        body: body.trim(),
      })),
    );

    const okTokens = new Set(result.results.filter((r) => r.ok).map((r) => r.to));
    const acceptedAccounts = new Set(
      pushRows.filter((r) => okTokens.has(r.expoPushToken)).map((r) => r.riderAccountId),
    ).size;

    // notification_logs has no status column: sentCount records the devices the push service accepted.
    await db.insert(notificationLogsTable).values({ ...logRow, sentCount: result.accepted });

    if (result.accepted === 0) {
      return respond(502, {
        error: "The push service did not accept any of these notifications. Nothing was delivered; try again.",
        sent: 0, accounts: 0, devices: 0, failed: result.failed,
        attemptedAccounts: accounts, attemptedDevices: devices,
      }, false);
    }

    return respond(200, {
      ok: result.failed === 0,
      partial: result.failed > 0,
      sent: result.accepted,
      accounts: acceptedAccounts,
      devices: result.accepted,
      failed: result.failed,
      attemptedAccounts: accounts,
      attemptedDevices: devices,
    });
  } catch (err) {
    if (idemKey) recentBroadcasts.delete(idemKey);
    throw err;
  }
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

  const result = await sendPushNotifications(
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
    sentCount: result.accepted,
  });

  if (result.accepted === 0) {
    return res.status(502).json({ error: "The push service did not accept any of these notifications.", sent: 0, failed: result.failed });
  }
  return res.json({ ok: result.failed === 0, partial: result.failed > 0, sent: result.accepted, failed: result.failed });
});

// GET /admin/notifications/audience-count
// Recipients the send would reach, using the send's own resolver:
// accounts = distinct rider accounts (owners + invited managers, minus club opt-outs)
// with at least one device; devices = push tokens. `count` mirrors `accounts`.
router.get("/admin/notifications/audience-count", async (req, res) => {
  const userId = (req.session as any).userId;
  if (!userId) return res.status(401).json({ error: "Not authenticated" });

  const [callingUser] = await db
    .select({ role: usersTable.role, clubId: usersTable.clubId })
    .from(usersTable)
    .where(eq(usersTable.id, userId));

  if (!callingUser) return res.status(401).json({ error: "Not authenticated" });

  const audienceParam = req.query.audience as string | undefined;
  if (audienceParam !== "all" && audienceParam !== "event") {
    return res.status(400).json({ error: "audience must be 'all' or 'event'" });
  }

  let eventId: number | null = null;
  if (audienceParam === "event") {
    const eventIdRaw = req.query.eventId as string | undefined;
    if (!eventIdRaw || !/^\d+$/.test(eventIdRaw.trim()) || parseInt(eventIdRaw, 10) <= 0) {
      return res.status(400).json({ error: "eventId must be a positive integer when audience is 'event'" });
    }
    eventId = parseInt(eventIdRaw, 10);
  }

  const audience = await resolveAudience(callingUser, eventId);
  if ("error" in audience) return res.status(audience.error.status).json({ error: audience.error.message });

  const { accounts, devices } = countAudience(await tokensForAudience(audience));
  return res.json({ count: accounts, accounts, devices });
});

// GET /admin/notifications/push-stats
// total/totalDevices: every rider account/device with the app (global).
// clubCount/clubDevices (organizers and staff): the club's "all riders" audience, same resolver as the send.
router.get("/admin/notifications/push-stats", async (req, res) => {
  const userId = (req.session as any).userId;
  if (!userId) return res.status(401).json({ error: "Not authenticated" });

  const [callingUser] = await db
    .select({ role: usersTable.role, clubId: usersTable.clubId })
    .from(usersTable)
    .where(eq(usersTable.id, userId));

  if (!callingUser) return res.status(401).json({ error: "Not authenticated" });

  const isSuperAdmin = callingUser.role === "super_admin";

  const [totalResult] = await db
    .select({ accounts: countDistinct(riderPushTokensTable.riderAccountId), devices: count() })
    .from(riderPushTokensTable);
  const total = Number(totalResult?.accounts ?? 0);
  const totalDevices = Number(totalResult?.devices ?? 0);

  let clubCount: number | null = null;
  let clubDevices: number | null = null;
  if (!isSuperAdmin && callingUser.clubId) {
    const audience = await resolveAudience(callingUser, null);
    if (!("error" in audience)) {
      const c = countAudience(await tokensForAudience(audience));
      clubCount = c.accounts;
      clubDevices = c.devices;
    }
  }

  return res.json({ total, totalDevices, clubCount, clubDevices });
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
